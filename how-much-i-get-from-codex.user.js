// ==UserScript==
// @name         How Much I Get From Codex
// @name:zh-CN   How Much I Get From Codex · 你从 Codex 到底拿到多少
// @namespace    https://github.com/bigbobro
// @version      4.1.2
// @homepageURL  https://github.com/bigbobro/how-much-i-get-from-codex
// @supportURL   https://github.com/bigbobro/how-much-i-get-from-codex/issues
// @downloadURL  https://github.com/bigbobro/how-much-i-get-from-codex/raw/main/how-much-i-get-from-codex.user.js
// @updateURL    https://github.com/bigbobro/how-much-i-get-from-codex/raw/main/how-much-i-get-from-codex.user.js
// @description  Work out the Codex spending ceiling OpenAI never tells you. Exact per-model pricing from the official rate card, a short-window readout, a weekly correction, and a time-based projection of what is left before your subscription renews. Reads nothing until you open it.
// @description:zh-CN 算出 OpenAI 从不告诉你的那个数字。按官方 rate card 逐模型计价，同时读取 5 小时窗口、用 7 天额度校正，再按时间推算到订阅续费日前还能拿到多少。不点开就不发任何请求。
// @match        https://chatgpt.com/*
// @author       bigbobro
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * How it works
 * ────────────
 * OpenAI never publishes how much API spend a subscription is worth. The API hands you
 * two halves that never sit next to each other:
 *
 *   /wham/usage                       → percentages for the short and weekly windows
 *   /wham/usage/daily-…-breakdown     → per-model token counts, but no money
 *
 * Put them together:
 *   credits the API reports (or tokens × rate card) = spend        exact
 *   weekly spend ÷ weekly used percent              = the weekly ceiling  inferred
 *
 * Reported credits win wherever they exist — they are what OpenAI actually charged. The
 * current rate card prices days without them. When a reported total contains an unknown
 * model, the known rows keep their priced amounts and the remainder stays explicitly
 * unattributed instead of being hidden in those rows. Everything downstream of a window
 * percentage division is an estimate, and the interface says so — solid blue is measured,
 * dashed amber is inferred.
 *
 * Nothing is requested until you open the panel. No background polling.
 */

(function () {
  "use strict";

  if (window.__howMuchIGet) return;
  window.__howMuchIGet = true;

  // ── Rate card ───────────────────────────────────────────────────────────
  // Credits per 1M tokens: [uncached input, cached input, output]. Verified against
  // https://learn.chatgpt.com/docs/pricing on this date. gpt-image-2 uses the text-token
  // row because these analytics fields are explicitly text input/output tokens.
  const RATE_CARD_VERIFIED = "2026-08-10";
  const RATE_CARD = {
    "gpt-5.6-sol": [125, 12.5, 750],
    "gpt-5.6-terra": [50, 5, 300],
    "gpt-5.6-luna": [5, 0.5, 30],
    "gpt-5.5": [125, 12.5, 750],
    "gpt-5.4": [62.5, 6.25, 375],
    "gpt-5.4-mini": [18.75, 1.875, 113],
    "gpt-image-2": [125, 31.25, 250],
  };

  // Retained only so historical analytics rows do not disappear when a model leaves the
  // current card. The UI calls these rows out instead of presenting them as current prices.
  const LEGACY_RATE_CARD = {
    "gpt-5.5-cyber": [500, 50, 3000],
    "gpt-5.3-codex": [43.75, 4.375, 350],
    "gpt-5.2": [43.75, 4.375, 350],
  };

  /*
   * Fast mode burns credits faster. https://learn.chatgpt.com/docs/agent-configuration/speed
   * Only these multipliers are published. Matching by exact model, not by prefix: a prefix
   * match would quietly hand gpt-5.4-mini the gpt-5.4 multiplier and gpt-5.5-cyber the
   * gpt-5.5 one, neither of which is documented. Anything else that runs fast is priced at
   * the standard rate and called out in the notes rather than guessed at.
   */
  const FAST_MULTIPLIER = {
    "gpt-5.6-sol": 2.5,
    "gpt-5.6-terra": 2.5,
    "gpt-5.6-luna": 2.5,
    "gpt-5.5": 2.5,
    "gpt-5.4": 2,
  };

  // Usage only ever arrives in whole UTC days, so a window shorter than this cannot be
  // measured against it — the day bucket would swamp the window.
  const MIN_INFERABLE_WINDOW_SEC = 2 * 86400;
  const WEEKLY_WINDOW_TARGET_SEC = 7 * 86400;
  const WEEKLY_WINDOW_TOLERANCE_SEC = 3 * 86400;

  /*
   * Spend ÷ used% is only a measurement while both sides describe the same stretch of time.
   * The used percentage is live to the second; the numerator is built from whole UTC days and
   * stops wherever the analytics feed stops. So the honest question is not "how much did this
   * window spend" but "how many whole days inside it has the feed actually settled".
   *
   * A day nobody worked and a day the feed has not reached both arrive as no row at all, which
   * is why this counts days rather than rows: inside the freshness horizon an empty day is a
   * measured zero, and past it nothing is measured however busy the account was.
   */
  const MIN_MEASURED_DAYS = 1;

  // OpenAI has never published this rate. It comes from the credit purchase page.
  const USD_PER_CREDIT = 0.04;
  // Keep in lockstep with @version. GM_info wins when the host injects it, so the
  // panel shows the installed copy rather than whatever this source last said.
  const SCRIPT_VERSION = "4.1.2";

  const DAY_MS = 86400000;
  const LANG_KEY = "hmig-lang";
  const COST_KEY = "hmig-monthly-cost";
  const SUBSCRIPTION_CHOICE_KEY = "hmig-subscription-choice";
  // Closed usage windows, bucketed per login identity × subscription seat.
  const MEMORY_KEY = "hmig-cycle-memory";
  const MEMORY_KEEP = 8;
  // startAt can jitter by a few seconds across fetches; treat nearby stamps as one window.
  const WINDOW_MATCH_MS = 5 * 60 * 1000;

  // ── Copy ────────────────────────────────────────────────────────────────

  const I18N = {
    en: {
      brand: "How much I get",
      title: "How Much I Get",
      from: "from Codex",
      window: (plan, days) => `${plan} · ${days}-day usage window`,
      windowHours: (plan, hours) => `${plan} · ${hours}-hour usage window`,

      windowStatusTitle: "Rate-limit windows",
      windowStatusHint: (hasShort, hasWeekly) =>
        hasShort && hasWeekly
          ? "The 5-hour percentage is the short-term signal; the 7-day percentage corrects the weekly and subscription estimate."
          : hasWeekly
            ? "The 7-day percentage is the weekly signal used for the subscription estimate."
            : "The percentage below belongs to the rate-limit window returned for this account.",
      shortWindowLabel: "5-hour window",
      weeklyWindowLabel: "7-day quota",
      remainingPercent: (p) => `${p}% remaining`,
      usedPercent: (p) => `${p}% used`,
      resetAtLabel: (d) => `resets ${d}`,
      shortWindowEstimate: "Dollar amount withheld: usage is reported by whole day, not by five-hour window.",
      weeklyCorrection: (source, total, used, left) =>
        `7-day correction · ${source} · ${total} total · ${used} used · ${left} left`,
      subscriptionFormula: (spent, left, total, extras, windows, weekly) =>
        `Subscription capacity = spent ${spent} + ${windows} ${weekly ? "weekly window" + (windows === 1 ? "" : "s") : "allowance" + (windows === 1 ? "" : "s")} still available ${left}${extras ? ` + ${extras}` : ""} = ${total}.`,

      cycle: "This usage window",
      cycleWeekly: "Current week",
      period: "This subscription",

      spent: "Spent",
      ceiling: "Ceiling",
      measured: "Measured",
      inferred: "Inferred",
      noCeiling: (p) => `${p}% used — not enough yet to infer a ceiling`,
      twoSubscriptions: (n, plan) => `This login holds ${n} active subscriptions. Every figure here belongs to the ${plan} one, whichever the Codex API answers for. That is not always the account the profile menu names.`,
      ambiguousSubscription: (n, structure) =>
        `This login has ${n} active ${structure} subscriptions, and the Codex API does not say which one owns this usage. Choose its renewal date before billing-period figures are shown.`,
      chooseSubscription: "Which subscription owns this Codex usage?",
      chooseSubscriptionHint:
        "Match the renewal date shown in your subscription settings. The choice stays only in this browser and can be changed later.",
      chooseRenewal: (d) => `Renews ${d}`,
      chosenRenewal: (d) => `Using the subscription that renews ${d}`,
      changeSubscription: "Change",
      renewalUnavailable: "Subscription period unavailable",
      renewalUnavailableHint:
        "The renewal date could not be read, so no calendar month has been substituted. Reload to try again.",
      measuredFrom: (n) => `read off ${n} day${n === 1 ? "" : "s"} of usage`,
      measuredAtDepletion: "read off the point the limit closed",
      measuredFromPrevious: "read off the last complete window",
      weeklyFromPrevious:
        "Taken from the last complete window of the same length. This week's own spend is not divided into its live percentage: the two do not cover the same stretch of time.",
      weeklyThin:
        "No dollar figure for this week yet. There is no current spend-and-percentage pair, and no immediately previous complete week to use as an anchor.",
      todayMissing: "The usage feed has not reported today yet. Live percentages include it; every dollar figure here stops before it.",
      depletedShort: (d) =>
        `The short window is used up — the API refuses further use until ${d}. That is not the 7-day quota, which is measured separately.`,
      allowanceConflict: (daily, window) =>
        `Daily usage measures this allowance as ${daily}, while the live window percentage implies ${window}. The measured daily value wins; the mismatch is left visible for diagnosis.`,
      weeklyAllowanceConflict: (daily, window) =>
        `The live weekly window percentage implies ${window}, while daily usage measures ${daily}. The weekly value wins for the weekly and subscription figures; the mismatch is left visible for diagnosis.`,
      allowanceConflictStale: (daily, window) =>
        `The limit closed at ${window}, yet the daily percentages claim a ${daily} allowance. Their denominator is stale — seen live when a plan moved from a monthly to a weekly allowance and the daily endpoint kept dividing by the old figure. The depletion point wins.`,
      allowanceDepletionNote:
        "How the allowance is read here: the limit is reached, so what was spent when it closed is one whole allowance. This is the only reading that does not depend on the daily percentages.",
      depleted: (d) => `Allowance exhausted — the API refuses further use. Resets ${d}.`,
      depletedCredits: (d) => `This seat's credits are exhausted — the API refuses further use. Resets ${d}.`,
      overspent: (n) => `${n} allowances used in this usage window, so it reset partway through. "Left" below means what remains of the current one.`,
      overspentWeekly: (n) => `${n} allowances used this week, so it reset partway through. "Left" below means what remains of the current one.`,
      allowanceChanged: (n) => `${n} earlier day${n === 1 ? "" : "s"} imply a different allowance, so the plan changed in this range. Only days matching today are counted.`,
      topRateWarning: "Some days have no per-model split and no reported credits, so they are priced at the dearest model's rate. Those days read high.",
      placeholderWindow: "This plan does not run the rate limit window: used percent stays at 0 and the reset time slides along with the clock. The boundaries are not real, so the cycle view and anything counted off it are hidden. The allowance and the spending still hold.",
      allowanceNote: (n) => `How the allowance is read: each day's cost, divided by the percentage of the allowance the API says that day used. All ${n} day${n === 1 ? "" : "s"} here point at the same value.`,
      windowTooShort: "This account's short window is under a day, and usage only arrives in whole days — there is nothing to divide into a dollar ceiling.",
      leftSuffix: (p) => `left (${p})`,
      windowSpan: (a, b) => `${a} → ${b}`,
      resetInPre: "resets in",
      resetInPost: "days",

      untilRenewal: "Left before renewal",
      renewalOn: (d) => `renews ${d}`,
      renewalMath: (a, n, l, partial) =>
        `${a} left in this usage window, then ${n} more allowance${n > 1 ? "s" : ""} of about ${l}` +
        (partial ? " — a window hands over the whole amount even with days left to spend it" : ""),
      renewalMathWeekly: (a, n, l, partial) =>
        `${a} left in the current week, then ${n} more allowance${n > 1 ? "s" : ""} of about ${l}` +
        (partial ? " — a window hands over the whole amount even with days left to spend it" : ""),
      renewalOneCycle: (a) => `${a} left — the subscription renews before this usage window does`,
      renewalOneCycleWeekly: (a) => `${a} left — the subscription renews before the current week does`,

      plusBank: (n, a) => `${n} reset card${n === 1 ? "" : "s"} unspent, worth ${a} more if you use them.`,
      bankEmpty: "No reset cards left, so nothing can be opened ahead of schedule.",
      plusCredits: (a) => `purchased credit balance ${a} still available after the plan pool`,
      creditsBalance: (a) => `credit balance ${a}`,
      creditsUnlimited: "purchased credits are marked unlimited on this account",
      resetCardsUsed: (n, a) => `${n} reset card${n === 1 ? "" : "s"} used this billing period, about ${a} of extra allowance`,
      resetCardsAvail: (n, a) => `${n} reset card${n === 1 ? "" : "s"} left, about ${a}`,
      narrWindows: (n, resets, one) => `About ${n} usage windows this period: one already open when it began, then ${resets} more roll${resets === 1 ? "" : "s"} — a floor, since early resets only add. Each estimated at today's ${one}; past windows may have been larger, so do not multiply older spend by it.`,
      periodNoReset: "one usage window — it did not roll inside the billing period",
      periodCardSpent: "spent this billing period",
      periodCardOne: "one allowance now",
      periodCardOneSub: "this usage window only — not the whole period average",
      periodCardOneWeekly: "current weekly allowance",
      periodCardOneSubWeekly: "the 7-day allowance used for the weekly correction — not a period average",
      periodCardLeft: "still obtainable before renewal",
      periodCardLeftSub: "at today's allowance size — a ceiling on grants, not a spend forecast",
      remainingStack: "What you can still draw before renewal",
      remainingStackSub: "future layers use today's one-allowance size",
      remainingStackSubWeekly: "future layers use today's weekly allowance size",
      remWindow: "left in this usage window",
      remWindowWeekly: "left in the current week",
      remNatural: "more windows before renewal",
      remCards: "unused reset cards",
      remCredits: "purchased credit balance",
      timelineNow: "now",
      timelineAhead: "ahead (est.)",
      timelineRemembered: "saved",
      timelineInferred: "past window",
      timelineSpill: "spans period start · in-period part only",
      winTableTitle: "Window by window",
      winTableSub: "each row is a usage window's measured spend — not calendar months",
      winTableTotal: "listed windows total",
      thWinKind: "Kind",
      thWinCeil: "This window size",
      chartComposite: "Spend by usage window",
      chartCompositeSub: "bars = dollars in each window; line = cumulative spend this billing period",
      chartBarPast: "past window spend",
      chartBarNow: "this window",
      chartLineSpend: "cumulative $",
      renewalUnknown: "Needs a ceiling before it can project",
      narrCap: (cap, spent, left) => `The period tops out at ${cap}: ${spent} already spent (measured) plus ${left} still to open (inferred).`,
      projWindowOnly: "Projection uses the current allowance and the windows that open before renewal; it does not extend a daily average.",
      projEarly: "Less than a fifth of the period has gone; this is a coarse extrapolation",
      projNoWindow: "What the period costs depends on how many allowances open before renewal, and this plan does not report its window boundaries, so it cannot be worked out. The spend and the allowance count below are measured.",
      projNotYet: "No current allowance is available to project the period",
      projPayback: (x) => `${x}× projected for the period`,
      chartDaily: "Spend per day",
      chartDailySub: (r) => `dashed line is ${r} per completed calendar day · descriptive only`,
      chartModel: "Where the money goes by model",
      chartSurface: "Where the money goes by surface",
      chartSurfaceSub: "split by the API's surface shares, not by token count",
      chartSurfaceSubTurns: "no surface shares from the API — split by each surface's share of turns",
      unattributed: "Unattributed",
      seeNumbers: "See the numbers",
      ledgerBadge: "Daily · Models",
      subTabDaily: "Daily Breakdown",
      subTabModels: "Model Split",
      today: "today",
      partialDay: "today is still filling — this bar will grow",

      cycles: "Usage window by window",
      cyclesWeekly: "Weekly allowance by allowance",
      cyclesSub: "remembered rows are local; inferred rows assume a fixed window length and can drift after an early reset",
      cyclesSubWeekly: "remembered rows are local; inferred rows assume a fixed weekly length and can drift after an early reset",
      thWhen: "Window",
      thSpend: "Spend",
      cycleNow: "now",
      cycleRemembered: "remembered",
      cycleInferred: "inferred",
      cycleSuspect: "spend looks like more than one allowance",
      cycleSuspectInferred:
        "spend exceeds one of today's allowances — a real mid-window reset, or an older slice cut to today's window length after the plan's window changed; the two cannot be told apart",
      cycleSuspectInferredWeekly:
        "spend exceeds one of today's weekly allowances — a real mid-window reset, or an older slice cut to today's window length after the plan's window changed; the two cannot be told apart",
      cycleRegimeChanged: (a, b) => `recorded under a ${a}-day window — today's runs ${b} days, so the rows are not comparable`,
      cycleCeilingChanged: (from, to) => `Allowance changed since the last remembered window: ${from} → ${to}`,
      cycleMemLocal:
        "Usage-window history for this subscription is stored only in this browser. It is not uploaded. Clearing site data or switching browsers drops it.",
      cycleMemClear: "Clear local history for this subscription",
      cycleMemClearConfirm:
        "Clear the remembered usage windows for this subscription on this browser? This cannot be undone.",
      cycleMemEmpty: "No local history yet — each finished usage window is saved here when a new one opens.",
      gaugeAria: (a, b, isMeasured) => `spent ${a} of ${isMeasured ? "a measured" : "an inferred"} ${b} ceiling`,

      payback: "Payback",
      paybackPaidLead: "paid",
      paybackUsedTail: (got) => `, used ${got}`,
      setCost: "What do you pay a month?",
      costPlaceholder: "e.g. 30",

      periodSpan: (a, b) => `${a} → ${b}`,
      periodWhy:
        "Measured over the real billing period rather than the calendar month. The allowance resets on its own clock, so only the billing period answers what one payment buys.",
      activeDays: "Days with usage",
      dailyAvg: "Average on completed days (descriptive)",
      turnsTotal: (n) => `${n} turns`,

      cTotal: "Total",
      cPerTurn: "Per turn",
      cPerKLoc: "Per 1000 lines added",
      cPriciestDay: "Priciest day",
      cPriciestTurnDay: "Dearest turns",
      cTopModel: "Biggest spender",
      cTopSurface: "Biggest surface",
      cTopTurnModel: "Dearest per turn",
      cCacheRate: "Cache hit rate",
      cFast: "Fast mode",
      subTurns: (t, s) => `${t} turn${t === "1" ? "" : "s"} · ${s} session${s === "1" ? "" : "s"}`,
      subShare: (s) => `${s} of total`,
      subOfInput: (a, b) => `${a} of ${b} input tokens`,
      subLoc: (a, r) => `+${a} / −${r} lines`,

      whereItWent: "Where it went",
      whereSub: "split by credits, not by token count",
      uncachedIn: "Uncached input",
      cachedIn: "Cached input",
      outputTok: "Output",

      byDay: "By day",
      byModel: "By model",
      surfaceCli: "CLI",
      surfaceVscode: "VS Code",
      surfaceWeb: "Web",
      surfaceGithub: "GitHub",
      surfaceIos: "iOS",
      surfaceSlack: "Slack",
      surfaceUnknown: "Unknown",

      thDate: "Date",
      thCost: "Cost",
      thCredits: "Credits",
      thTurns: "Turns",
      thPerTurn: "Per turn",
      thTokens: "Tokens",
      thCache: "Cached",
      thModel: "Model",
      thShare: "Share",
      thLoc: "Lines",

      emptyCycle: "Nothing spent in this usage window yet.",
      emptyCycleWeekly: "Nothing spent in the current week yet.",
      emptyPeriod: "Nothing spent this period yet.",
      emptyHint: "Try the other view.",
      loading: "Reading usage data…",
      noToken: "Could not get an access token. Sign in to ChatGPT and reload the page.",
      noWindow: "The API returned no rate limit window, so the usage-window range is unknown.",

      notesTitle: "What is measured and what is inferred",
      n1: (d) => `Cost is the credits OpenAI itself reports, wherever the API returns them. Days without reported credits are priced from per-model token counts × the official rate card verified ${d}. The cached/uncached/output split follows that card's shape, scaled to the reported total when every model is priced.`,
      nLegacy: (m) => `Historical models use their retained legacy rate rather than the current card: ${m}`,
      nTurnSplit: "When a model ran both standard and fast, its turns are split between the two rows by credit share — so a row's turns can be fractional, and per-turn figures use the unrounded split.",
      n2: (r) => `Credits convert at 1 credit = $${r} (1000 credits = $40). OpenAI has never published this rate — change USD_PER_CREDIT at the top of the script if yours differs.`,
      n3: "The ceiling is inferred: spend ÷ the used percentage the API reports. The more you have used, the tighter it gets.",
      n3Weekly: "The weekly ceiling is inferred from weekly spend ÷ the 7-day used percentage. The 5-hour percentage is shown separately and is not mixed into that denominator.",
      n4: (t, d, a) => `The usage window opened at ${t}, but usage only arrives in whole UTC days. The ${d} row counts that entire day — ${a} — and some of it was spent before the window opened. How much cannot be known, but it pushes both the spend and the ceiling high.`,
      n4Weekly: (t, d, a) => `The current week opened at ${t}, but usage only arrives in whole UTC days. The ${d} row counts that entire day — ${a} — and some of it was spent before the week opened. How much cannot be known, but it pushes both the spend and the ceiling high.`,
      n10: (m) => `Fast mode has no published multiplier for ${m}, so it is priced at the standard rate — the real cost is higher.`,
      n11: "The 5-hour percentage is a short-term signal. Usage is only reported by whole days, so no dollar ceiling is inferred from it.",
      n5: "Codex, ChatGPT Work and ChatGPT for Excel draw on the same pool, but this API only sees Codex — so the spend, and the ceiling, come out low.",
      n6: "Scoped to the current seat only. Other people in the workspace are not counted.",
      n7: (m) => `Not in the rate card, so its tokens are not priced: ${m}. Any reported remainder stays visible as Unattributed.`,
      n8: "There is no per-repository breakdown in the API, so spend cannot be split by project.",
      nSurfaceTurns: "The API did not give per-surface credit shares, so this split uses each surface's share of turns.",
      n9: "Nothing is requested until you open this panel, and nothing runs in the background after you close it.",

      reload: "Reload",
      close: "Close",
      openPanel: "Work out what I get",
    },

    zh: {
      brand: "我到底拿到多少",
      title: "我到底拿到多少",
      from: "Codex 额度",
      window: (plan, days) => `${plan} · ${days} 天用量窗口`,
      windowHours: (plan, hours) => `${plan} · ${hours} 小时用量窗口`,

      windowStatusTitle: "额度窗口",
      windowStatusHint: (hasShort, hasWeekly) =>
        hasShort && hasWeekly
          ? "5 小时百分比用于短期余量；7 天百分比用于周额度校正和本期订阅推算。"
          : hasWeekly
            ? "7 天百分比用于周额度校正和本期订阅推算。"
            : "下面的百分比属于接口为这个账号返回的限流窗口。",
      shortWindowLabel: "5 小时窗口",
      weeklyWindowLabel: "7 天额度",
      remainingPercent: (p) => `剩余 ${p}%`,
      usedPercent: (p) => `已用 ${p}%`,
      resetAtLabel: (d) => `${d} 重置`,
      shortWindowEstimate: "暂不换算美元：接口用整天上报用量，无法把花费准确切到 5 小时窗口。",
      weeklyCorrection: (source, total, used, left) =>
        `7 天额度校正 · ${source} · 总额度 ${total} · 已用 ${used} · 剩余 ${left}`,
      subscriptionFormula: (spent, left, total, extras, windows, weekly) =>
        `本期订阅可花额度 = 已花 ${spent} + 剩余 ${windows}${weekly ? " 个周窗口" : " 份额度"}未花 ${left}${extras ? ` + ${extras}` : ""} = ${total}。`,

      cycle: "当前用量窗口",
      cycleWeekly: "当前周用量",
      period: "本期订阅",

      spent: "已花",
      ceiling: "额度",
      measured: "实测",
      inferred: "推算",
      noCeiling: (p) => `已用 ${p}%，还不够反推额度`,
      twoSubscriptions: (n, plan) => `这个登录下有 ${n} 份有效订阅。这里的数字都属于 ${plan} 这一份，也就是 Codex 接口当前回答的那份。它跟档案菜单显示的账号常常不是同一个。`,
      ambiguousSubscription: (n, structure) =>
        `这个登录下有 ${n} 份有效的${structure === "workspace" ? "工作区" : "个人"}订阅，而 Codex 接口没说这份用量属于哪一个。选定续费日之后，才显示真实账期数字。`,
      chooseSubscription: "这份 Codex 用量属于哪一份订阅？",
      chooseSubscriptionHint: "对照订阅设置里的续费日选择。结果只存在这台浏览器里，之后可以更改。",
      chooseRenewal: (d) => `${d} 续费`,
      chosenRenewal: (d) => `当前按 ${d} 续费的订阅统计`,
      changeSubscription: "更改",
      renewalUnavailable: "暂时无法计算本期订阅",
      renewalUnavailableHint: "接口没有返回续费日，所以这里不会拿自然月代替。可以重新读取再试。",
      measuredFrom: (n) => `由 ${n} 天用量测出`,
      measuredAtDepletion: "由封停点测出",
      measuredFromPrevious: "由上一个完整窗口测出",
      weeklyFromPrevious:
        "取自上一个同样长度的完整窗口。本周自己的花费不拿去除实时百分比：两者覆盖的时间段对不齐。",
      weeklyThin:
        "本周暂不给美元数。当前还没有能配对的周花费和实时百分比，前一个完整周也没有可借用的额度。",
      todayMissing: "用量接口还没上报今天。实时百分比含今天，但这里所有美元数字都停在今天之前。",
      depletedShort: (d) =>
        `短窗口已用尽，接口在 ${d} 之前拒绝继续使用。这跟 7 天额度是两回事，7 天额度在下面单独测。`,
      allowanceConflict: (daily, window) =>
        `每日用量测出的额度是 ${daily}，实时窗口百分比反推的是 ${window}。这里采用每日实测值，同时保留差异供排查。`,
      weeklyAllowanceConflict: (daily, window) =>
        `实时周窗口百分比反推的是 ${window}，每日用量测出的是 ${daily}。周窗口的数用于周额度和本期推算，差异照样保留供排查。`,
      allowanceConflictStale: (daily, window) =>
        `额度在花到 ${window} 时就被封停，但每日百分比接口声称一份额度有 ${daily}。它的分母过期了 —— 实测出现过：套餐从月度额度换成周度额度后，每日接口还在按旧月度数做除法。这里以封停点为准。`,
      allowanceDepletionNote:
        "额度这么读出来：已经封停，封停时花掉的就是一整份额度。这是唯一不经过每日百分比的读数。",
      depleted: (d) => `额度已耗尽，接口已拒绝继续使用。${d} 重置。`,
      depletedCredits: (d) => `这个席位的 credits 已耗尽，接口已拒绝继续使用。${d} 重置。`,
      overspent: (n) => `当前用量窗口已经用掉 ${n} 份额度，说明窗口中途重置过。下面的「未用」是指当前这一份还剩多少。`,
      overspentWeekly: (n) => `当前周用量已经用掉 ${n} 份额度，说明周窗口中途重置过。下面的「未用」是指当前这一份还剩多少。`,
      allowanceChanged: (n) => `另外 ${n} 天推出来的额度跟今天不一样，说明这段时间里换过套餐。只采用与今天一致的那些天。`,
      topRateWarning: "有些天既没有按模型的拆分，接口也没给 credits，只能按最贵的模型计价，这些天会偏高。",
      placeholderWindow: "这个套餐不走限流窗口：已用百分比一直是 0%，重置时间跟着当前时间往前滑。边界不是真的，所以周期视图和据此数出来的份数都已隐藏。额度和花费照常。",
      allowanceNote: (n) => `额度这么读出来：拿每天的花费，除以接口给的「这天用掉额度的百分之几」。这里 ${n} 天的数据都指向同一个值。`,
      windowTooShort: "这个账号的短窗口不到一天，而用量只能按整天取 —— 没有可除的东西，所以不换算美元额度。",
      leftSuffix: (p) => `未用（${p}）`,
      windowSpan: (a, b) => `${a} → ${b}`,
      resetInPre: "还有",
      resetInPost: "天重置",

      untilRenewal: "续费前还能拿",
      renewalOn: (d) => `${d} 续费`,
      renewalMath: (a, n, l, partial) =>
        `当前用量窗口还剩 ${a}，之后还会开出 ${n} 份额度，每份约 ${l}` +
        (partial ? " —— 窗口一开就是满额发放，哪怕只剩几天用" : ""),
      renewalMathWeekly: (a, n, l, partial) =>
        `当前周用量还剩 ${a}，之后还会开出 ${n} 份额度，每份约 ${l}` +
        (partial ? " —— 窗口一开就是满额发放，哪怕只剩几天用" : ""),
      renewalOneCycle: (a) => `当前用量窗口还剩 ${a} —— 订阅比窗口重置先到`,
      renewalOneCycleWeekly: (a) => `当前周用量还剩 ${a} —— 订阅比周重置先到`,

      plusBank: (n, a) => `另外还有 ${n} 张重置券没用，用掉相当于再多 ${a}。`,
      bankEmpty: "重置券用完了，没法再提前开新额度。",
      plusCredits: (a) => `账户里还有已购 credit 余额 ${a}，套餐池用完后仍可花`,
      creditsBalance: (a) => `credit 余额 ${a}`,
      creditsUnlimited: "这个账号的已购 credit 标记为不限量",
      resetCardsUsed: (n, a) => `本账期已用掉 ${n} 张重置券，约等于多开 ${a} 额度`,
      resetCardsAvail: (n, a) => `重置券还剩 ${n} 张，约 ${a}`,
      narrWindows: (n, resets, one) => `这一期共约 ${n} 份额度：期初已开着 1 份，之后再滚 ${resets} 次；次数是下限，提前 reset 只会更多。每份按今天的 ${one} 估 —— 过去的窗可能更大，别拿它去乘历史花费。`,
      periodNoReset: "一个用量窗口 —— 账期内没有再滚",
      periodCardSpent: "本期已花",
      periodCardOne: "当前一份额度",
      periodCardOneSub: "只描述当前用量窗口，不是整期平均",
      periodCardOneWeekly: "当前周额度",
      periodCardOneSubWeekly: "用于 7 天额度校正，不是整期平均",
      periodCardLeft: "续费前还能拿",
      periodCardLeftSub: "按今天的一份大小估 —— 是能拿的上限，不是会花的预测",
      remainingStack: "续费前还能动用的",
      remainingStackSub: "后面几层按当前一份额度大小估算",
      remainingStackSubWeekly: "后面几层按当前 7 天额度大小估算",
      remWindow: "当前用量窗口剩余",
      remWindowWeekly: "当前周用量窗口剩余",
      remNatural: "续费前还会自然开的窗口",
      remCards: "未用重置券",
      remCredits: "已购 credit 余额",
      timelineNow: "现在",
      timelineAhead: "往后（估）",
      timelineRemembered: "本地记录",
      timelineInferred: "已过窗口",
      timelineSpill: "跨期 · 只计账期内",
      winTableTitle: "一窗口一窗口比",
      winTableSub: "每一行是该用量窗口里测到的花费，不是自然月",
      winTableTotal: "已列窗口合计",
      thWinKind: "类型",
      thWinCeil: "该窗额度",
      chartComposite: "按用量窗口看花费",
      chartCompositeSub: "柱 = 每个窗口花了多少美元；线 = 本账期累计花费",
      chartBarPast: "已过窗口花费",
      chartBarNow: "当前窗口",
      chartLineSpend: "累计 $",
      renewalUnknown: "要先推算出额度才能往后推",
      narrCap: (cap, spent, left) => `整期最多到 ${cap}：已花掉的 ${spent} 是实测，续费前还能开出的 ${left} 是推算。`,
      projWindowOnly: "按当前额度、当前窗口剩余和续费前会开的窗口推算，不按日均往后外推。",
      projEarly: "账期才过了不到两成，这个外推还很粗",
      projNoWindow: "整期花多少，取决于续费前会开出几份额度；而这个套餐不报窗口边界，所以算不出来。下面的花费和份数都是实测的。",
      projNotYet: "还没有可用于本期推算的当前额度",
      projPayback: (x) => `整期预计 ${x}×`,
      chartDaily: "每天花了多少",
      chartDailySub: (r) => `虚线是已完成日均 ${r}，仅作描述`,
      chartModel: "钱花在哪个模型上",
      chartSurface: "钱花在哪个入口上",
      chartSurfaceSub: "按接口给的入口份额拆，不是按 token 数",
      chartSurfaceSubTurns: "接口没给入口份额 —— 按各入口的 turns 占比拆",
      ledgerBadge: "按日 · 模型",
      subTabDaily: "每日流水",
      subTabModels: "模型分账",
      unattributed: "未归因",
      seeNumbers: "看具体数字",
      today: "今天",
      partialDay: "今天还没走完，这一天的数还在涨",

      cycles: "按用量窗口一份份看",
      cyclesWeekly: "按周额度一份份看",
      cyclesSub: "「本地记录」存在本机；「推算」按固定窗口长度往回切，中途 reset 后可能偏",
      cyclesSubWeekly: "「本地记录」存在本机；「推算」按固定周窗口往回切，中途 reset 后可能偏",
      thWhen: "窗口",
      thSpend: "花费",
      cycleNow: "现在",
      cycleRemembered: "本地记录",
      cycleInferred: "推算",
      cycleSuspect: "花费像不止一份额度",
      cycleSuspectInferred:
        "花费超过今天的一份额度 —— 可能真在窗口中途重置过，也可能这段历史早于窗口换档、按现在的长度切片不可比，两者无法区分",
      cycleSuspectInferredWeekly:
        "花费超过今天的一份周额度 —— 可能真在窗口中途重置过，也可能这段历史早于窗口换档、按现在的长度切片不可比，两者无法区分",
      cycleRegimeChanged: (a, b) => `记录时窗口是 ${a} 天，现在是 ${b} 天，两行不可比`,
      cycleCeilingChanged: (from, to) => `相对上一份本地记录，额度变了：${from} → ${to}`,
      cycleMemLocal:
        "这份订阅的用量窗口历史只保存在你这台浏览器本地，不会上传。清除网站数据或换浏览器后会丢失。",
      cycleMemClear: "清除本订阅的本地记录",
      cycleMemClearConfirm: "清除本浏览器里这份订阅的用量窗口记录？清除后无法恢复。",
      cycleMemEmpty: "还没有本地记录 —— 等新的用量窗口打开时，会把刚结束的那一份记在这里。",
      gaugeAria: (a, b, isMeasured) => `已花 ${a}，${isMeasured ? "实测" : "推算"}额度 ${b}`,

      payback: "回本",
      paybackPaidLead: "付了",
      paybackUsedTail: (got) => `，用掉 ${got}`,
      setCost: "你一个月付多少？",
      costPlaceholder: "比如 30",

      periodSpan: (a, b) => `${a} → ${b}`,
      periodWhy:
        "按真实账期算，不按自然月。额度按自己的时钟重置，所以要问一次付费买到了什么，只能按账期算。",
      activeDays: "有用量的天数",
      dailyAvg: "已完成日均（仅描述）",
      turnsTotal: (n) => `共 ${n} turns`,

      cTotal: "总花费",
      cPerTurn: "平均每 turn",
      cPerKLoc: "每千行新增代码",
      cPriciestDay: "花得最多的一天",
      cPriciestTurnDay: "单 turn 最贵的一天",
      cTopModel: "最烧钱的模型",
      cTopSurface: "最烧钱的入口",
      cTopTurnModel: "单 turn 最贵的模型",
      cCacheRate: "缓存命中率",
      cFast: "Fast mode",
      subTurns: (t, s) => `${t} turns · ${s} 个会话`,
      subShare: (s) => `占 ${s}`,
      subOfInput: (a, b) => `${a} / ${b} 输入 token`,
      subLoc: (a, r) => `新增 ${a} / 删除 ${r} 行`,

      whereItWent: "钱花在哪",
      whereSub: "按 credits 拆，不是按 token 数",
      uncachedIn: "未缓存输入",
      cachedIn: "缓存输入",
      outputTok: "输出",

      byDay: "每日明细",
      byModel: "按模型",
      surfaceCli: "CLI",
      surfaceVscode: "VS Code",
      surfaceWeb: "网页",
      surfaceGithub: "GitHub",
      surfaceIos: "iOS",
      surfaceSlack: "Slack",
      surfaceUnknown: "未知",

      thDate: "日期",
      thCost: "花费",
      thCredits: "credits",
      thTurns: "turns",
      thPerTurn: "每 turn",
      thTokens: "tokens",
      thCache: "缓存",
      thModel: "模型",
      thShare: "占比",
      thLoc: "代码行",

      emptyCycle: "当前用量窗口还没花钱。",
      emptyCycleWeekly: "当前周用量还没花钱。",
      emptyPeriod: "这一期订阅还没花钱。",
      emptyHint: "换另一个视图看看。",
      loading: "正在读用量数据…",
      noToken: "拿不到访问令牌。登录 ChatGPT 后刷新页面再试。",
      noWindow: "接口没返回限流窗口，确定不了用量窗口的范围。",

      notesTitle: "哪些是实测，哪些是推算",
      n1: (d) => `花费优先取 OpenAI 自己返回的 credits 记账值；接口没给 credits 的天，才按每模型 token 数 × ${d} 核对过的官方 rate card 估。所有模型都能计价时，缓存 / 未缓存 / 输出的拆分按 rate card 的结构对齐到记账总额。`,
      nLegacy: (m) => `历史模型沿用保留的旧 rate，不把它冒充成当前 rate card：${m}`,
      nTurnSplit: "同一个模型同时跑了标准和 fast 时，turns 按两行的花费份额拆开 —— 所以单行的 turns 可能是小数，「每 turn」用拆分前的精确值算。",
      n2: (r) => `credits 换美元按 1 credit = $${r}（1000 credits = $40）。这个汇率 OpenAI 从没公布过 —— 你那边不一样就改脚本顶部的 USD_PER_CREDIT。`,
      n3: "额度是推算的：花费 ÷ 接口给的已用百分比。用得越多，推得越准。",
      n3Weekly: "周额度按「当前周花费 ÷ 接口给的 7 天已用百分比」推算。5 小时百分比单独展示，不混进这个分母。",
      n4: (t, d, a) => `用量窗口是 ${t} 开始的，但用量只能按整个 UTC 天取。${d} 这一行算的是一整天（${a}），其中一部分花在窗口开始之前。具体多少无从得知，但它会把花费和推算额度一起抬高。`,
      n4Weekly: (t, d, a) => `当前周窗口是 ${t} 开始的，但用量只能按整个 UTC 天取。${d} 这一行算的是一整天（${a}），其中一部分花在周窗口开始之前。具体多少无从得知，但它会把花费和推算额度一起抬高。`,
      n10: (m) => `${m} 的 fast mode 没有公布倍率，这里按标准价计，实际花费只会更高。`,
      n11: "5 小时百分比只作短期状态。用量只按整天上报，所以不从它反推美元额度。",
      n5: "Codex、ChatGPT Work、ChatGPT for Excel 共用一个额度池，但这个接口只看得到 Codex —— 所以花费偏低，推算额度也跟着偏低。",
      n6: "只统计当前 seat，不含 workspace 里其他人。",
      n7: (m) => `不在 rate card 里，token 没法计价：${m}。接口报出的剩余花费仍会显示为「未归因」。`,
      n8: "接口没有按仓库拆的维度，所以分不出「哪个项目花了多少」。",
      nSurfaceTurns: "接口没给按入口的 credit 份额，所以这里按各入口的 turns 占比拆。",
      n9: "不点开就不发任何请求，关掉之后也不会在后台跑。",

      reload: "重新读取",
      close: "关闭",
      openPanel: "算算我拿到多少",
    },
  };

  const savedLang = localStorage.getItem(LANG_KEY);
  let lang = savedLang || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
  const t = () => I18N[lang];
  const scriptVersion = () => {
    try {
      if (typeof GM_info !== "undefined" && GM_info?.script?.version) return GM_info.script.version;
    } catch {
      /* GM_info is host-provided; a throw must not blank the panel. */
    }
    return SCRIPT_VERSION;
  };
  const modelName = (name) => (name === "__unattributed__" ? t().unattributed : name);
  const surfaceName = (key) => {
    const L = t();
    const labels = {
      cli: L.surfaceCli,
      vscode: L.surfaceVscode,
      web: L.surfaceWeb,
      github: L.surfaceGithub,
      ios: L.surfaceIos,
      slack: L.surfaceSlack,
      unknown: L.surfaceUnknown,
    };
    return labels[key] || key;
  };

  function clientToSurface(id) {
    const raw = String(id || "").trim();
    const known = {
      CODEX_CLI: "cli",
      CODEX_VSCODE: "vscode",
      CODEX_IDE: "vscode",
      CODEX_WEB: "web",
      CODEX_CLOUD: "web",
      CODEX_GITHUB: "github",
      CODEX_IOS: "ios",
      CODEX_APP: "ios",
      CODEX_SLACK: "slack",
    };
    if (known[raw]) return known[raw];
    const s = raw.toLowerCase();
    if (s.includes("cli")) return "cli";
    if (s.includes("vscode") || s.includes("vs_code") || s.includes("vs-code") || s.includes("ide")) return "vscode";
    if (s.includes("github")) return "github";
    if (s.includes("slack")) return "slack";
    if (s.includes("ios") || s.includes("iphone")) return "ios";
    if (s.includes("web") || s.includes("cloud")) return "web";
    return s || "unknown";
  }

  /*
   * Spend by surface. Credit shares from daily-token-usage-breakdown win when present;
   * otherwise the day's already-measured credits are split by each client's turn count.
   * The second path is labelled, because turn share is not a price.
   */
  function allocateSurfaces(dayCredits, percentParts, clients) {
    const turnsBySurface = new Map();
    for (const client of clients || []) {
      const key = clientToSurface(client.client_id);
      turnsBySurface.set(key, (turnsBySurface.get(key) || 0) + (Number(client.turns) || 0));
    }

    const shares = (percentParts || [])
      .map(([key, value]) => [clientToSurface(key), Number(value)])
      .filter(([, value]) => value > 0);
    const merged = new Map();
    for (const [key, value] of shares) merged.set(key, (merged.get(key) || 0) + value);
    const shareTotal = [...merged.values()].reduce((sum, value) => sum + value, 0);
    if (shareTotal > 0 && dayCredits > 0) {
      return {
        source: "percent",
        rows: [...merged.entries()].map(([key, value]) => ({
          key,
          credits: dayCredits * (value / shareTotal),
          turns: turnsBySurface.get(key) || 0,
        })),
      };
    }

    const turnTotal = [...turnsBySurface.values()].reduce((sum, n) => sum + n, 0);
    if (turnTotal > 0 && dayCredits > 0) {
      return {
        source: "turns",
        rows: [...turnsBySurface.entries()].map(([key, turns]) => ({
          key,
          credits: dayCredits * (turns / turnTotal),
          turns,
        })),
      };
    }

    return { source: "", rows: [] };
  }

  // ── Formatting ──────────────────────────────────────────────────────────

  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const usd = (c) => "$" + (c * USD_PER_CREDIT).toFixed(2);
  const int = (v) => Math.round(v).toLocaleString("en-US");
  // Model turns are split between speed rows by credit share, so they can be fractional.
  // Rounding them away would leave spend ÷ turns unable to reproduce the per-turn column.
  const turnCount = (v) =>
    v > 0 && v < 0.5 ? "<1" : Math.abs(v - Math.round(v)) >= 0.05 ? v.toFixed(1) : int(v);
  const pct = (x) => (x * 100).toFixed(1) + "%";

  const tokenCount = (v) => {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(Math.round(v));
  };

  // Usage is bucketed by UTC day, so all date maths stays in UTC.
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const dayMs = (key) => Date.parse(key + "T00:00:00Z");
  const addDays = (key, n) => dayKey(dayMs(key) + n * DAY_MS);
  const shortDate = (key) => (lang === "zh" ? key.slice(5).replace("-", "/") : key.slice(5));

  const clock = (ms) =>
    new Date(ms).toLocaleString(lang === "zh" ? "zh-CN" : "en-GB", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const dateOnly = (ms) =>
    new Date(ms).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-GB", { month: "short", day: "numeric" });

  // ── Pricing ─────────────────────────────────────────────────────────────

  function priceOf(entry) {
    const legacy = !RATE_CARD[entry.model] && !!LEGACY_RATE_CARD[entry.model];
    const rate = RATE_CARD[entry.model] || LEGACY_RATE_CARD[entry.model];
    if (!rate) return { unknown: true, unpricedFast: false, credits: 0, uncached: 0, cached: 0, output: 0 };

    const isFast = !!entry.speed && entry.speed !== "standard";
    const mult = isFast ? FAST_MULTIPLIER[entry.model] || 1 : 1;

    const uncached = ((entry.uncached_text_input_tokens || 0) / 1e6) * rate[0] * mult;
    const cached = ((entry.cached_text_input_tokens || 0) / 1e6) * rate[1] * mult;
    const output = ((entry.text_output_tokens || 0) / 1e6) * rate[2] * mult;

    return {
      unknown: false,
      legacy,
      unpricedFast: isFast && !FAST_MULTIPLIER[entry.model],
      credits: uncached + cached + output,
      uncached,
      cached,
      output,
    };
  }

  // ── API ─────────────────────────────────────────────────────────────────

  function getToken() {
    const boot = document.getElementById("client-bootstrap")?.textContent || "";
    const jwt = boot.match(/eyJ[\w-]*\.[\w-]+\.[\w-]+/g);
    if (jwt) return Promise.resolve(jwt[0]);

    return fetch("/api/auth/session", { credentials: "include" })
      .then((r) => r.json())
      .then((s) => s?.accessToken || s?.access_token || null)
      .catch(() => null);
  }

  async function api(path, token) {
    const res = await fetch(path, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path.split("?")[0]} → ${res.status} ${text.slice(0, 120)}`);
    return JSON.parse(text);
  }

  // Optional extras: a failure here costs a section, not the whole panel.
  const soft = (path, token) => api(path, token).catch(() => null);

  // With no usage yet, reset_at is just "now + window length" — the cycle has not opened.
  function readWindow(usage) {
    const rate = usage?.rate_limit;
    if (!rate || typeof rate !== "object") return null;

    const timestampMs = (raw) => {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
      const parsed = Date.parse(String(raw || ""));
      return Number.isFinite(parsed) ? parsed : 0;
    };

    /*
     * Allowances arrive from two places, and both are readable, which is what makes the
     * forecast something other than a guess. One is the window rolling on its own fixed
     * schedule. The other is a reset card, spent by hand to open a fresh allowance early —
     * the reason a week can hold far more than one. The bank says exactly how many are left.
     */
    const bank =
      Number(usage?.rate_limit_reset_credits?.available_count) ||
      Number(usage?.rate_limit_reset_credits?.applicable_available_count) ||
      0;

    const globalReached = !!rate.limit_reached;
    const reachedType = usage?.rate_limit_reached_type?.type || "";
    const windows = Object.entries(rate)
      .filter(([key, value]) => /window$/i.test(key) && value && typeof value === "object")
      .map(([key, w]) => {
        const windowSec = Number(w.limit_window_seconds || w.window_seconds || w.reset_after_seconds);
        const resetAfter = Number(w.reset_after_seconds);
        const resetAt = timestampMs(w.reset_at) || (Number.isFinite(resetAfter) ? Date.now() + resetAfter * 1000 : 0);
        if (!Number.isFinite(windowSec) || windowSec <= 0 || !Number.isFinite(resetAt) || resetAt <= 0) return null;
        const usedRaw = Number(w.used_percent);
        const hasUsedPercent = Number.isFinite(usedRaw);
        const usedPercent = Math.min(100, Math.max(0, hasUsedPercent ? usedRaw : 0));
        return {
          key: key.replace(/_window$/i, ""),
          usedPercent,
          hasUsedPercent,
          limitReached: !!w.limit_reached,
          reachedType,
          windowSec,
          inferable: windowSec >= MIN_INFERABLE_WINDOW_SEC,
          /*
           * Some plans never open the window at all: used_percent stays at zero and reset_at
           * is simply now plus the window length, sliding forward on every request.
           */
          placeholder:
            !(usedPercent > 0) && Math.abs(resetAt - (Date.now() + windowSec * 1000)) < 90000,
          resetAt,
          startAt: resetAt - windowSec * 1000,
          resetBank: bank,
          planType: usage.plan_type,
          email: usage.email || "",
          accountId: usage.account_id || "",
        };
      })
      .filter(Boolean);

    if (!windows.length) return null;

    // limit_reached is global on some responses. Attach it to the window actually at 100%;
    // a 5-hour exhaustion must not mark the weekly window depleted as well.
    const reachedIndex = windows.findIndex((w) => w.usedPercent >= 99.5);
    windows.forEach((w, index) => {
      w.limitReached =
        w.limitReached ||
        (globalReached && (index === reachedIndex || (reachedIndex < 0 && windows.length === 1)));
    });

    const shortWindow = [...windows].filter((w) => w.windowSec < MIN_INFERABLE_WINDOW_SEC).sort((a, b) => a.windowSec - b.windowSec)[0] || null;
    const weeklyWindow =
      [...windows]
        .filter((w) => Math.abs(w.windowSec - WEEKLY_WINDOW_TARGET_SEC) <= WEEKLY_WINDOW_TOLERANCE_SEC)
        .sort((a, b) => Math.abs(a.windowSec - WEEKLY_WINDOW_TARGET_SEC) - Math.abs(b.windowSec - WEEKLY_WINDOW_TARGET_SEC))[0] || null;
    const main =
      weeklyWindow ||
      [...windows].filter((w) => w.inferable).sort((a, b) => b.windowSec - a.windowSec)[0] ||
      shortWindow ||
      windows[0];

    main.kind = weeklyWindow === main ? "weekly" : shortWindow === main ? "short" : "long";
    return {
      ...main,
      windows,
      shortWindow,
      weeklyWindow,
      primaryWindow: windows.find((w) => w.key === "primary") || null,
      secondaryWindow: windows.find((w) => w.key === "secondary") || null,
      rateLimitReached: globalReached,
      reachedType,
    };
  }

  /*
   * Purchased credit balance sits beside the plan pool. When the included allowance is
   * exhausted, spend can continue against this balance — so "what is left" is incomplete
   * without it. 1 credit = USD_PER_CREDIT, same as the rate-card conversion.
   */
  function readPurchasedCredits(usage) {
    const c = usage?.credits;
    if (!c) return { balance: 0, hasCredits: false, unlimited: false };
    if (c.unlimited) return { balance: 0, hasCredits: true, unlimited: true };
    const balance = Number(c.balance);
    const n = Number.isFinite(balance) && balance > 0 ? balance : 0;
    return {
      balance: n,
      hasCredits: !!c.has_credits || n > 0,
      unlimited: false,
    };
  }

  /*
   * Reset cards: each spent card opens one full allowance early inside the billing period.
   * usage only reports how many are still available; the detail endpoint lists status and
   * timestamps so we can also count cards used inside the current payment window.
   */
  const USED_RESET_STATUSES = new Set(["used", "redeemed", "spent", "consumed", "applied", "claimed"]);

  function parseResetCredits(detail, fallbackAvailable, rangeStartMs, rangeEndMs) {
    const availableFromUsage = Math.max(0, Number(fallbackAvailable) || 0);
    const rows = Array.isArray(detail?.credits)
      ? detail.credits
      : Array.isArray(detail?.data)
        ? detail.data
        : [];

    let available = Number(detail?.available_count ?? detail?.applicable_available_count);
    if (!Number.isFinite(available)) available = availableFromUsage;

    const start = Number.isFinite(rangeStartMs) ? rangeStartMs : 0;
    const end = Number.isFinite(rangeEndMs) ? rangeEndMs : Date.now();
    let usedInPeriod = 0;

    for (const row of rows) {
      const status = String(row?.status || row?.state || "").toLowerCase();
      const granted = Date.parse(row?.granted_at || row?.created_at || "") || 0;
      const usedAt =
        Date.parse(row?.used_at || row?.redeemed_at || row?.consumed_at || row?.applied_at || "") || 0;

      const isUsed = USED_RESET_STATUSES.has(status);
      if (!isUsed) continue;

      const when = usedAt || granted;
      if (when >= start && when <= end) usedInPeriod++;
    }

    return {
      available: Math.max(0, available || 0),
      usedInPeriod,
      listed: rows.length,
    };
  }

  // The renewal date lives on the account entitlement, not on any Codex endpoint.
  /*
   * One person can hold several subscriptions at once — a personal Plus and a workspace seat
   * renew on different days. Taking whichever comes first out of the object would report the
   * wrong renewal date roughly half the time, so match the account the session is actually
   * using: a personal plan for a personal plan_type, a workspace one otherwise.
   */
  function readEntitlement(check, planType, selectedAccountId = "") {
    const wanted = planType === "plus" || planType === "pro" || planType === "free" ? "personal" : "workspace";

    const live = Object.entries(check?.accounts || {})
      .filter(([, a]) => a?.entitlement?.has_active_subscription && a.entitlement.renews_at)
      .map(([key, a]) => ({
        accountId: a.account?.account_id || key,
        structure: a.account?.structure || "",
        renewsAt: Date.parse(a.entitlement.renews_at),
        billingPeriod: a.entitlement.billing_period,
      }))
      .filter((a) => Number.isFinite(a.renewsAt));

    if (!live.length) return null;

    const matching = live.filter((a) => a.structure === wanted);
    const candidates = matching.length ? matching : live.length === 1 ? live : [];
    const selected = candidates.find((a) => a.accountId === selectedAccountId);
    const samePeriod = new Set(candidates.map((a) => `${a.renewsAt}|${a.billingPeriod || "monthly"}`)).size === 1;
    const pick = selected || (candidates.length === 1 || samePeriod ? candidates[0] : null);

    /*
     * One login can hold both a personal Plus and a workspace seat. The Codex endpoints
     * answer for whichever context Codex itself is in, and that does not have to agree with
     * the account the profile menu names — a ChatGPT-Account-ID header does not override it.
     * Counting the live subscriptions is what lets the panel warn instead of quietly
     * reporting a different subscription than the reader has in mind.
     */
    const distinct = new Set(live.map((a) => a.accountId).filter(Boolean));
    const common = {
      liveSubscriptions: distinct.size || live.length,
      structure: wanted,
      candidates,
      choiceRequired: candidates.length > 1 && !samePeriod,
    };

    if (!pick) {
      return {
        ...common,
        renewsAt: null,
        billingPeriod: null,
        accountId: "",
        ambiguous: true,
      };
    }

    return {
      ...common,
      renewsAt: pick.renewsAt,
      billingPeriod: pick.billingPeriod,
      accountId: pick.accountId,
      structure: pick.structure,
      ambiguous: false,
    };
  }

  /*
   * Three endpoints, joined on date. Everything is scoped to the current seat —
   * without workspace_user=true the counts come back for the whole workspace while
   * the used percentage stays personal, and the two do not divide.
   */
  const freshnessOf = (payload) => {
    const raw = payload?.data_freshness_ts;
    if (raw == null) return 0;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
    const parsed = Date.parse(String(raw));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  async function fetchAll(token, startKey, endKey) {
    const range = `start_date=${startKey}&end_date=${addDays(endKey, 1)}&group_by=day`;
    const seat = `${range}&workspace_user=true`;
    const A = "/backend-api/wham/analytics/";

    /*
     * daily-workspace-usage-counts is the load-bearing one: it carries day totals, tokens,
     * turns and — on personal plans — the credits OpenAI charged, on every plan type.
     *
     * The workspace breakdown adds a per-model/per-speed token split, but it is scoped to a
     * workspace and answers 400 "No active workspace found" on a personal plan, so it can
     * only ever be optional.
     *
     * daily-token-usage-breakdown reports each day as a percentage of the allowance. That is
     * what makes the allowance measurable rather than inferred, so it is worth its own call.
     */
    const [counts, breakdown, percents, attribution] = await Promise.all([
      api(`${A}daily-workspace-usage-counts?${seat}`, token),
      soft(`/backend-api/wham/usage/daily-workspace-user-token-usage-breakdown?${range}`, token),
      soft(`/backend-api/wham/usage/daily-token-usage-breakdown?${range}`, token),
      soft(`${A}code-attribution?${seat}&group=workspace`, token),
    ]);

    // Sum of the per-surface shares is the day's consumption as a percentage of one allowance.
    const percentByDate = new Map();
    const surfaceByDate = new Map();
    for (const row of percents?.data || []) {
      const values = row.product_surface_usage_values || {};
      const parts = Object.entries(values).filter(([, value]) => Number(value) > 0);
      const pct = parts.reduce((a, [, b]) => a + (Number(b) || 0), 0);
      if (pct > 0) percentByDate.set(row.date, pct);
      if (parts.length) surfaceByDate.set(row.date, parts);
    }
    const modelPercentByDate = new Map((percents?.data || []).map((r) => [r.date, r.models || []]));
    const breakdownByDate = new Map((breakdown?.data || []).map((r) => [r.date, r]));
    const clientsByDate = new Map();
    for (const row of counts?.data || []) {
      if (Array.isArray(row.clients) && row.clients.length) clientsByDate.set(row.date, row.clients);
    }

    const activityByDate = new Map();
    for (const row of counts?.data || []) {
      // models[] mixes two record shapes for the same model name — one carrying tokens,
      // one carrying turns. Accumulate instead of building a Map from pairs, or the
      // token-shaped record overwrites the turn count with nothing.
      const perModel = new Map();
      for (const m of row.models || []) {
        if (m.turns == null) continue;
        perModel.set(m.model, (perModel.get(m.model) || 0) + m.turns);
      }

      activityByDate.set(row.date, {
        turns: row.totals?.turns || 0,
        threads: row.totals?.threads || 0,
        perModel,
      });
    }

    const locByDate = new Map();
    for (const row of attribution?.data || []) {
      const loc = row.code_attribution?.lines_of_code;
      if (loc) locByDate.set(row.date, { added: loc.added || 0, removed: loc.removed || 0 });
    }

    const days = [];
    const unknownModels = new Set();
    const legacyModels = new Set();
    const unpricedFast = new Set();

    for (const countRow of counts.data || []) {
      const row = breakdownByDate.get(countRow.date) || { date: countRow.date, models: [] };
      const totals = countRow.totals || {};
      const activity = activityByDate.get(row.date) || { turns: 0, threads: 0, perModel: new Map() };
      const models = [];
      const day = {
        date: row.date,
        percent: percentByDate.get(row.date) || 0,
        credits: 0,
        uncachedCredits: 0,
        cachedCredits: 0,
        outputCredits: 0,
        uncached: 0,
        cached: 0,
        output: 0,
        fastCredits: 0,
        turns: activity.turns,
        threads: activity.threads,
        loc: locByDate.get(row.date) || { added: 0, removed: 0 },
        models,
        surfaces: [],
        surfaceSource: "",
      };

      const priced = [];
      for (const m of row.models || []) {
        if (!m.text_total_tokens) continue;

        const p = priceOf(m);
        if (p.unknown) unknownModels.add(m.model);
        if (p.legacy) legacyModels.add(m.model);
        if (p.unpricedFast) unpricedFast.add(m.model);
        priced.push({ m, p });

        day.credits += p.credits;
        day.uncachedCredits += p.uncached;
        day.cachedCredits += p.cached;
        day.outputCredits += p.output;
        day.uncached += m.uncached_text_input_tokens || 0;
        day.cached += m.cached_text_input_tokens || 0;
        day.output += m.text_output_tokens || 0;
        if (m.speed && m.speed !== "standard") day.fastCredits += p.credits;
      }

      // A model that ran both standard and fast appears as two rows, but the turn count is
      // reported once per model name. Split those turns by the same credit share the UI says
      // it uses, so both paths produce one reproducible per-turn number.
      const creditsByModel = new Map();
      for (const { m, p } of priced) {
        if (p.credits > 0) creditsByModel.set(m.model, (creditsByModel.get(m.model) || 0) + p.credits);
      }

      for (const { m, p } of priced) {
        if (!(p.credits > 0)) continue;
        const share = p.credits / creditsByModel.get(m.model);
        models.push({
          model: m.model,
          speed: m.speed || "standard",
          credits: p.credits,
          turns: (activity.perModel.get(m.model) || 0) * share,
          tokens: m.text_total_tokens,
        });
      }

      /*
       * Without the workspace breakdown there is no per-model token split, so fall back to
       * the day totals. Credits reported by the API win over anything computed: on personal
       * plans they are what OpenAI actually charged. They read 0 on plans that meter no
       * credits at all, and only then does the rate card stand in.
       */
      if (!priced.length) {
        const totalsPrice = priceOf({
          model: "gpt-5.6-sol",
          speed: "standard",
          uncached_text_input_tokens: totals.uncached_text_input_tokens,
          cached_text_input_tokens: totals.cached_text_input_tokens,
          text_output_tokens: totals.text_output_tokens,
        });
        day.uncached = totals.uncached_text_input_tokens || 0;
        day.cached = totals.cached_text_input_tokens || 0;
        day.output = totals.text_output_tokens || 0;
        const included = Number(totals.credits) || 0;
        const onDemand = Number(totals.on_demand_credits) || 0;
        // on_demand is sometimes a subset of credits, sometimes extra. Only add when it is not
        // already covered by the included total.
        let reported = included;
        if (onDemand > 0 && (!(included > 0) || onDemand > included + 0.01)) reported = included + onDemand;
        day.credits = reported > 0 ? reported : totalsPrice.credits;

        // No per-model tokens were priced, so the day total stands in. Where it came from
        // the rate card rather than the API, sol's rates priced everything and a mini-heavy
        // day is overstated several times over — say so rather than let it pass as fact.
        if (!(reported > 0)) day.pricedAtTopRate = true;

        /*
         * Split the day's money across models using OpenAI's own per-model shares.
         *
         * Turns are reported once per model name, so a model's share of the DAY is the wrong
         * divisor for them — it would shrink every model's turns by its own credit share and
         * hand the per-turn crown to whichever model ran fewest turns. Turns only need
         * splitting between a model's own speed rows.
         */
        const shares = (modelPercentByDate.get(row.date) || []).filter((m) => m.credits);
        const shareTotal = shares.reduce((a, m) => a + m.credits, 0);
        const withinModel = new Map();
        for (const m of shares) withinModel.set(m.model, (withinModel.get(m.model) || 0) + m.credits);

        for (const m of shares) {
          const part = m.credits / shareTotal;
          models.push({
            model: m.model,
            speed: m.speed || "standard",
            credits: day.credits * part,
            turns: (activity.perModel.get(m.model) || 0) * (m.credits / withinModel.get(m.model)),
            tokens: (totals.text_total_tokens || 0) * part,
          });
        }

        const scale = day.credits && totalsPrice.credits ? day.credits / totalsPrice.credits : 1;
        day.uncachedCredits = totalsPrice.uncached * scale;
        day.cachedCredits = totalsPrice.cached * scale;
        day.outputCredits = totalsPrice.output * scale;
      } else if (totals.credits > 0 || totals.on_demand_credits > 0) {
        /*
         * Same preference when the split exists: keep the shape, correct the magnitude.
         * A day whose models are all unknown to the rate card prices at zero, and scaling by
         * a zero denominator turns every field into NaN — which then slips past a `<= 0`
         * guard, because NaN fails every comparison. Take the reported total instead.
         */
        const included = Number(totals.credits) || 0;
        const onDemand = Number(totals.on_demand_credits) || 0;
        let reported = included;
        if (onDemand > 0 && (!(included > 0) || onDemand > included + 0.01)) reported = included + onDemand;
        if (day.credits > 0 && reported > 0) {
          const hasUnknown = priced.some(({ p }) => p.unknown);
          const scale = hasUnknown ? Math.min(1, reported / day.credits) : reported / day.credits;
          for (const k of ["credits", "uncachedCredits", "cachedCredits", "outputCredits", "fastCredits"]) day[k] *= scale;
          for (const m of models) m.credits *= scale;
          day.credits = reported;
        } else if (reported > 0) {
          day.credits = reported;
        }
      }

      if (!(day.credits > 0)) continue;
      const surface = allocateSurfaces(day.credits, surfaceByDate.get(day.date), clientsByDate.get(day.date));
      day.surfaces = surface.rows;
      day.surfaceSource = surface.source;
      const attributed = models.reduce((sum, model) => sum + model.credits, 0);
      const unattributed = day.credits - attributed;
      if (unattributed > 0.01) {
        models.push({
          model: "__unattributed__",
          speed: "standard",
          credits: unattributed,
          turns: Math.max(0, day.turns - models.reduce((sum, model) => sum + model.turns, 0)),
          tokens: Math.max(
            0,
            day.uncached + day.cached + day.output - models.reduce((sum, model) => sum + model.tokens, 0),
          ),
        });
      }
      days.push(day);
    }

    days.sort((a, b) => a.date.localeCompare(b.date));

    return {
      days,
      unknownModels: [...unknownModels],
      legacyModels: [...legacyModels],
      unpricedFast: [...unpricedFast],
      fetchedFrom: startKey,
      /*
       * How far the analytics feed has actually caught up. Without it there is no way to tell
       * a day nobody worked from a day the feed has not reported yet — both simply have no
       * row — and that difference decides whether spend ÷ used% is a measurement or a guess.
       */
      freshnessMs: freshnessOf(breakdown) || freshnessOf(percents) || freshnessOf(counts) || 0,
    };
  }

  // ── Aggregation ─────────────────────────────────────────────────────────

  function summarize(days) {
    const s = {
      credits: 0,
      uncachedCredits: 0,
      cachedCredits: 0,
      outputCredits: 0,
      uncached: 0,
      cached: 0,
      output: 0,
      turns: 0,
      threads: 0,
      fastCredits: 0,
      locAdded: 0,
      locRemoved: 0,
      days: days.length,
      models: new Map(),
      surfaces: new Map(),
      surfaceByPercent: false,
      surfaceByTurns: false,
    };

    for (const d of days) {
      s.credits += d.credits;
      s.uncachedCredits += d.uncachedCredits;
      s.cachedCredits += d.cachedCredits;
      s.outputCredits += d.outputCredits;
      s.uncached += d.uncached;
      s.cached += d.cached;
      s.output += d.output;
      s.turns += d.turns;
      s.threads += d.threads;
      s.fastCredits += d.fastCredits;
      s.locAdded += d.loc.added;
      s.locRemoved += d.loc.removed;

      for (const m of d.models) {
        const key = m.speed === "standard" ? m.model : `${m.model} · fast`;
        const cur = s.models.get(key) || { name: key, credits: 0, turns: 0, tokens: 0 };
        cur.credits += m.credits;
        cur.turns += m.turns;
        cur.tokens += m.tokens;
        s.models.set(key, cur);
      }

      if (d.surfaceSource === "percent") s.surfaceByPercent = true;
      if (d.surfaceSource === "turns") s.surfaceByTurns = true;
      for (const surf of d.surfaces || []) {
        const cur = s.surfaces.get(surf.key) || { name: surf.key, credits: 0, turns: 0 };
        cur.credits += surf.credits;
        cur.turns += surf.turns;
        s.surfaces.set(surf.key, cur);
      }
    }

    return s;
  }

  function statCards(days, s) {
    if (!days.length) return [];
    const L = t();

    const priciestDay = days.reduce((a, b) => (b.credits > a.credits ? b : a));
    const withTurns = days.filter((d) => d.turns > 0);
    const dearestTurnDay = withTurns.length
      ? withTurns.reduce((a, b) => (b.credits / b.turns > a.credits / a.turns ? b : a))
      : null;

    const models = [...s.models.values()].sort((a, b) => b.credits - a.credits);
    const topModel = models[0];
    const topTurnModel = models.filter((m) => m.turns > 0).sort((a, b) => b.credits / b.turns - a.credits / a.turns)[0];

    const cards = [
      { label: L.cTotal, value: usd(s.credits), sub: `${int(s.credits)} credits` },
      {
        label: L.cPerTurn,
        value: s.turns ? usd(s.credits / s.turns) : "—",
        sub: L.subTurns(int(s.turns), int(s.threads)),
      },
    ];

    if (s.locAdded > 0) {
      cards.push({
        label: L.cPerKLoc,
        value: usd((s.credits / s.locAdded) * 1000),
        sub: L.subLoc(int(s.locAdded), int(s.locRemoved)),
      });
    }

    /*
     * Every card below has to earn its place. On a range with a single day of usage they
     * would otherwise all restate the total: priciest day = the total, dearest turns = the
     * average, biggest spender = 100%. A card that repeats its neighbour tells you nothing.
     */
    if (days.length > 1) {
      cards.push({
        label: L.cPriciestDay,
        value: usd(priciestDay.credits),
        sub: `${shortDate(priciestDay.date)} · ${L.subShare(pct(priciestDay.credits / s.credits))}`,
      });
    }

    const avgPerTurn = s.turns ? s.credits / s.turns : 0;
    if (dearestTurnDay && avgPerTurn && dearestTurnDay.credits / dearestTurnDay.turns > avgPerTurn * 1.15) {
      cards.push({
        label: L.cPriciestTurnDay,
        value: usd(dearestTurnDay.credits / dearestTurnDay.turns),
        sub: `${shortDate(dearestTurnDay.date)} · ${turnCount(dearestTurnDay.turns)} turns`,
      });
    }

    if (topModel && s.models.size > 1 && topModel.credits / s.credits < 0.95) {
      cards.push({
        label: L.cTopModel,
        value: usd(topModel.credits),
        sub: `${modelName(topModel.name)} · ${L.subShare(pct(topModel.credits / s.credits))}`,
      });
    }

    const surfaces = [...s.surfaces.values()].sort((a, b) => b.credits - a.credits);
    const topSurface = surfaces[0];
    if (topSurface && s.surfaces.size > 1 && topSurface.credits / s.credits < 0.95) {
      cards.push({
        label: L.cTopSurface,
        value: usd(topSurface.credits),
        sub: `${surfaceName(topSurface.name)} · ${L.subShare(pct(topSurface.credits / s.credits))}`,
      });
    }

    if (topTurnModel && topTurnModel !== topModel && s.models.size > 1) {
      cards.push({
        label: L.cTopTurnModel,
        value: usd(topTurnModel.credits / topTurnModel.turns),
        sub: modelName(topTurnModel.name),
      });
    }

    const inputTokens = s.cached + s.uncached;
    cards.push({
      label: L.cCacheRate,
      value: inputTokens ? pct(s.cached / inputTokens) : "—",
      sub: L.subOfInput(tokenCount(s.cached), tokenCount(inputTokens)),
    });

    if (s.fastCredits > 0) {
      cards.push({ label: L.cFast, value: usd(s.fastCredits), sub: L.subShare(pct(s.fastCredits / s.credits)) });
    }

    return cards;
  }

  // ── State ───────────────────────────────────────────────────────────────

  const state = {
    token: null,
    win: null,
    // `win` is the window used for the main cycle view. When the API exposes both limits it is
    // the weekly window; the short window stays alongside it so the UI never loses that signal.
    ent: null,
    days: [],
    unknownModels: [],
    legacyModels: [],
    unpricedFast: [],
    fetchedFrom: "",
    freshnessMs: 0,
    view: "cycle", // cycle | period
    loaded: false,
    loading: false,
    error: "",
    open: false,
    root: null,
    // Per-subscription usage-window memory (localStorage); null until identity is known.
    memory: null,
    restoreTriggerFocus: false,
    // Purchased credit balance + reset-card ledger for the current seat.
    purchased: { balance: 0, hasCredits: false, unlimited: false },
    resetCards: { available: 0, usedInPeriod: 0, listed: 0 },
  };

  const shortWindow = () => state.win?.shortWindow || (state.win?.kind === "short" ? state.win : null);
  const weeklyWindow = () => state.win?.weeklyWindow || (state.win?.kind === "weekly" ? state.win : null);
  // Copy that says "week" is only truthful when the selected main window is actually 7 days.
  const windowCopy = (key) => {
    const L = t();
    const weeklyKey = `${key}Weekly`;
    return weeklyWindow() && L[weeklyKey] !== undefined ? L[weeklyKey] : L[key];
  };

  /*
   * One browser can hold several logins and several seats. Scoped values use the seat Codex
   * is answering for; when several matching seats make that unknowable, memory is withheld.
   */
  function identityKey() {
    const email = (state.win?.email || "").trim().toLowerCase() || "unknown";
    const accountId = (state.ent?.accountId || "").trim() || state.ent?.structure || "unknown";
    const plan = (state.win?.planType || "unknown").toLowerCase();
    return `${email}|${accountId}|${plan}`;
  }

  function subscriptionChoiceKey() {
    const email = (state.win?.email || "").trim().toLowerCase() || "unknown";
    const plan = (state.win?.planType || "unknown").toLowerCase();
    return `${SUBSCRIPTION_CHOICE_KEY}::${email}|${plan}`;
  }

  function storedSubscriptionChoice() {
    return state.win ? localStorage.getItem(subscriptionChoiceKey()) || "" : "";
  }

  function costKeyForIdentity() {
    return state.win ? `${COST_KEY}::${identityKey()}` : COST_KEY;
  }

  function monthlyCost() {
    if (state.win) {
      const scoped = localStorage.getItem(costKeyForIdentity());
      if (scoped != null && scoped !== "") return Number(scoped) || 0;
    }
    // Pre-2.6.0 single global value — still read so existing entries keep working.
    return Number(localStorage.getItem(COST_KEY)) || 0;
  }

  function setMonthlyCost(value) {
    const n = Number(value) || 0;
    if (state.win) localStorage.setItem(costKeyForIdentity(), String(n));
    else localStorage.setItem(COST_KEY, String(n));
  }

  function readMemoryStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(MEMORY_KEY) || "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  function writeMemoryStore(store) {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(store));
  }

  function emptyMemoryBucket() {
    return { closed: [], open: null };
  }

  function loadMemoryBucket() {
    if (!state.win || state.ent?.ambiguous) {
      state.memory = null;
      return null;
    }
    const id = identityKey();
    const store = readMemoryStore();
    const bucket = store[id] && typeof store[id] === "object" ? store[id] : emptyMemoryBucket();
    if (!Array.isArray(bucket.closed)) bucket.closed = [];
    state.memory = bucket;
    return { store, id, bucket };
  }

  function sameWindowStart(a, b) {
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < WINDOW_MATCH_MS;
  }

  /*
   * Snapshot the current usage window, and when startAt moves, freeze the previous one.
   * That freeze is the only reliable past boundary we get — the API does not hand history.
   */
  function syncCycleMemory() {
    if (!state.win || state.win.placeholder || !state.win.inferable) {
      loadMemoryBucket();
      return;
    }
    const r = cycleReading();
    if (!r) {
      loadMemoryBucket();
      return;
    }

    const loaded = loadMemoryBucket();
    if (!loaded) return;
    const { store, id, bucket } = loaded;
    const startAt = state.win.startAt;
    const resetAt = state.win.resetAt;
    /*
     * Never freeze an inherited number as this window's own measurement. A previous-window
     * anchor describes the window it came from; storing it here would let one thin window
     * propagate a borrowed ceiling forward for as long as the memory lives.
     */
    const inherited = r.allowance?.source === "previous-window";
    const ceiling = r.ceiling > 0 && !inherited ? r.ceiling : null;
    const measuredDays = r.allowance?.measuredDays ?? null;
    const spend = r.s.credits;

    if (bucket.open && !sameWindowStart(bucket.open.startAt, startAt)) {
      bucket.closed.push({
        startAt: bucket.open.startAt,
        resetAt: bucket.open.resetAt,
        ceiling: bucket.open.ceiling > 0 ? bucket.open.ceiling : null,
        spend: Number(bucket.open.spend) || 0,
        // The window length in force back then — the history table needs it to spot a
        // regime change (e.g. monthly → weekly) instead of calling old rows overspent.
        windowSec: Number(bucket.open.windowSec) || null,
        // Whole measured days behind it, so a later anchor can refuse a thin one.
        measuredDays: bucket.open.measuredDays ?? null,
        closedAt: Date.now(),
      });
      if (bucket.closed.length > MEMORY_KEEP) bucket.closed = bucket.closed.slice(-MEMORY_KEEP);
      bucket.open = null;
    }

    if (!bucket.open || !sameWindowStart(bucket.open.startAt, startAt)) {
      bucket.open = { startAt, resetAt, ceiling, spend, windowSec: state.win.windowSec, measuredDays, updatedAt: Date.now() };
    } else {
      bucket.open.resetAt = resetAt;
      bucket.open.spend = spend;
      bucket.open.windowSec = state.win.windowSec;
      bucket.open.measuredDays = measuredDays;
      if (ceiling != null) bucket.open.ceiling = ceiling;
      bucket.open.updatedAt = Date.now();
    }

    store[id] = bucket;
    writeMemoryStore(store);
    state.memory = bucket;
  }

  function clearCurrentMemory() {
    if (!state.win || state.ent?.ambiguous) return;
    const id = identityKey();
    const store = readMemoryStore();
    delete store[id];
    writeMemoryStore(store);
    state.memory = emptyMemoryBucket();
  }

  let wasOpen = false;

  /*
   * Step back whole months without letting the day of the month overflow. Plain
   * setUTCMonth(-1) turns a renewal on the 30th of March into "30 February", which JavaScript
   * silently rolls forward into March — the period start lands days late and quietly drops
   * usage off the front.
   */
  function rollBack(date, months) {
    const day = date.getUTCDate();
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, 1));
    const lastOfMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();

    return new Date(
      Date.UTC(
        target.getUTCFullYear(),
        target.getUTCMonth(),
        Math.min(day, lastOfMonth),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds(),
      ),
    );
  }

  const hasRenewalDate = () => Number.isFinite(state.ent?.renewsAt);

  // The real billing period when known. The fallback exists only to bound the initial fetch;
  // sheetHtml never presents it as a subscription period.
  function periodRange() {
    const today = dayKey(Date.now());
    if (!hasRenewalDate()) {
      const first = dayMs(today.slice(0, 8) + "01");
      const date = new Date(first);
      return {
        from: today.slice(0, 8) + "01",
        to: today,
        startMs: first,
        endMs: Date.now(),
        fullEndMs: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
        isBilling: false,
      };
    }

    const end = new Date(state.ent.renewsAt);
    const start = rollBack(end, state.ent.billingPeriod === "yearly" ? 12 : 1);

    return {
      from: dayKey(start.getTime()),
      to: dayKey(end.getTime()),
      startMs: start.getTime(),
      endMs: end.getTime(),
      fullEndMs: end.getTime(),
      isBilling: true,
    };
  }

  /*
   * How many separate allowances one subscription payment actually buys.
   *
   * The allowance window and the billing period are different lengths and different
   * phases, and the window restarts on its own clock. So a billing period can contain
   * more than one allowance: burn through one, wait for the reset, and a second full
   * allowance opens before the payment renews.
   *
   * A window opening grants the whole ceiling at once — it is not pro-rated by how much
   * of the period is left. Having only three days to spend it limits what you can *use*,
   * not what you were *given*, which is why the panel reports both.
   *
   * Counting openings backwards assumes the window has always rolled at a fixed length.
   * An extra reset would mean more openings, not fewer, so this is a floor.
   */
  function countWindowOpenings(window, fromMs, toMs) {
    const W = Number(window?.windowSec) * 1000;
    const anchor = Number(window?.startAt);
    if (!(W > 0) || !Number.isFinite(anchor) || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;

    // Billing periods are half-open: an allowance that opens exactly on the renewal timestamp
    // belongs to the next subscription period. If the current window resets Sep 4 and renewal
    // is Sep 18, the usable windows are current → Sep 4, Sep 4 → 11, and Sep 11 → 18: three.
    // The first window is the one containing the period start, even when it opened before it;
    // using ceil here would silently drop that spill window.
    const first = Math.floor((fromMs - anchor) / W);
    const last = Math.ceil((toMs - anchor) / W) - 1;
    return Math.max(0, last - first + 1);
  }

  function countFutureOpenings(window, endMs) {
    if (!window || endMs <= window.resetAt) return 0;
    return countWindowOpenings(window, window.resetAt, endMs);
  }

  function periodAllowances() {
    // Without a renewal date there is no billing period, and counting allowances "per
    // payment" would be a claim about something we cannot see. Same for a placeholder
    // window: its openings would be counted from a boundary that moves on every fetch.
    const window = weeklyWindow() || state.win;
    if (!hasRenewalDate() || !window || window.placeholder || !window.inferable) return null;
    const p = periodRange();
    const windows = countWindowOpenings(window, p.startMs, p.endMs);
    if (!windows) return null;

    return {
      windows,
      resets: Math.max(0, windows - 1),
      window,
      weekly: !!weeklyWindow(),
      ...p,
    };
  }

  function viewRange() {
    const today = dayKey(Date.now());
    if (state.view === "cycle" && state.win) return { from: dayKey(state.win.startAt), to: today };
    const p = periodRange();
    return { from: p.from, to: today };
  }

  function currentSlice() {
    const { from, to } = viewRange();
    const days = state.days.filter((d) => d.date >= from && d.date <= to);
    return { days, s: summarize(days), from, to };
  }

  // Cycle spend and the ceiling it implies. A null ceiling means not enough signal yet.
  /*
   * The allowance, measured instead of inferred.
   *
   * daily-token-usage-breakdown reports each day as a percentage of one allowance, and the
   * usage counts report what that day cost. Their ratio is what one percent is worth, and it
   * is identical on every day — checked across 26 consecutive days on a live account with a
   * spread of exactly zero. A hundred of them is the allowance.
   *
   * One day of usage is enough. Samples are taken from the *current* usage window first:
   * older days can describe a different grant after a plan change or a mid-period reset, and
   * carrying them forward is how a stale $199 figure outlives a window that already caps at
   * $50. The full history is only a fallback when this window has no percent signal yet.
   */
  function measuredAllowance(window = state.win) {
    // A short rate-limit window cannot be matched to whole-day usage buckets. Keep its
    // percentage visible in the status card, but never turn that coarse history into a dollar
    // ceiling by accident.
    if (window && !window.inferable) return null;
    const all = state.days.filter((d) => d.percent > 0 && d.credits > 0);
    if (!all.length) return null;

    const winFrom = window ? dayKey(window.startAt) : null;
    const inWindow = winFrom ? all.filter((d) => d.date >= winFrom) : [];
    const samples = inWindow.length ? inWindow : all;

    /*
     * The ratio holds only while the plan does. An upgrade mid-range splits the samples into
     * two clusters, and a median over both would report whichever cluster is larger — often
     * the plan you are no longer on — with full confidence. Anchor on the newest reading and
     * keep only what agrees with it; what disagrees describes the past, not today.
     */
    const byDateDesc = [...samples].sort((a, b) => b.date.localeCompare(a.date));
    const newest = byDateDesc[0].credits / byDateDesc[0].percent;
    if (!(newest > 0)) return null;

    const agreeing = byDateDesc.filter((d) => Math.abs(d.credits / d.percent - newest) / newest <= 0.02);
    const ratios = agreeing.map((d) => d.credits / d.percent).sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    if (!(median > 0)) return null;

    return {
      credits: median * 100,
      samples: agreeing.length,
      // Days in the pool whose ratio disagrees with today's — evidence the allowance moved.
      dropped: samples.length - agreeing.length,
      scopedToWindow: inWindow.length > 0,
    };
  }

  // Allowances consumed over a date range, straight from the daily percentages. Resets need
  // no counting and no guessing: crossing 100% simply means another allowance was used.
  const allowancesUsed = (fromKey, toKey) =>
    state.days.filter((d) => d.date >= fromKey && d.date <= toKey).reduce((a, d) => a + d.percent, 0) / 100;

  /*
   * Live window size: spend in one window ÷ that window's used%. The weekly value is the
   * correction source when both windows are present; the short window is deliberately not
   * divided because the analytics feed is bucketed by whole UTC days.
   */
  function windowAllowanceFor(window, spendCredits, minimumPercent = 20) {
    if (!(spendCredits > 0) || !window?.inferable || !window.hasUsedPercent) return null;
    const usedPercent = Number(window.usedPercent) || 0;
    if (window.limitReached || usedPercent >= 99.5) {
      return usedPercent > 0 ? spendCredits / (usedPercent / 100) : spendCredits;
    }
    if (usedPercent >= minimumPercent && usedPercent > 0) return spendCredits / (usedPercent / 100);
    return null;
  }

  function windowAllowance(spendCredits, usedPercent, limitReached, window = state.win) {
    if (!window) return null;
    return windowAllowanceFor(
      { ...window, usedPercent, hasUsedPercent: Number.isFinite(Number(usedPercent)), limitReached },
      spendCredits,
    );
  }

  /*
   * One authority for allowance value and provenance. Consumers never infer provenance from
   * whether a number happens to exist: the daily ratio is measured, the window division is
   * inferred, and a material disagreement remains attached to the chosen value.
   */
  function allowanceReading(spendCredits, usedPercent, limitReached, windowObj = state.win) {
    const daily = measuredAllowance(windowObj);
    const window = windowAllowance(spendCredits, usedPercent, limitReached, windowObj);

    /*
     * A reached limit outranks the daily ratio. The spend standing when the API closed IS
     * the allowance — no denominator involved — while the daily percentages can divide by
     * a stale one. Observed live: a plan moved from a monthly to a weekly allowance and
     * the daily endpoint kept dividing by the old monthly figure, reading 2.2× high while
     * the account sat at 0%.
     */
    if (limitReached && window > 0) {
      const rel = daily ? Math.abs(daily.credits - window) / Math.max(daily.credits, window) : 0;
      if (!daily || rel > 0.05) {
        return {
          credits: window,
          source: "depletion",
          samples: 0,
          dropped: 0,
          conflict: daily ? { daily: daily.credits, window } : null,
        };
      }
    }

    if (daily) {
      const rel = window > 0 ? Math.abs(daily.credits - window) / Math.max(daily.credits, window) : 0;
      return {
        ...daily,
        source: "daily-ratio",
        conflict: rel > 0.05 ? { daily: daily.credits, window } : null,
      };
    }

    let credits = window;
    if (!(credits > 0) && windowObj?.inferable) {
      if (usedPercent > 0 && spendCredits > 0) credits = spendCredits / (usedPercent / 100);
      else if (limitReached && spendCredits > 0) credits = spendCredits;
    }

    return credits > 0
      ? { credits, source: "window-percent", samples: 0, dropped: 0, conflict: null }
      : null;
  }

  /*
   * Whole UTC days that lie inside the window AND behind the feed's freshness horizon. The
   * day the window opened is never one of them: its row counts spending from before the
   * window as well, which is the bias the n4 note already describes.
   *
   * Without a freshness timestamp the horizon is the start of today. A day that has ended is
   * assumed settled; today is not. Taking the last day that happens to carry usage instead
   * would repeat the very mistake this guards against — reading an idle day as an unreported
   * one — because an account that spent nothing yesterday reports no row for it either.
   */
  function windowMeasuredDays(window, nowMs = Date.now()) {
    if (!window?.inferable) return 0;

    const horizon = state.freshnessMs || Math.floor(nowMs / DAY_MS) * DAY_MS;
    const from = Math.ceil(window.startAt / DAY_MS) * DAY_MS;
    const to = Math.floor(Math.min(nowMs, window.resetAt, horizon) / DAY_MS) * DAY_MS;
    return Math.max(0, (to - from) / DAY_MS);
  }

  /*
   * The last complete window of the same shape, and only if it ended where this one began.
   * A remembered ceiling is the best dollar anchor there is — one whole grant, measured — but
   * it describes its own window. A monthly grant cannot price a weekly one, and a window two
   * resets back says nothing about a phase that has since shifted, so both are refused.
   *
   * measuredDays must be a number: an entry written before this existed carries no evidence
   * of how well it was measured, and the whole point is to stop borrowing unmeasured numbers.
   */
  function previousWindowAnchor(window) {
    if (!window?.inferable) return null;
    const closed = state.memory?.closed || [];
    for (let i = closed.length - 1; i >= 0; i--) {
      const c = closed[i];
      if (!(c?.ceiling > 0)) continue;
      if (Number(c.windowSec) !== window.windowSec) continue;
      if (!(Math.abs(Number(c.resetAt) - window.startAt) < WINDOW_MATCH_MS)) continue;
      if (!(Number(c.measuredDays) >= MIN_MEASURED_DAYS)) continue;
      return { credits: c.ceiling, from: c };
    }
    return null;
  }

  /*
   * What one weekly grant is worth, and where that number came from.
   *
   * The current week's spend and live 7-day percentage describe the same allowance, so their
   * division is the latest usable estimate. Whole-day buckets can include the opening day,
   * but that is the evidence the API exposes for the current week and is preferable to
   * replacing a known weekly cap with a calendar-day pace. If the current pair is absent, the
   * immediately preceding complete window can still act as an anchor.
   */
  function weeklyAllowanceReading() {
    const win = weeklyWindow();
    if (!win) return null;
    const from = dayKey(win.startAt);
    const to = dayKey(Math.min(Date.now(), win.resetAt));
    const spend = summarize(state.days.filter((d) => d.date >= from && d.date <= to)).credits;
    const daily = measuredAllowance(win);
    const measuredDays = windowMeasuredDays(win);
    const base = { samples: 0, dropped: 0, conflict: null, window: win, spend, usedPercent: win.usedPercent, measuredDays };

    // The API stopped serving at exactly this spend. That is a measurement, not a ratio.
    if (win.limitReached) {
      const atClosure = windowAllowanceFor(win, spend, 0);
      if (atClosure > 0) {
        const rel = daily ? Math.abs(daily.credits - atClosure) / Math.max(daily.credits, atClosure) : 0;
        return {
          ...base,
          credits: atClosure,
          source: "depletion",
          dropped: daily?.dropped || 0,
          conflict: daily && rel > 0.05 ? { daily: daily.credits, window: atClosure } : null,
        };
      }
    }

    // The live weekly percentage pairs directly with the current week's spend. Keep the
    // previous-window anchor only as a fallback when that current pair is absent.
    const current = windowAllowanceFor(win, spend, 0);
    if (current > 0) {
      const rel = daily ? Math.abs(daily.credits - current) / Math.max(daily.credits, current) : 0;
      if (daily && rel <= 0.05) {
        return { ...base, ...daily, source: "daily-ratio", conflict: null };
      }
      return {
        ...base,
        credits: current,
        source: "window-percent",
        conflict: daily && rel > 0.05 ? { daily: daily.credits, window: current } : null,
      };
    }

    const anchor = previousWindowAnchor(win);
    if (anchor) return { ...base, credits: anchor.credits, source: "previous-window", anchor: anchor.from };

    return { ...base, credits: null, source: "no-estimate" };
  }

  function cycleReading() {
    if (!state.win) return null;
    const from = dayKey(state.win.startAt);
    const days = state.days.filter((d) => d.date >= from);
    const s = summarize(days);
    const used = state.win.usedPercent;

    /*
     * Dividing by the used percentage only means anything when the numerator covers the same
     * stretch of time as the percentage. Usage arrives in whole UTC days, so a window shorter
     * than a couple of days would be divided into a day's spend and produce a ceiling several
     * times too large. Better to show nothing than a confidently wrong number.
     */
    const weekly = state.win.kind === "weekly" ? weeklyAllowanceReading() : null;
    const allowance = weekly || allowanceReading(s.credits, used, state.win.limitReached, state.win);
    return { days, s, used, ceiling: allowance?.credits ?? null, allowance, weekly };
  }

  const spendInDays = (fromKey, toKey) =>
    toKey < fromKey ? 0 : summarize(state.days.filter((d) => d.date >= fromKey && d.date <= toKey)).credits;

  // The period projection follows allowance openings, never a calendar-day average.
  function projectPeriodSpend() {
    const p = periodRange();
    const periodDays = Math.round((p.fullEndMs - p.startMs) / DAY_MS);
    const todayKey = dayKey(Date.now());
    const measured = spendInDays(p.from, todayKey);
    const proj = projectToRenewal();
    if (!proj || !(proj.ceiling > 0) || !(proj.allowance >= 0)) return null;

    const allowance = Math.max(0, proj.allowance);
    const projected = measured + allowance;
    const elapsedDays = Math.max(0, Math.min(periodDays, (dayMs(todayKey) - p.startMs) / DAY_MS + 1));

    return {
      p,
      periodDays,
      todayKey,
      measured,
      allowance,
      cap: projected,
      projected,
      ceiling: proj.ceiling,
      openings: proj?.openings ?? null,
      early: periodDays > 0 && elapsedDays / periodDays < 0.2,
    };
  }

  /*
   * Cycle boundaries.
   *
   * Forward from reset_at is firm — the window rolls by a fixed length, so every
   * boundary between now and the renewal date is known. Backward is not: an early
   * reset would have shifted every earlier boundary, so past segments are shown
   * with the caveat and never averaged.
   *
   * Past segments are shown for context only; they do not drive the forecast.
   */
  function cycleSegments() {
    const r = cycleReading();
    if (!state.win || !r || !state.win.inferable || state.win.placeholder) return null;

    const W = state.win.windowSec * 1000;

    /*
     * A window opening mid-day shares that day with the window before it, and a day bucket
     * cannot be split. One rule, applied at every boundary: the opening day belongs to the
     * newer window, so each segment stops the day before the next one opens. Anything less
     * uniform double-counts the shared day between whichever pair it forgot about.
     *
     * A segment counts as trusted only if all of its days were actually fetched. An
     * uncovered segment would report a partial sum as a whole cycle, so it stays visibly
     * separate from the measured rows.
     */
    const past = [];
    for (let k = 1; k <= 8; k++) {
      const start = state.win.startAt - k * W;
      const fromKey = dayKey(start);
      const toKey = addDays(dayKey(start + W), -1);
      if (toKey < fromKey) break;

      const covered = !!state.fetchedFrom && fromKey >= state.fetchedFrom;
      past.unshift({ start, end: start + W, spend: spendInDays(fromKey, toKey), covered });
      if (!covered) break;
    }

    // Count openings arithmetically and cap only the rendered rows. A display cap must never
    // silently become a cap on the total.
    let openings = 0;
    const future = [];
    if (hasRenewalDate() && state.ent.renewsAt >= state.win.resetAt) {
      // A reset exactly on the renewal date belongs to the next billing period, so it is not
      // included; rows that would have zero spend are not rendered either.
      openings = countFutureOpenings(state.win, state.ent.renewsAt);
      for (let i = 0; i < Math.min(openings, 10); i++) {
        const start = state.win.resetAt + i * W;
        const end = Math.min(start + W, state.ent.renewsAt);
        if (end > start) future.push({ start, end, endsEarly: end < start + W });
      }
    }

    return {
      past,
      future,
      openings,
      current: { start: state.win.startAt, end: state.win.resetAt, spend: r.s.credits, ceiling: r.ceiling },
    };
  }

  // How much allowance is still coming before the subscription renews.
  function projectToRenewal() {
    const seg = cycleSegments();
    const r = cycleReading();
    if (!seg || !hasRenewalDate() || !r) return null;

    const now = Date.now();
    if (state.ent.renewsAt <= now) return null;
    const weekly = state.win.kind === "weekly" ? weeklyAllowanceReading() : null;
    const ceiling = weekly?.credits ?? r.ceiling;
    if (!ceiling) return { renewsAt: state.ent.renewsAt, ceiling: null, seg, weekly };

    const weeklySpend = weekly?.spend ?? r.s.credits;
    const usedByPercent =
      weekly && weekly.window?.hasUsedPercent
        ? ceiling * Math.min(100, Math.max(0, weekly.window.usedPercent)) / 100
        : 0;
    // Use the larger of the live percentage and fetched spend so a day-bucket overlap cannot
    // make the current remainder look more generous than the account permits.
    const currentUsed = Math.max(weeklySpend, usedByPercent);
    const leftThisCycle = Math.max(0, ceiling - currentUsed);

    // Every unused reset card is one more allowance that can be opened before renewal.
    const bank = state.resetCards?.available ?? state.win.resetBank ?? 0;
    const naturalOpenings = countFutureOpenings(state.win, state.ent.renewsAt);
    const openings = naturalOpenings + bank;

    // Purchased credit balance is spendable after the plan pool; add it to what is still left.
    const creditLeft = state.purchased?.unlimited ? 0 : Math.max(0, state.purchased?.balance || 0);
    const windowLeft = leftThisCycle + openings * ceiling;

    return {
      renewsAt: state.ent.renewsAt,
      ceiling,
      seg,
      leftThisCycle,
      openings,
      bank,
      naturalOpenings,
      hasPartial: (Math.max(0, state.ent.renewsAt - state.win.resetAt) / (state.win.windowSec * 1000)) % 1 > 0.001,
      creditLeft,
      allowance: windowLeft + creditLeft,
      weeklyUsedPercent: weekly?.usedPercent ?? null,
      weeklySpend,
    };
  }

  // ── Styles ──────────────────────────────────────────────────────────────
  /*
   * Two accents carry meaning rather than decoration:
   *   blue  = measured, straight from the API
   *   amber = inferred by this script, and always drawn dashed
   */
  const CSS = `
    /* Hallmark · Mosaic Tiles · Direction 3 */
    :host {
      --bg: oklch(0.155 0.006 155);
      --bg-panel: oklch(0.195 0.008 155);
      --bg-tile: oklch(0.225 0.010 155);
      --bg-tile-sub: oklch(0.210 0.009 155);
      --bg-raised: oklch(0.265 0.012 155);
      --bg-track: oklch(0.285 0.012 155);
      --line: oklch(0.340 0.014 155);
      --line-strong: oklch(0.430 0.016 155);
      --ink: oklch(0.930 0.012 150);
      --ink-2: oklch(0.820 0.016 150);
      --ink-3: oklch(0.660 0.018 150);
      --ink-dim: oklch(0.740 0.020 150);
      --ink-faint: oklch(0.660 0.018 150);
      --color-accent: oklch(0.760 0.070 152);
      --color-accent-ink: oklch(0.200 0.012 152);
      --accent-dim: oklch(0.640 0.055 152);
      --hatch: oklch(0.540 0.048 152);
      --seg-a: oklch(0.760 0.070 152);
      --seg-b: oklch(0.660 0.055 138);
      --seg-c: oklch(0.560 0.042 168);
      --ring: oklch(0.820 0.075 152);
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      
      /* Semantic aliases for backwards compatibility with tests and components */
      --measured: var(--color-accent);
      --measured-soft: var(--accent-dim);
      --inferred: var(--accent-dim);
      --inferred-text: var(--color-accent);
      --rule: var(--line);
      --amber: var(--accent-dim);
      --amber-bg: var(--bg-tile-sub);
      --alarm: oklch(0.70 0.18 25);
    }
    * { box-sizing: border-box; }
    
    .trigger {
      position: fixed;
      top: 66vh;
      right: 18px;
      z-index: 2147483646;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--bg-panel);
      color: var(--ink);
      font-family: var(--font-sans);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
      transition: background 140ms ease-out, border-color 140ms ease-out, transform 140ms ease-out;
    }
    .trigger:hover { background: var(--bg-raised); border-color: var(--color-accent); color: var(--ink); transform: translateY(-1px); }
    .trigger:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
    .trigger:active { transform: translateY(1px); }
    .trigger.busy { opacity: 0.7; cursor: wait; }
    .trigger.busy .trigger-name { color: var(--ink-dim); }
    .trigger-ps { color: var(--color-accent); font-family: var(--mono); font-weight: 700; }
    .cursor::after { content: "▮"; color: var(--color-accent); font-family: var(--mono); animation: blink 1s step-end infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    
    .scrim {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.65);
      backdrop-filter: blur(4px);
      z-index: 999999;
      display: grid;
      place-items: center;
      padding: 24px 16px;
      overflow-y: auto;
    }
    .panel {
      width: 100%;
      max-width: 880px;
      background: var(--bg-panel);
      color: var(--ink);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.4);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.5;
      outline: none;
    }
    
    .num, .amount, .gauge-fig, .forecast-fig, .stat-fig, .n, .v, .svg-text-num {
      font-variant-numeric: tabular-nums;
    }
    
    /* Header */
    .masthead {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--line);
    }
    .wordmark {
      margin: 0;
      font-size: 15px;
      font-weight: 650;
      letter-spacing: 0.01em;
    }
    .wordmark em { font-style: normal; font-weight: normal; color: var(--ink-dim); }
    .subhead {
      margin: 4px 0 0;
      font-size: 10.5px;
      letter-spacing: 0.04em;
      color: var(--ink-faint);
    }
    .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .seg {
      display: flex;
      gap: 4px;
      padding: 4px;
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .seg button {
      appearance: none;
      border: 0;
      border-radius: 6px;
      padding: 4px 12px;
      background: transparent;
      color: var(--ink-dim);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: background 140ms ease-out, color 140ms ease-out;
    }
    .seg button:hover { color: var(--ink); }
    .seg button[aria-pressed="true"] {
      background: var(--bg-raised);
      color: var(--ink);
      font-weight: 600;
    }
    .ghost {
      appearance: none;
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: transparent;
      color: var(--ink-dim);
      font: inherit;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      transition: border-color 140ms ease-out, color 140ms ease-out;
    }
    .ghost:hover { color: var(--ink); border-color: var(--line-strong); }
    
    /* Sheet & Rules */
    .sheet { padding: 16px 20px; display: flex; flex-direction: column; gap: 16px; }
    .rule { height: 1px; background: var(--line); margin: 4px 0; }
    .rule.major { height: 1px; background: var(--line-strong); margin: 8px 0; }
    
    /* Window Status */
    .window-status {
      padding: 12px 16px;
      background: var(--bg-tile);
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    .window-status h2 { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
    .window-status-note { font-size: 11px; color: var(--ink-faint); margin-bottom: 12px; }
    .window-status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .window-status-card {
      padding: 10px 14px;
      background: var(--bg-tile-sub);
      border: 1px solid var(--line);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .window-percent { font-size: 20px; font-weight: 700; color: var(--color-accent); font-variant-numeric: tabular-nums; }
    .readout { font-size: 11px; color: var(--ink-dim); display: flex; flex-wrap: wrap; gap: 8px; }
    .readout span { display: inline-flex; align-items: center; gap: 4px; }
    .hint { font-size: 10.5px; color: var(--ink-faint); }
    
    /* Gauge Header */
    .gauge-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 12px;
      padding: 16px;
      background: var(--bg-tile);
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    .gauge-head .amount { font-size: 32px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
    .gauge-head .amount.small { font-size: 28px; }
    .gauge-head .right { text-align: right; }
    .eyebrow { font-size: 11px; color: var(--ink-faint); letter-spacing: 0.05em; text-transform: uppercase; }
    .eyebrow.is-inferred { color: var(--accent-dim); }
    
    /* Track & Bar */
    .gauge {
      padding: 12px 16px;
      background: var(--bg-tile);
      border: 1px solid var(--line);
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .track {
      position: relative;
      height: 16px;
      background: var(--bg-track);
      border-radius: 8px;
      overflow: hidden;
    }
    .track .fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: calc(var(--fill) * 100%);
      background: var(--color-accent);
      border-radius: 8px;
    }
    .ticks { display: flex; justify-content: space-between; font-size: 10px; color: var(--ink-faint); }
    .legend-key { display: flex; gap: 12px; font-size: 11px; color: var(--ink-dim); margin-top: 4px; }
    .legend-key span { display: inline-flex; align-items: center; gap: 6px; }
    .key-solid { width: 8px; height: 8px; background: var(--color-accent); border-radius: 2px; display: inline-block; }
    .key-solid.soft { background: var(--accent-dim); }
    .key-dash { width: 8px; height: 8px; border: 1px dashed var(--accent-dim); border-radius: 2px; display: inline-block; }
    .key-line { width: 12px; height: 2px; background: var(--ink); display: inline-block; }
    .key-line.dash { background: transparent; border-top: 2px dashed var(--accent-dim); }
    
    .verdict { margin: 8px 0 0; font-size: 11.5px; color: var(--ink-dim); }
    .verdict.alarm { color: oklch(0.70 0.18 25); font-weight: 600; }
    
    /* Forecast */
    .forecast {
      padding: 16px;
      background: var(--bg-tile);
      border: 1px solid var(--line);
      border-radius: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      justify-content: space-between;
    }
    .forecast .amount.small { font-size: 24px; font-weight: 700; color: var(--color-accent); font-variant-numeric: tabular-nums; }
    .cost-line { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
    .cost-input {
      width: 90px;
      padding: 4px 8px;
      background: var(--bg-panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--ink);
      font: inherit;
      font-size: 12px;
    }
    
    /* Cards Grid */
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .cell {
      padding: 12px 14px;
      background: var(--bg-tile);
      border: 1px solid var(--line);
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .cell .k { font-size: 11px; color: var(--ink-faint); letter-spacing: 0.04em; text-transform: uppercase; }
    .cell .k.is-inferred { color: var(--accent-dim); }
    .cell .v { font-size: 22px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
    .cell .s { font-size: 11px; color: var(--ink-faint); }
    
    /* Split Horizontal Bar */
    .split-bar { height: 18px; border-radius: 6px; overflow: hidden; display: flex; background: var(--bg-track); margin: 8px 0 12px; }
    .split-bar i { height: 100%; display: block; }
    .split-bar .a { background: var(--seg-b); }
    .split-bar .b { background: var(--seg-a); }
    .split-bar .c { background: var(--seg-c); }
    
    /* Charts & SVG */
    .chart {
      padding: 16px;
      background: var(--bg-tile);
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    .chart h2, .section-head h2 { margin: 0 0 12px; font-size: 12.5px; font-weight: 600; color: var(--ink); }
    .chart h2 em, .section-head em { font-style: normal; font-weight: normal; color: var(--ink-faint); font-size: 11px; margin-left: 8px; }
    .chart svg { display: block; width: 100%; height: auto; }
    svg text {
      font-family: var(--font-sans);
      font-size: 11px;
      fill: var(--ink-dim);
    }
    .chart text { fill: var(--ink-dim); }
    .chart .label-strong, text.label-strong { fill: var(--ink); font-weight: 600; font-size: 11.5px; }
    .chart .muted, text.muted { fill: var(--ink-faint); font-size: 10px; }
    .chart line.axis { stroke: var(--line-strong); }
    
    /* Tables & Scroll */
    .scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-tile); }
    .scroll table { width: 100%; border-collapse: collapse; font-size: 11px; white-space: nowrap; }
    .scroll th, .scroll td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); }
    .scroll th { background: var(--bg-tile-sub); color: var(--ink-faint); font-weight: 600; font-size: 10.5px; }
    .scroll th.n, .scroll td.n { text-align: right; font-variant-numeric: tabular-nums; }
    .scroll td.n.strong { font-weight: 600; color: var(--ink); }
    
    /* Drilldown Rows */
    .row-toggle {
      appearance: none;
      border: 0;
      background: transparent;
      padding: 0;
      color: var(--ink);
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      text-align: left;
    }
    .row-toggle:hover { color: var(--color-accent); }
    .row-toggle .rchev { display: inline-block; font-size: 10px; color: var(--ink-faint); transition: transform 140ms ease-out; }
    .row-toggle.is-open .rchev { transform: rotate(90deg); color: var(--color-accent); }
    
    .sub-row { display: none; background: var(--bg-tile-sub); }
    .sub-row.is-open { display: table-row; }
    .drilldown-box { padding: 8px 12px 12px 28px; }
    
    /* Master Audit Ledger Drawer */
    .master-ledger {
      width: 100%;
      border-top: 1px solid var(--line);
      background: var(--bg-panel);
    }
    .ledger-sum {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      font-size: 12px;
      font-weight: 600;
      color: var(--ink-dim);
      cursor: pointer;
      list-style: none;
      user-select: none;
      transition: color 140ms ease-out;
    }
    .ledger-sum::-webkit-details-marker { display: none; }
    .ledger-sum:hover { color: var(--ink); }
    .ledger-sum .left { display: inline-flex; align-items: center; gap: 8px; }
    .ledger-sum .chev { display: inline-block; transition: transform 140ms ease-out; }
    .master-ledger[open] .ledger-sum .chev { transform: rotate(90deg); }
    .ledger-badge {
      font-size: 10px;
      font-weight: 500;
      padding: 4px 8px;
      border-radius: 4px;
      background: var(--bg-raised);
      color: var(--ink-faint);
    }
    .ledger-body {
      padding: 0 20px 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .sub-tabs {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 8px;
    }
    .sub-tab-btn {
      appearance: none;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 4px 12px;
      background: var(--bg-tile);
      color: var(--ink-dim);
      font: inherit;
      font-size: 11.5px;
      cursor: pointer;
      transition: background 140ms ease-out, color 140ms ease-out, border-color 140ms ease-out;
    }
    .sub-tab-btn:hover { color: var(--ink); border-color: var(--line-strong); }
    .sub-tab-btn.is-active {
      background: var(--color-accent);
      color: var(--color-accent-ink);
      font-weight: 600;
      border-color: var(--color-accent);
    }
    .ledger-pane { display: none; }
    .ledger-pane.is-active { display: block; }
    
    /* Notes & Status */
    .notes { padding: 12px 16px; background: var(--bg-tile); border: 1px solid var(--line); border-radius: 10px; font-size: 11px; color: var(--ink-faint); }
    .notes h3 { margin: 0 0 4px; font-size: 11px; font-weight: 600; }
    .notes ul { margin: 0; padding-left: 18px; }
    .notes li.warn { color: var(--accent-dim); }
    .status { padding: 40px 20px; text-align: center; color: var(--ink-dim); }
    .status.bad { color: oklch(0.70 0.18 25); }
  `;
  function percentNumber(value) {
    if (!Number.isFinite(Number(value))) return "—";
    const n = Math.min(100, Math.max(0, Number(value)));
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  function windowStatusHtml() {
    const L = t();
    const rows = [];
    const short = shortWindow();
    const weekly = weeklyWindow();
    const add = (window, kind, label, hint) => {
      if (!window || rows.some((row) => row.window === window)) return;
      const used = window.hasUsedPercent ? percentNumber(window.usedPercent) : "—";
      const remaining = window.hasUsedPercent ? percentNumber(100 - window.usedPercent) : "—";
      rows.push({ window, kind, label, hint, used, remaining });
    };

    add(short, "short", L.shortWindowLabel, L.shortWindowEstimate);
    const weeklyReading = weekly ? weeklyAllowanceReading() : null;
    add(
      weekly,
      "weekly",
      L.weeklyWindowLabel,
      weeklyReading?.credits > 0
        ? (() => {
            const source =
              weeklyReading.source === "previous-window"
                ? L.measuredFromPrevious
                : weeklyReading.source === "depletion"
                  ? L.measuredAtDepletion
                  : weeklyReading.source === "daily-ratio"
                    ? L.measured
                    : L.inferred;
            const used = Math.max(
              weeklyReading.spend || 0,
              weeklyReading.credits * (Number(weekly.usedPercent) || 0) / 100,
            );
            const left = Math.max(0, weeklyReading.credits - used);
            return L.weeklyCorrection(source, usd(weeklyReading.credits), usd(used), usd(left));
          })()
        : "",
    );

    if (!rows.length && state.win) {
      const days = state.win.windowSec / 86400;
      const label = days < 1
        ? L.windowHours(state.win.planType || "Codex", Math.max(1, Math.round(state.win.windowSec / 3600)))
        : L.window(state.win.planType || "Codex", Number.isInteger(days) ? String(days) : days.toFixed(1));
      add(state.win, "main", label, "");
    }
    if (!rows.length) return "";

    return `
      <div class="window-status" aria-label="${esc(L.windowStatusTitle)}">
        <h2>${esc(L.windowStatusTitle)}</h2>
        <div class="window-status-note">${esc(L.windowStatusHint(!!short, !!weekly))}</div>
        <div class="window-status-grid">
          ${rows
            .map(
              (row) => `<div class="window-status-card ${esc(row.kind)}" data-window-kind="${esc(row.kind)}">
                <div class="eyebrow">${esc(row.label)}</div>
                <div class="window-percent">${esc(L.remainingPercent(row.remaining))}</div>
                <div class="readout">
                  <span>${esc(L.usedPercent(row.used))}</span>
                  <span>${esc(L.resetAtLabel(clock(row.window.resetAt)))}</span>
                </div>
                ${row.hint ? `<div class="hint">${esc(row.hint)}</div>` : ""}
              </div>`,
            )
            .join("")}
        </div>
      </div>`;
  }

  function gaugeHtml() {
    const L = t();
    const r = cycleReading();
    const win = state.win;
    const blockedWindow = win.limitReached ? win : null;
    // A shorter window at 100% blocks the API without saying anything about this window's
    // grant. It gets its own line rather than standing in for this window's verdict.
    const shortBlocked = !blockedWindow && shortWindow()?.limitReached ? shortWindow() : null;
    const now = Date.now();
    const source = r.allowance?.source;
    // The depletion point is a measurement too: the API stopped serving at exactly that spend.
    const allowanceMeasured = source === "daily-ratio" || source === "depletion";

    const ratio = r.ceiling ? Math.min(1, r.s.credits / r.ceiling) : 0;
    const enoughElapsed = (now - win.startAt) / DAY_MS >= 2;
    /*
     * A measured ceiling is one allowance, and day buckets can hold more than one — a boundary
     * day shared with the previous window, or a reset genuinely crossed mid-cycle. Unclamped
     * this prints a negative remainder and an alarm dated in the past.
     */
    const remaining = r.ceiling ? Math.max(0, r.ceiling - r.s.credits) : null;
    const overspent = r.ceiling ? r.s.credits > r.ceiling : false;

    return `
      ${windowStatusHtml()}
      <div class="gauge-head">
        <div>
          <div class="eyebrow">${esc(L.measured)} · ${esc(L.spent)}</div>
          <div class="amount">${usd(r.s.credits)}</div>
        </div>
        ${
          /* The allowance stopped being a guess the moment it could be read off the daily
             percentages, and the panel must not keep calling it one. Solid where measured,
             dashed amber only where it is still divided out of the window percentage. */
          r.ceiling
            ? `<div class="right">
                 <div class="eyebrow ${allowanceMeasured ? "" : "is-inferred"}">${esc(allowanceMeasured ? L.measured : L.inferred)} · ${esc(L.ceiling)}</div>
                 <div class="amount small ${allowanceMeasured ? "" : "is-inferred"}">${usd(r.ceiling)}</div>
                 ${
                   source === "daily-ratio"
                     ? `<div class="eyebrow" style="margin:5px 0 0">${esc(L.measuredFrom(r.allowance.samples))}</div>`
                     : source === "depletion"
                       ? `<div class="eyebrow" style="margin:5px 0 0">${esc(L.measuredAtDepletion)}</div>`
                       : ""
                 }
               </div>`
            : ""
        }
      </div>

      <div class="gauge">
        <div class="track ${r.ceiling ? "" : "blank"}" role="img"
             aria-label="${esc(
               r.ceiling
                 ? L.gaugeAria(usd(r.s.credits), usd(r.ceiling), allowanceMeasured)
                 : L.noCeiling(Math.round(r.used)),
             )}">
          <div class="fill ${ratio > 0.8 ? "hot" : ""}" style="--fill:${r.ceiling ? ratio.toFixed(3) : 0}"></div>
        </div>
        <div class="ticks"><span>0</span><span>25</span><span>50</span><span>75</span><span>100%</span></div>
        <div class="legend-key">
          <span><i class="key-solid"></i>${esc(L.measured)}</span>
          <span><i class="key-dash"></i>${esc(L.inferred)}</span>
        </div>
      </div>

      ${
        /* A block on a shorter window is not a block on this one. Say so on its own line so
           the current weekly reading still gets to speak for the window it measures. */
        shortBlocked ? `<p class="verdict alarm">${esc(L.depletedShort(clock(shortBlocked.resetAt)))}</p>` : ""
      }

      ${
        /* A reached limit means the API refuses further use. Say what happened and when it
           unlocks instead of inventing a pace-based run-out. */
        blockedWindow
          ? `<p class="verdict alarm">${esc(((blockedWindow.reachedType || "").includes("credits") ? L.depletedCredits : L.depleted)(clock(blockedWindow.resetAt)))}</p>`
          : !r.ceiling && win.inferable && enoughElapsed
            ? `<p class="verdict"><span class="inf">${esc(L.noCeiling(Math.round(r.used)))}</span></p>`
            : !r.ceiling
              ? `<p class="verdict">${esc(win.inferable ? L.noCeiling(Math.round(r.used)) : L.windowTooShort)}</p>`
              : ""
      }

      ${
        /* Where a thin window sent the ceiling — borrowed from the last complete one, or
           withheld entirely. Either way the reader is owed the reason. */
        source === "previous-window"
          ? `<p class="verdict">${esc(L.weeklyFromPrevious)}</p>`
          : source === "no-estimate"
            ? `<p class="verdict">${esc(L.weeklyThin)}</p>`
            : ""
      }

      ${
        /* A live disagreement between the two allowance sources belongs next to the number
           it disputes, not in the footnotes. */
        r.allowance?.conflict
          ? `<p class="verdict alarm">${esc(
              (source === "depletion"
                ? L.allowanceConflictStale
                : source === "window-percent"
                  ? L.weeklyAllowanceConflict
                  : L.allowanceConflict)(
                usd(r.allowance.conflict.daily),
                usd(r.allowance.conflict.window),
              ),
            )}</p>`
          : ""
      }

      ${
        overspent
          ? `<p class="verdict">${esc(windowCopy("overspent")(allowancesUsed(dayKey(win.startAt), dayKey(now)).toFixed(1)))}</p>`
          : ""
      }
      <div class="readout">
        ${r.ceiling ? `<span><b class="inf">${usd(remaining)}</b> ${esc(L.leftSuffix(pct(1 - ratio)))}</span>` : ""}
        ${!r.ceiling && win.inferable && enoughElapsed ? `<span>${esc(L.noCeiling(Math.round(r.used)))}</span>` : ""}
        <span>${esc(L.windowSpan(clock(win.startAt), clock(win.resetAt)))}</span>
        <span>${esc(L.resetInPre)} <b>${Math.max(0, (win.resetAt - now) / DAY_MS).toFixed(1)}</b> ${esc(L.resetInPost)}</span>
        ${
          (state.resetCards?.available || 0) > 0 && r.ceiling
            ? `<span>${esc(L.resetCardsAvail(state.resetCards.available, usd(state.resetCards.available * r.ceiling)))}</span>`
            : ""
        }
        ${
          state.purchased?.unlimited
            ? `<span>${esc(L.creditsUnlimited)}</span>`
            : (state.purchased?.balance || 0) > 0
              ? `<span>${esc(L.creditsBalance(usd(state.purchased.balance)))}</span>`
              : ""
        }
      </div>
    `;
  }

  // Says which window openings the remaining allowance is actually made of.
  function breakdownLine(proj) {
    const L = t();
    const left = usd(proj.leftThisCycle);
    let line = !proj.openings
      ? windowCopy("renewalOneCycle")(left)
      : windowCopy("renewalMath")(left, proj.naturalOpenings, usd(proj.ceiling), proj.hasPartial);

    if (proj.bank > 0) line = `${line} ${L.plusBank(proj.bank, usd(proj.bank * proj.ceiling))}`;
    if (proj.creditLeft > 0) line = `${line} ${L.plusCredits(usd(proj.creditLeft))}`;
    else if (state.purchased?.unlimited) line = `${line} ${L.creditsUnlimited}`;
    return line;
  }

  /** Extra allowance already opened this billing period by spending reset cards. */
  function resetCardsUsedValue(ceiling) {
    const n = state.resetCards?.usedInPeriod || 0;
    if (!(n > 0) || !(ceiling > 0)) return { n: 0, credits: 0 };
    return { n, credits: n * ceiling };
  }

  function forecastHtml() {
    const L = t();
    if (!state.win || !hasRenewalDate()) return "";

    const proj = projectToRenewal();
    const cost = monthlyCost();
    const p = periodRange();
    const periodSpend = summarize(state.days.filter((d) => d.date >= p.from)).credits;
    const periodProjection = projectPeriodSpend();

    // Cost stays editable after the first save: a wrong figure locked in place is worse
    // than a small input sitting next to the payback line.
    const costField = (value) =>
      `<input class="cost-input" type="number" min="0" step="1" inputmode="decimal"
              ${value > 0 ? `value="${value}"` : ""}
              placeholder="${esc(L.costPlaceholder)}" aria-label="${esc(L.setCost)}">`;

    const payback =
      cost > 0
        ? `<div class="amount small">${((periodSpend * USD_PER_CREDIT) / cost).toFixed(1)}×</div>
           <div class="readout cost-line">
             <span>${esc(L.paybackPaidLead)}</span>
             <span class="cost-currency">$</span>${costField(cost)}
             <span>${esc(L.paybackUsedTail(usd(periodSpend)))}</span>
           </div>
           ${periodProjection ? `<div class="readout"><span class="inf">${esc(L.projPayback(((periodProjection.projected * USD_PER_CREDIT) / cost).toFixed(1)))}</span></div>` : ""}
           <div class="readout"><span>${esc(L.periodSpan(shortDate(p.from), shortDate(p.to)))}</span></div>`
        : `<div class="readout" style="margin:2px 0 6px"><span>${esc(L.setCost)}</span></div>
           ${costField(0)}`;

    let forecastBlock = "";
    if (proj) {
      const allowance =
        proj.ceiling == null
          ? `<div class="amount small" style="color:var(--ink-3)">—</div>
             <div class="readout"><span>${esc(L.renewalUnknown)}</span></div>`
          : `<div class="amount small is-inferred">${usd(proj.allowance)}</div>
             <div class="readout"><span>${esc(L.renewalOn(dateOnly(proj.renewsAt)))}</span></div>
             <div class="readout"><span>${esc(breakdownLine(proj))}</span></div>`;

      forecastBlock = `
      <div class="forecast">
        <div style="flex:2 1 320px"><div class="eyebrow is-inferred">${esc(L.inferred)} · ${esc(L.untilRenewal)}</div>${allowance}</div>
        <div><div class="eyebrow">${esc(L.payback)}</div>${payback}</div>
      </div>`;
    } else {
      forecastBlock = `
      <div class="forecast">
        <div><div class="eyebrow">${esc(L.payback)}</div>${payback}</div>
      </div>`;
    }

    return `${forecastBlock}${cycleStripHtml(proj)}`;
  }

  function cycleStripHtml(proj) {
    const L = t();
    const r = cycleReading();
    if (!state.win || !r || state.win.placeholder || !state.win.inferable) return "";

    const span = (a, b) => `${shortDate(dayKey(a))} → ${shortDate(dayKey(b))}`;
    const rows = [];
    const closed = state.memory?.closed || [];
    const ceiling = r.ceiling;

    const lengthDays = (sec) => {
      const d = sec / 86400;
      return Number.isInteger(d) ? String(d) : d.toFixed(1);
    };

    // Remembered closed windows first — observed start/reset, not arithmetic lookback.
    for (const c of closed) {
      // A recorded length that differs from today's means the plan regime changed
      // (monthly → weekly has been observed live). Such a row is history from different
      // rules, not an overspent window.
      const regimeChanged =
        c.windowSec > 0 && state.win.windowSec > 0 && Math.abs(c.windowSec - state.win.windowSec) > 3600;
      const suspect = !regimeChanged && ceiling && c.spend > ceiling * 1.15;
      const note = regimeChanged
        ? `${L.cycleRemembered} · ${L.cycleRegimeChanged(lengthDays(c.windowSec), lengthDays(state.win.windowSec))}`
        : suspect
          ? `${L.cycleRemembered} · ${L.cycleSuspect}`
          : L.cycleRemembered;
      const spend = c.spend > 0 ? usd(c.spend) : "—";
      const amount = c.ceiling
        ? `${spend} <span class="inf">/ ${usd(c.ceiling)}</span>`
        : spend;
      rows.push([span(c.startAt, c.resetAt), note, amount, "past"]);
    }

    // Fixed-length lookback only fills gaps memory does not cover. Early resets make these drift.
    const seg = proj?.seg;
    if (seg) {
      for (const p of seg.past) {
        if (!p.covered || !(p.spend > 0)) continue;
        if (closed.some((c) => sameWindowStart(c.startAt, p.start))) continue;
        // No record says what window length ruled back then, so over-allowance spend has
        // two readings — a real mid-window reset, or slicing a longer-window era by
        // today's length. The note must not pretend to know which.
        const suspect = ceiling && p.spend > ceiling * 1.15;
        const note = suspect ? `${L.cycleInferred} · ${windowCopy("cycleSuspectInferred")}` : L.cycleInferred;
        rows.push([span(p.start, p.end), note, `<span class="inf">${usd(p.spend)}</span>`, "past"]);
      }
    }

    rows.push([
      span(state.win.startAt, state.win.resetAt),
      L.cycleNow,
      ceiling
        ? `${usd(r.s.credits)} <span class="inf">/ ${usd(ceiling)}</span>`
        : usd(r.s.credits),
      "now",
    ]);

    // Future openings stay out of this table — they mix billing forecast into usage history.
    // "Left before renewal" above already states what still opens before the next payment.

    let changeLine = "";
    if (closed.length && ceiling) {
      const prevCeil = closed[closed.length - 1].ceiling;
      if (prevCeil > 0 && Math.abs(prevCeil - ceiling) / prevCeil > 0.02) {
        changeLine = `<div class="readout" style="margin-top:8px"><span>${esc(
          L.cycleCeilingChanged(usd(prevCeil), usd(ceiling)),
        )}</span></div>`;
      }
    }

    const hasClosed = closed.length > 0;
    const clearBtn = hasClosed
      ? `<button type="button" class="mem-clear" data-act="clear-mem">${esc(L.cycleMemClear)}</button>`
      : "";

    return `
      <div style="margin-top:20px">
        <h2>${esc(windowCopy("cycles"))}<em>${esc(windowCopy("cyclesSub"))}</em></h2>
        <div class="scroll" tabindex="0" role="region" aria-label="${esc(windowCopy("cycles"))}"><table>
          <thead><tr><th>${esc(L.thWhen)}</th><th></th><th class="n">${esc(L.thSpend)}</th></tr></thead>
          <tbody>${rows
            .map(
              ([when, what, amount, kind]) => `<tr class="cyc-${kind}">
                <td>${esc(when)}</td>
                <td class="cyc-note">${esc(what)}</td>
                <td class="n strong">${amount}</td>
              </tr>`,
            )
            .join("")}</tbody>
        </table></div>
        ${changeLine}
        ${hasClosed ? "" : `<div class="readout" style="margin-top:8px"><span>${esc(L.cycleMemEmpty)}</span></div>`}
        <div class="mem-foot">
          <p class="mem-note">${esc(L.cycleMemLocal)}</p>
          ${clearBtn}
        </div>
      </div>
    `;
  }

  function calendarDayRate(fromKey) {
    const lastCompleteKey = addDays(dayKey(Date.now()), -1);
    const days = Math.max(0, (dayMs(lastCompleteKey) - dayMs(fromKey)) / DAY_MS + 1);
    if (!days) return null;
    const spend = spendInDays(fromKey, lastCompleteKey);
    return { days, spend, rate: spend / days, lastCompleteKey };
  }

  /*
   * Usage-window rows inside the billing period for the timeline and comparison table.
   * Remembered boundaries win; fixed-length lookback fills gaps; future openings are dashed.
   */
  function periodWindowRows() {
    const p = periodRange();
    const r = cycleReading();
    const ceiling = r?.ceiling || null;
    const rows = [];
    const push = (row) => {
      if (!(row.end > row.start)) return;
      if (row.end < p.startMs || row.start > Math.max(p.endMs, Date.now())) return;
      rows.push(row);
    };
    const pushCurrent = () => {
      if (!state.win || !r) return;
      const spansStart = state.win.startAt < p.startMs;
      const start = Math.max(state.win.startAt, p.startMs);
      const end = Math.min(state.win.resetAt, p.endMs);
      const through = Math.min(Date.now(), end);
      push({
        start,
        origStart: state.win.startAt,
        end,
        spend: spansStart ? spendInDays(p.from, dayKey(through)) : r.s.credits,
        ceiling,
        kind: "now",
        spansStart,
      });
    };

    for (const c of state.memory?.closed || []) {
      // A remembered window that spans the period start carries last period's spend in its
      // stored total. Inside this table everything is framed by the period, so clip it to
      // the in-period days — same treatment as the inferred spill row below.
      const spansStart = c.startAt < p.startMs && c.resetAt > p.startMs;
      push({
        start: spansStart ? p.startMs : c.startAt,
        origStart: c.startAt,
        end: c.resetAt,
        spend: spansStart
          ? spendInDays(dayKey(p.startMs), addDays(dayKey(c.resetAt), -1))
          : c.spend,
        ceiling: c.ceiling,
        kind: spansStart ? "spill" : "remembered",
      });
    }

    const seg = cycleSegments();
    if (seg) {
      for (const past of seg.past) {
        // Dedupe on the window's true opening time: a clipped row's start was moved to the
        // period boundary, so matching on start alone would let the same window in twice.
        if (rows.some((x) => sameWindowStart(x.origStart ?? x.start, past.start))) continue;
        if (!past.covered) {
          /*
           * A window that opened before the fetch range can still own the billing period's
           * opening days — and those days were fetched, because the fetch always reaches back
           * to the period start. Show that stretch as a row truncated to the period instead of
           * dropping the segment: dropped, the table stops adding up to the headline spend (by
           * 18% of the period, on the account this was found on).
           */
          const inPeriodFrom = dayKey(Math.max(past.start, p.startMs));
          if (!state.fetchedFrom || inPeriodFrom < state.fetchedFrom) continue;
          const spend = spendInDays(inPeriodFrom, addDays(dayKey(past.end), -1));
          if (spend > 0)
            push({
              start: Math.max(past.start, p.startMs),
              origStart: past.start,
              end: past.end,
              spend,
              ceiling: null,
              kind: "spill",
            });
          continue;
        }
        push({
          start: past.start,
          end: past.end,
          spend: past.spend,
          ceiling: null,
          kind: "inferred",
        });
      }
      if (state.win) {
        pushCurrent();
      }
      for (const f of seg.future) {
        push({
          start: f.start,
          end: f.end,
          spend: null,
          ceiling,
          kind: "ahead",
          endsEarly: f.endsEarly,
        });
      }
    } else if (state.win && r) {
      pushCurrent();
    }

    rows.sort((a, b) => a.start - b.start);
    return { p, ceiling, rows, reading: r };
  }

  function remainingParts(ceiling) {
    const r = cycleReading();
    const proj = projectToRenewal();
    const effectiveCeiling = proj?.ceiling ?? ceiling ?? r?.ceiling ?? null;
    const leftWindow = proj?.leftThisCycle != null
      ? proj.leftThisCycle
      : r?.ceiling != null
        ? Math.max(0, r.ceiling - r.s.credits)
        : 0;
    const natural = proj && effectiveCeiling ? Math.max(0, proj.naturalOpenings) * effectiveCeiling : 0;
    const bank = proj?.bank ?? state.resetCards?.available ?? 0;
    const cards = effectiveCeiling && bank > 0 ? bank * effectiveCeiling : 0;
    const credits = state.purchased?.unlimited ? 0 : Math.max(0, state.purchased?.balance || 0);
    const total = leftWindow + natural + cards + credits;
    return { leftWindow, natural, cards, bank, credits, total, proj, reading: r, ceiling: effectiveCeiling };
  }

  function periodSummaryCardsHtml(spendCredits, allowance, leftTotal) {
    const L = t();
    const ceiling = allowance?.credits;
    const measured = allowance?.source === "daily-ratio";
    return `
      <div class="summary-cards">
        <div class="summary-card primary">
          <div class="eyebrow">${esc(L.measured)} · ${esc(L.periodCardSpent)}</div>
          <div class="amount">${usd(spendCredits)}</div>
        </div>
        <div class="summary-card">
          <div class="eyebrow ${measured ? "" : "is-inferred"}">${esc(measured ? L.measured : L.inferred)} · ${esc(windowCopy("periodCardOne") )}</div>
          <div class="amount small ${measured ? "" : "is-inferred"}">${ceiling ? usd(ceiling) : "—"}</div>
          <div class="hint">${esc(windowCopy("periodCardOneSub"))}</div>
        </div>
        <div class="summary-card infer">
          <div class="eyebrow is-inferred">${esc(L.inferred)} · ${esc(L.periodCardLeft)}</div>
          <div class="amount small is-inferred">${leftTotal > 0 ? usd(leftTotal) : "—"}</div>
          <div class="hint">${esc(L.periodCardLeftSub)}</div>
        </div>
      </div>`;
  }

  function subscriptionFormulaHtml(spendCredits, parts, grant) {
    const L = t();
    if (!(spendCredits >= 0) || !(parts?.total > 0)) return "";
    const extras = [
      parts.cards > 0 ? `${L.remCards} ${usd(parts.cards)}` : "",
      parts.credits > 0 ? `${L.remCredits} ${usd(parts.credits)}` : "",
    ].filter(Boolean).join(lang === "zh" ? "、" : ", ");
    const remainingWindows = parts.leftWindow + parts.natural;
    const total = spendCredits + parts.total;
    const windows = grant?.weekly
      ? Math.max(1, (parts.proj?.naturalOpenings || 0) + 1)
      : grant?.windows || 0;
    return `<div class="formula-note">${esc(L.subscriptionFormula(usd(spendCredits), usd(remainingWindows), usd(total), extras, windows, !!grant?.weekly))}</div>`;
  }

  function remainingStackHtml(parts) {
    const L = t();
    const segs = [
      [parts.leftWindow, "window", windowCopy("remWindow")],
      [parts.natural, "natural", L.remNatural],
      [parts.cards, "cards", L.remCards],
      [parts.credits, "credits", L.remCredits],
    ].filter(([v]) => v > 0);
    if (!segs.length && !state.purchased?.unlimited) return "";

    const bars = segs
      .map(([v, cls]) => {
        return `<div class="stack-seg ${cls}" style="flex:${v}" title="${esc(usd(v))}"></div>`;
      })
      .join("");

    const keys = segs
      .map(
        ([v, cls, label]) =>
          `<span class="row"><span class="lab"><i class="k-${cls}"></i>${esc(label)}</span><span class="val">${esc(usd(v))}</span></span>`,
      )
      .join("");

    return `
      <div class="section stack-wrap">
        <div class="section-head">
          <h2>${esc(L.remainingStack)}</h2>
        </div>
        <p class="section-note">${esc(windowCopy("remainingStackSub"))}</p>
        <div class="stack-bar">${bars || `<div class="stack-seg natural" style="flex:1;opacity:.35"></div>`}</div>
        <div class="stack-keys">${keys}</div>
        ${
          state.purchased?.unlimited
            ? `<div class="readout" style="margin-top:8px"><span>${esc(L.creditsUnlimited)}</span></div>`
            : ""
        }
        ${
          parts.total > 0
            ? `<div class="stack-total-row"><span>${esc(L.periodCardLeft)}</span><b>${esc(usd(parts.total))}</b></div>`
            : ""
        }
      </div>`;
  }

  function periodWindowTableHtml(winInfo) {
    const L = t();
    const { rows, ceiling } = winInfo;
    // Only rows with measured spend, or the live window, or a clearly labeled future estimate.
    const show = rows.filter(
      (r) => (r.spend != null && r.spend > 0) || r.kind === "now" || (r.kind === "ahead" && ceiling),
    );
    if (!show.length) return "";

    const kindLabel = (row) =>
      row.kind === "now"
        ? row.spansStart
          ? `${L.timelineNow} · ${L.timelineSpill}`
          : L.timelineNow
        : row.kind === "ahead"
          ? L.timelineAhead
          : row.kind === "remembered"
            ? L.timelineRemembered
            : row.kind === "spill"
              ? L.timelineSpill
              : L.timelineInferred;

    const body = show
      .map((r) => {
        const when = `${shortDate(dayKey(r.start))} → ${shortDate(dayKey(r.end))}`;
        const spend =
          r.kind === "ahead"
            ? ceiling
              ? `<span class="inf">${esc("~" + usd(ceiling))}</span>`
              : "—"
            : r.spend > 0
              ? esc(usd(r.spend))
              : "—";
        // Ceiling only when we actually know this window's size — never paste today's size on old rows.
        const ceil =
          r.kind === "now" && ceiling
            ? esc(usd(ceiling))
            : r.ceiling != null
              ? esc(usd(r.ceiling))
              : r.kind === "ahead" && ceiling
                ? `<span class="inf">${esc("~" + usd(ceiling))}</span>`
                : "—";
        return `<tr class="cyc-${r.kind === "ahead" ? "ahead" : r.kind === "now" ? "now" : "past"}">
          <td>${esc(when)}</td>
          <td class="cyc-note">${esc(kindLabel(r))}</td>
          <td class="n strong">${spend}</td>
          <td class="n">${ceil}</td>
        </tr>`;
      })
      .join("");

    // Measured rows only — the reader's calculator check against the headline spend.
    const listedTotal = show.reduce((a, r) => a + (r.kind !== "ahead" && r.spend > 0 ? r.spend : 0), 0);
    const totalRow =
      listedTotal > 0
        ? `<tr class="cyc-total">
            <td></td>
            <td class="cyc-note">${esc(L.winTableTotal)}</td>
            <td class="n strong">${esc(usd(listedTotal))}</td>
            <td class="n">—</td>
          </tr>`
        : "";

    return `
      <div class="section">
        <div class="section-head">
          <h2>${esc(L.winTableTitle)}<em>${esc(L.winTableSub)}</em></h2>
        </div>
        <div class="scroll" tabindex="0" role="region" aria-label="${esc(L.winTableTitle)}"><table>
          <thead><tr>
            <th>${esc(L.thWhen)}</th><th>${esc(L.thWinKind)}</th>
            <th class="n">${esc(L.thSpend)}</th><th class="n">${esc(L.thWinCeil)}</th>
          </tr></thead>
          <tbody>${body}${totalRow}</tbody>
        </table></div>
      </div>`;
  }

  /*
   * Bars = measured $ spend per usage window (past + now only).
   * Line = cumulative billing-period spend, with a dashed projection to renewal.
   * Future windows are not drawn as empty boxes — they only appear in the remaining stack.
   */
  function periodCompositeChartHtml(winInfo, proj) {
    const L = t();
    const { p, rows } = winInfo;
    const spentRows = rows.filter((r) => r.kind !== "ahead" && (r.spend > 0 || r.kind === "now"));
    if (!spentRows.length && !proj) return "";

    const width = 640;
    const height = 210;
    const left = 48;
    const right = 16;
    const top = 20;
    const bottom = 40;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const t0 = p.startMs;
    const t1 = Math.max(p.fullEndMs, p.endMs, Date.now());
    const span = Math.max(t1 - t0, DAY_MS);
    const xAt = (ms) => left + ((Math.min(Math.max(ms, t0), t1) - t0) / span) * plotW;

    const byDate = new Map(state.days.map((d) => [d.date, d.credits]));
    const periodDays = Math.max(1, Math.round((t1 - t0) / DAY_MS));
    const todayKey = dayKey(Date.now());
    let running = 0;
    // The zero start is its own point at the period's first instant — not the first day
    // drawn empty. Folding the two together drops the opening day's spend from the whole
    // line, and the line stops meeting the headline total.
    const linePts = [[xAt(t0), 0]];
    for (let i = 0; i <= periodDays; i++) {
      const key = addDays(dayKey(t0), i);
      if (key > todayKey) break;
      running += byDate.get(key) || 0;
      linePts.push([xAt(dayMs(key) + DAY_MS * 0.5), running]);
    }
    if (linePts.length === 1) linePts.push([xAt(Date.now()), running]);

    const measuredSpend = running;
    const projected = proj?.projected ?? measuredSpend;
    const maxBar = Math.max(...spentRows.map((r) => r.spend || 0), 1);
    const maxY = Math.max(maxBar, projected, measuredSpend, 1) * 1.06;
    const y = (v) => top + plotH - (v / maxY) * plotH;

    // Even gaps between bars; width from calendar span but never a hairline.
    const bars = spentRows
      .map((r) => {
        const x1 = xAt(r.start);
        const x2 = xAt(Math.max(r.end, r.start + DAY_MS));
        const gap = 4;
        const rawW = x2 - x1;
        const w = Math.max(10, rawW - gap);
        const value = r.spend || 0;
        const h = Math.max(4, (value / maxY) * plotH);
        const yy = y(value);
        const isNow = r.kind === "now";
        const fill = isNow ? "var(--measured)" : "var(--measured-soft)";
        const tip = [
          isNow
            ? r.spansStart
              ? `${L.timelineNow} · ${L.timelineSpill}`
              : L.timelineNow
            : r.kind === "spill"
              ? L.timelineSpill
              : L.timelineInferred,
          `${shortDate(dayKey(r.start))} → ${shortDate(dayKey(r.end))}`,
          usd(value),
        ].join(" · ");
        return `<rect x="${(x1 + gap / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"
          fill="${fill}" rx="0"><title>${esc(tip)}</title></rect>`;
      })
      .join("");

    const poly = linePts.map(([px, v]) => `${px.toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const last = linePts[linePts.length - 1];
    const lastV = last[1];
    let projLine = "";
    if (proj && projected >= lastV - 0.01) {
      const endX = xAt(t1);
      const endY = y(projected);
      projLine = `<line x1="${last[0].toFixed(1)}" y1="${y(lastV).toFixed(1)}" x2="${endX.toFixed(1)}" y2="${endY.toFixed(1)}"
        stroke="var(--inferred)" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round">
        <title>${esc(`${L.inferred} ${usd(projected)}`)}</title></line>
        <circle cx="${endX.toFixed(1)}" cy="${endY.toFixed(1)}" r="3.5" fill="var(--inferred)" />
        <text x="${(endX - 5).toFixed(1)}" y="${Math.max(top + 14, endY - 9).toFixed(1)}" text-anchor="end"
          style="font-family:var(--mono);font-size:11px;fill:var(--inferred-text)">${esc(usd(projected))}</text>`;
    }

    const nowX = xAt(Date.now());
    const gridYs = [0.25, 0.5, 0.75]
      .map((f) => {
        const yy = y(maxY * f);
        return `<line x1="${left}" x2="${width - right}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--rule)" stroke-width="1" opacity=".55" />`;
      })
      .join("");

    return `
      <div class="section chart">
        <div class="section-head">
          <h2>${esc(L.chartComposite)}<em>${esc(L.chartCompositeSub)}</em></h2>
        </div>
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(L.chartComposite)}">
          ${gridYs}
          <line x1="${left}" x2="${width - right}" y1="${y(0)}" y2="${y(0)}" stroke="var(--rule)" />
          ${bars}
          <polyline points="${poly}" fill="none" stroke="var(--ink)" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
            <title>${esc(L.chartLineSpend)}</title>
          </polyline>
          <circle cx="${last[0].toFixed(1)}" cy="${y(lastV).toFixed(1)}" r="3.5" fill="var(--ink)" />
          <text x="${(last[0] - 7).toFixed(1)}" y="${Math.max(top + 14, y(lastV) - 9).toFixed(1)}" text-anchor="end"
            style="font-family:var(--mono);font-size:11px;fill:var(--ink)">${esc(usd(lastV))}</text>
          ${projLine}
          <line x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="${top}" y2="${y(0)}" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="2 3" />
          <text x="${nowX.toFixed(1)}" y="${top - 5}" text-anchor="middle">${esc(L.today)}</text>
          <text x="${left}" y="${height - 12}">${esc(shortDate(dayKey(t0)))}</text>
          <text x="${width - right}" y="${height - 12}" text-anchor="end">${esc(shortDate(dayKey(t1)))}</text>
        </svg>
        <div class="legend-key">
          <span><i class="key-solid soft"></i>${esc(L.chartBarPast)}</span>
          <span><i class="key-solid"></i>${esc(L.chartBarNow)}</span>
          <span><i class="key-line"></i>${esc(L.chartLineSpend)}</span>
          <span><i class="key-line dash"></i>${esc(L.inferred)}</span>
        </div>
      </div>`;
  }

  function dailyChartHtml(days, from, to) {
    const L = t();
    const rate = calendarDayRate(from);
    const keys = [];
    for (let key = from; key <= to; key = addDays(key, 1)) keys.push(key);
    const byDate = new Map(days.map((d) => [d.date, d.credits]));
    const values = keys.map((key) => byDate.get(key) || 0);
    const width = 640;
    const height = 138;
    const left = 36;
    const right = 12;
    const top = 14;
    const bottom = 25;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const max = Math.max(...values, rate?.rate || 0, 1);
    const slot = plotWidth / Math.max(1, keys.length);
    const barWidth = Math.max(0, slot - 2);
    const y = (value) => top + plotHeight - (value / max) * plotHeight;
    const today = dayKey(Date.now());
    /*
     * A day the feed has not reported is not a day that cost nothing. Charting it as $0.00
     * turns silence into an assertion, so an unreported today says so instead.
     */
    const reported = new Set(state.days.map((d) => d.date));
    const bars = keys
      .map((key, i) => {
        const value = values[i];
        const barHeight = (value / max) * plotHeight;
        const unreported = key === today && !reported.has(key);
        const title = unreported
          ? `${key} — ${L.todayMissing}`
          : `${key} ${usd(value)}${key === today ? ` — ${L.partialDay}` : ""}`;
        return `<rect x="${left + i * slot + 1}" y="${y(value)}" width="${barWidth}" height="${barHeight}" rx="0" fill="var(--measured)"${key === today ? ' opacity=".45"' : ""}><title>${esc(title)}</title></rect>`;
      })
      .join("");
    const reference = rate
      ? `<line x1="${left}" x2="${width - right}" y1="${y(rate.rate)}" y2="${y(rate.rate)}" stroke="var(--inferred)" stroke-width="1.5" stroke-dasharray="5 4"><title>${esc(L.chartDailySub(usd(rate.rate)))}</title></line>
         <text x="${width - right}" y="${y(rate.rate) - 4}" text-anchor="end">${esc(usd(rate.rate))}</text>`
      : "";

    return `
      <div class="chart">
        <h2>${esc(L.chartDaily)}${rate ? `<em>${esc(L.chartDailySub(usd(rate.rate)))}</em>` : ""}</h2>
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(L.chartDaily)}">
          <line class="axis" x1="${left}" x2="${width - right}" y1="${y(0)}" y2="${y(0)}"><title>Axis</title></line>
          ${reference}
          ${bars}
          <text x="${left}" y="${height - 5}">${esc(shortDate(keys[0]))}</text>
          <text x="${width - right}" y="${height - 5}" text-anchor="end">${esc(shortDate(keys[keys.length - 1]))}</text>
        </svg>
      </div>
    `;
  }

  function modelChartHtml(s) {
    const L = t();
    const rows = [...s.models.values()].filter((m) => m.credits > 0).sort((a, b) => b.credits - a.credits);
    const width = 640;
    const height = Math.max(72, rows.length * 30 + 18);
    const labelWidth = 172;
    const barWidth = 255;
    const max = rows[0]?.credits || 1;
    const marks = rows
      .map((m, i) => {
        const y = 18 + i * 30;
        const w = (m.credits / max) * barWidth;
        const perTurn = m.turns ? usd(m.credits / m.turns) : "—";
        const name = modelName(m.name);
        return `<text class="label-strong" x="0" y="${y + 12}">${esc(name)}</text>
          <rect x="${labelWidth}" y="${y}" width="${w}" height="18" rx="0" fill="var(--measured)"><title>${esc(`${name} · ${usd(m.credits)} · ${perTurn}/turn`)}</title></rect>
          <text class="label-strong" x="${labelWidth + w + 7}" y="${y + 12}">${esc(usd(m.credits))}</text>
          <text class="muted" x="${labelWidth + w + 7}" y="${y + 23}">${esc(`${perTurn}/turn`)}</text>`;
      })
      .join("");

    return `
      <div class="chart">
        <h2>${esc(L.chartModel)}</h2>
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(L.chartModel)}">${marks}</svg>
      </div>
    `;
  }

  function surfaceChartHtml(s) {
    const L = t();
    const rows = [...s.surfaces.values()].filter((row) => row.credits > 0).sort((a, b) => b.credits - a.credits);
    if (!rows.length) return "";
    const width = 640;
    const height = Math.max(72, rows.length * 30 + 18);
    const labelWidth = 172;
    const barWidth = 255;
    const max = rows[0].credits || 1;
    const byTurns = s.surfaceByTurns && !s.surfaceByPercent;
    const marks = rows
      .map((row, i) => {
        const y = 18 + i * 30;
        const w = (row.credits / max) * barWidth;
        const name = surfaceName(row.name);
        const perTurn = row.turns ? usd(row.credits / row.turns) : "";
        return `<text class="label-strong" x="0" y="${y + 12}">${esc(name)}</text>
          <rect x="${labelWidth}" y="${y}" width="${w}" height="18" rx="0" fill="var(--measured)"><title>${esc(`${name} · ${usd(row.credits)}`)}</title></rect>
          <text class="label-strong" x="${labelWidth + w + 7}" y="${y + 12}">${esc(usd(row.credits))}</text>
          ${perTurn ? `<text class="muted" x="${labelWidth + w + 7}" y="${y + 23}">${esc(`${perTurn}/turn`)}</text>` : ""}`;
      })
      .join("");

    return `
      <div class="chart">
        <h2>${esc(L.chartSurface)}<em>${esc(byTurns ? L.chartSurfaceSubTurns : L.chartSurfaceSub)}</em></h2>
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(L.chartSurface)}">${marks}</svg>
      </div>
    `;
  }

  function periodHeadHtml(s) {
    const L = t();
    const p = periodRange();
    const grant = periodAllowances();
    const reading = cycleReading();
    const ceiling = reading?.ceiling;
    const winInfo = periodWindowRows();
    const parts = remainingParts(ceiling);
    const cards = resetCardsUsedValue(ceiling);
    const projection = projectPeriodSpend();
    const leftTotal = parts.total;

    /*
     * One narrative, one sentence per idea: what the period tops out at and what that is
     * made of, and where the window count comes from. narrCap quotes the measured spend
     * plus the remaining allowance that can open before renewal.
     * Today's one-allowance size only prices the future, never historical window dollars.
     */
    const footnotes = [
      projection && projection.cap != null
        ? L.narrCap(
            usd(projection.cap),
            usd(projection.measured),
            usd(Math.max(0, projection.cap - projection.measured)),
          )
        : null,
      projection ? L.projWindowOnly : null,
      projection?.early ? L.projEarly : null,
      grant && ceiling
        ? grant.resets > 0
          ? L.narrWindows(grant.windows, grant.resets, usd(ceiling))
          : L.periodNoReset
        : null,
      cards.n > 0 ? L.resetCardsUsed(cards.n, usd(cards.credits)) : null,
    ].filter(Boolean);

    return `
      ${windowStatusHtml()}
      <div class="section">${periodSummaryCardsHtml(s.credits, reading?.allowance, leftTotal)}</div>
      ${subscriptionFormulaHtml(s.credits, parts, grant)}
      ${remainingStackHtml(parts)}
      ${
        spentRowsHaveData(winInfo) || projection
          ? periodCompositeChartHtml(winInfo, projection)
          : `<div class="section readout"><span>${esc(state.win?.placeholder ? L.projNoWindow : L.projNotYet)}</span></div>`
      }
      ${
        footnotes.length
          ? `<div class="section"><div class="readout">${footnotes.map((t) => `<span>${esc(t)}</span>`).join("")}</div></div>`
          : ""
      }
      ${periodWindowTableHtml(winInfo)}
      <div class="readout meta">
        <span>${esc(L.periodSpan(shortDate(p.from), shortDate(p.to)))}</span>
        <span>${esc(L.activeDays)} <b>${esc(s.days)}</b></span>
        <span>${esc(L.dailyAvg)} <b>${usd(s.days ? s.credits / s.days : 0)}</b></span>
        <span>${esc(L.turnsTotal(int(s.turns)))}</span>
      </div>
      <div class="why">${esc(L.periodWhy)}</div>
    `;
  }

  function spentRowsHaveData(winInfo) {
    return (winInfo.rows || []).some((r) => r.kind !== "ahead" && (r.spend > 0 || r.kind === "now"));
  }

  function splitHtml(s) {
    const L = t();
    const total = s.uncachedCredits + s.cachedCredits + s.outputCredits || 1;
    const parts = [
      [L.uncachedIn, s.uncachedCredits, s.uncached, "var(--measured)"],
      [L.cachedIn, s.cachedCredits, s.cached, "var(--measured-soft)"],
      [L.outputTok, s.outputCredits, s.output, "var(--ink-2)"],
    ];

    return `
      <h2>${esc(L.whereItWent)}<em>${esc(L.whereSub)}</em></h2>
      <div class="bars">
        ${parts.map(([, v, , colour]) => `<div style="flex:${v / total};background:${colour}"></div>`).join("")}
      </div>
      <div class="keys">
        ${parts
          .map(
            ([name, v, tk, colour]) =>
              `<span><i class="swatch" style="background:${colour}"></i>${esc(name)} <b>${usd(v)}</b> · ${pct(v / total)} · ${tokenCount(tk)}</span>`,
          )
          .join("")}
      </div>
    `;
  }

  function dayTableHtml(days) {
    const L = t();
    const rows = [...days].reverse();
    const anyLoc = rows.some((d) => d.loc?.added || d.loc?.removed);

    return `
      <div class="scroll" tabindex="0" role="region" aria-label="${esc(L.byDay)}"><table>
        <thead><tr>
          <th>${esc(L.thDate)}</th><th class="n">${esc(L.thCost)}</th><th class="n">${esc(L.thCredits)}</th>
          <th class="n">${esc(L.thTurns)}</th><th class="n">${esc(L.thPerTurn)}</th>
          <th class="n">${esc(L.thTokens)}</th><th class="n">${esc(L.thCache)}</th>
          ${anyLoc ? `<th class="n">${esc(L.thLoc)}</th>` : ""}
        </tr></thead>
        <tbody>${rows
          .map((d, idx) => {
            const inTok = d.cached + d.uncached;
            const dayId = `day-${idx}`;
            const hasModels = d.models.length > 0;
            return `<tr>
              <td>
                ${hasModels ? `<button type="button" class="row-toggle" data-day-drill="${dayId}"><span class="rchev">▸</span> ${esc(d.date)}</button>` : esc(d.date)}
              </td>
              <td class="n strong">${usd(d.credits)}</td>
              <td class="n">${int(d.credits)}</td>
              <td class="n">${d.turns ? esc(int(d.turns)) : "—"}</td>
              <td class="n">${d.turns ? usd(d.credits / d.turns) : "—"}</td>
              <td class="n">${tokenCount(d.uncached + d.cached + d.output)}</td>
              <td class="n">${inTok ? pct(d.cached / inTok) : "—"}</td>
              ${anyLoc ? `<td class="n">${d.loc?.added ? "+" + int(d.loc.added) : "—"}</td>` : ""}
            </tr>
            ${hasModels ? `
            <tr id="sub-${dayId}" class="sub-row">
              <td colspan="${anyLoc ? 8 : 7}">
                <div class="drilldown-box">
                  ${modelTableHtml(summarize([d]))}
                </div>
              </td>
            </tr>` : ""}`;
          })
          .join("")}</tbody>
      </table></div>
    `;
  }
  function modelTableHtml(s) {
    const L = t();
    const rows = [...s.models.values()].filter((m) => m.credits > 0).sort((a, b) => b.credits - a.credits);
    return `
      <div class="scroll" tabindex="0" role="region" aria-label="${esc(L.byModel)}"><table>
        <thead><tr>
          <th>${esc(L.thModel)}</th><th class="n">${esc(L.thCost)}</th><th class="n">${esc(L.thShare)}</th>
          <th class="n">${esc(L.thTurns)}</th><th class="n">${esc(L.thPerTurn)}</th><th class="n">${esc(L.thTokens)}</th>
        </tr></thead>
        <tbody>${rows
          .map(
            (m) => `<tr>
              <td>${esc(modelName(m.name))}</td>
              <td class="n strong">${usd(m.credits)}</td>
              <td class="n">${pct(m.credits / (s.credits || 1))}</td>
              <td class="n">${m.turns ? esc(turnCount(m.turns)) : "—"}</td>
              <td class="n">${m.turns ? usd(m.credits / m.turns) : "—"}</td>
              <td class="n">${tokenCount(m.tokens)}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table></div>
    `;
  }

  function masterLedgerHtml(days, s) {
    const L = t();

    return `
      <details class="master-ledger">
        <summary class="ledger-sum">
          <span class="left"><span class="chev">▸</span>${esc(L.seeNumbers)}</span>
          <span class="ledger-badge">${esc(L.ledgerBadge)}</span>
        </summary>
        <div class="ledger-body">
          <div class="sub-tabs" role="tablist">
            <button type="button" class="sub-tab-btn is-active" data-subtab="daily">${esc(L.subTabDaily)}</button>
            <button type="button" class="sub-tab-btn" data-subtab="model">${esc(L.subTabModels)}</button>
          </div>

          <div class="ledger-pane is-active" data-pane="daily">
            ${dayTableHtml(days)}
          </div>

          <div class="ledger-pane" data-pane="model">
            ${modelTableHtml(s)}
          </div>

        </div>
      </details>
    `;
  }

  function notesHtml(days) {
    const L = t();
    const win = state.win;
    const reading = cycleReading();
    const allowance = reading?.allowance;
    const first = days[0];
    // Any opening that is not exactly midnight UTC shares its day with the window before it.
    const opensMidDay = win && win.startAt % DAY_MS !== 0;
    const overlap = state.view === "cycle" && opensMidDay && first && first.date === dayKey(win.startAt);

    const items = [
      [L.n1(RATE_CARD_VERIFIED), false],
      [L.n2(USD_PER_CREDIT), false],
      ...(state.ent?.ambiguous
        ? [[L.ambiguousSubscription(state.ent.candidates?.length || state.ent.liveSubscriptions, state.ent.structure), true]]
        : state.ent?.liveSubscriptions > 1 && !state.ent?.choiceRequired
          ? [[L.twoSubscriptions(state.ent.liveSubscriptions, win?.planType || "?"), true]]
          : []),
      ...(win?.placeholder ? [[L.placeholderWindow, true]] : []),
      // Every dollar on this panel stops where the feed stops. Say so before the reader
      // reconciles today's spending against a number that could not contain it.
      ...(!state.days.some((d) => d.date === dayKey(Date.now())) ? [[L.todayMissing, true]] : []),
      ...(win && !win.placeholder && !win.resetBank ? [[L.bankEmpty, false]] : []),
      ...(days.some((d) => d.pricedAtTopRate) ? [[L.topRateWarning, true]] : []),
      ...(allowance?.dropped ? [[L.allowanceChanged(allowance.dropped), true]] : []),
      ...(allowance?.source === "daily-ratio"
        ? [[L.allowanceNote(allowance.samples), false]]
        : allowance?.source === "depletion"
          ? [[L.allowanceDepletionNote, false]]
          : win && !win.inferable
            ? [[L.n11, true]]
            : [[windowCopy("n3"), false]]),
      // A conflict between the two allowance sources is shown next to the headline, not here.
      ...(overlap ? [[windowCopy("n4")(clock(win.startAt), first.date, usd(first.credits)), true]] : []),
      ...(days.some((d) => d.models.some((m) => m.speed && m.speed !== "standard"))
        ? [[L.nTurnSplit, false]]
        : []),
      [L.n5, false],
      [L.n6, false],
      [L.n8, false],
      ...(days.some((d) => d.surfaceSource === "turns") && !days.some((d) => d.surfaceSource === "percent")
        ? [[L.nSurfaceTurns, true]]
        : []),
      [L.n9, false],
      ...(state.legacyModels.length ? [[L.nLegacy(state.legacyModels.join(", ")), true]] : []),
      ...(state.unpricedFast.length ? [[L.n10(state.unpricedFast.join(", ")), true]] : []),
      ...(state.unknownModels.length ? [[L.n7(state.unknownModels.join(", ")), true]] : []),
    ];

    return `
      <div class="notes">
        <h3>${esc(L.notesTitle)}</h3>
        <ul>${items.map(([text, warn]) => `<li class="${warn ? "warn" : ""}">${esc(text)}</li>`).join("")}</ul>
      </div>
    `;
  }

  // Sub-day windows are real on some plans, and "0.2-day cycle" is not a sentence.
  function windowLabel() {
    const L = t();
    const days = state.win.windowSec / 86400;
    if (days < 1) return L.windowHours(state.win.email ? `${state.win.planType} · ${state.win.email}` : state.win.planType, Math.round(state.win.windowSec / 3600));

    const shown = Number.isInteger(days) ? String(days) : days.toFixed(1);
    const who = state.win.email ? `${state.win.planType} · ${state.win.email}` : state.win.planType;
    return L.window(who, shown);
  }

  function triggerHtml() {
    const L = t();
    return `
      <button class="trigger ${state.loading ? "busy" : ""}" title="${esc(`${L.openPanel} · v${scriptVersion()}`)}">
        <span class="trigger-ps">$</span>
        <span class="trigger-name">${state.loading ? esc(L.loading) : esc(L.brand)}</span>
        <span class="cursor"></span>
      </button>
    `;
  }

  function subscriptionChoiceHtml() {
    const L = t();
    const candidates = [...(state.ent?.candidates || [])].sort((a, b) => a.renewsAt - b.renewsAt);
    if (!state.ent?.ambiguous || !candidates.length) return "";

    return `
      <div class="subscription-picker">
        <div class="eyebrow is-inferred">${esc(L.period)}</div>
        <h2>${esc(L.chooseSubscription)}</h2>
        <p>${esc(L.chooseSubscriptionHint)}</p>
        <div class="subscription-options" role="group" aria-label="${esc(L.chooseSubscription)}">
          ${candidates
            .map((candidate) => {
              const end = new Date(candidate.renewsAt);
              const start = rollBack(end, candidate.billingPeriod === "yearly" ? 12 : 1);
              return `<button type="button" class="subscription-option" data-subscription-choice="${esc(candidate.accountId)}">
                <strong>${esc(L.chooseRenewal(dateOnly(candidate.renewsAt)))}</strong>
                <span>${esc(L.periodSpan(dayKey(start.getTime()), dayKey(candidate.renewsAt)))}</span>
              </button>`;
            })
            .join("")}
        </div>
      </div>`;
  }

  function selectedSubscriptionHtml() {
    const L = t();
    if (state.ent?.choiceLocked || !state.ent?.choiceRequired) return "";
    return `<div class="subscription-picked">
      <span>${esc(L.chosenRenewal(dateOnly(state.ent.renewsAt)))}</span>
      <button type="button" class="mem-clear" data-act="change-subscription">${esc(L.changeSubscription)}</button>
    </div>`;
  }

  function renewalUnavailableHtml() {
    const L = t();
    return `<div class="subscription-picker">
      <div class="eyebrow is-inferred">${esc(L.period)}</div>
      <h2>${esc(L.renewalUnavailable)}</h2>
      <p>${esc(L.renewalUnavailableHint)}</p>
    </div>`;
  }




  function sheetHtml() {
    const L = t();

    if (state.loading) return `<div class="status">${esc(L.loading)}</div>`;
    if (state.error) return `<div class="status bad">${esc(state.error)}</div>`;

    if (state.view === "period" && !hasRenewalDate()) {
      return `<div class="sheet">${state.ent?.ambiguous ? subscriptionChoiceHtml() : renewalUnavailableHtml()}</div>`;
    }

    const { days, s, from, to } = currentSlice();
    const subscriptionControl = state.ent?.ambiguous
      ? subscriptionChoiceHtml()
      : state.view === "period"
        ? selectedSubscriptionHtml()
        : "";
    if (!days.length) {
      return `<div class="sheet">${subscriptionControl}<div class="status">${esc(state.view === "cycle" ? windowCopy("emptyCycle") : L.emptyPeriod)}
        <div class="hint">${esc(L.emptyHint)}</div></div></div>`;
    }

    const forecast = state.view === "cycle" ? forecastHtml() : "";

    return `
      <div class="sheet">
        ${subscriptionControl}
        ${state.view === "cycle" ? gaugeHtml() : periodHeadHtml(s)}
        ${forecast ? `<div class="rule"></div>${forecast}` : ""}
        <div class="rule major"></div>
        <div class="cards">${statCards(days, s)
          .map(
            (c) =>
              `<div class="cell"><div class="k">${esc(c.label)}</div><div class="v">${esc(c.value)}</div><div class="s">${esc(c.sub)}</div></div>`,
          )
          .join("")}</div>
        <div class="rule"></div>
        ${splitHtml(s)}
        <div class="rule major"></div>
        ${dailyChartHtml(days, from, to)}
        <div class="rule"></div>
        ${modelChartHtml(s)}
        ${surfaceChartHtml(s)}
        ${notesHtml(days)}
        ${masterLedgerHtml(days, s)}
      </div>
    `;
  }
  function focusedControlSelector(element) {
    if (!element) return "";
    if (element.classList?.contains("panel")) return ".panel";
    if (element.classList?.contains("cost-input")) return ".cost-input";
    if (element.dataset?.view) return `[data-view="${element.dataset.view}"]`;
    if (element.dataset?.lang) return `[data-lang="${element.dataset.lang}"]`;
    if (element.dataset?.act) return `[data-act="${element.dataset.act}"]`;
    return "";
  }

  function closePanel() {
    state.open = false;
    state.restoreTriggerFocus = true;
    render();
  }

  function render() {
    const root = state.root;
    if (!root) return;
    const L = t();
    const refocus = state.open ? focusedControlSelector(root.activeElement) : "";
    const opening = state.open && !wasOpen;

    root.innerHTML = `
      <style>${CSS}</style>
      ${triggerHtml()}
      ${
        state.open
          ? `<div class="scrim">
              <div class="panel" role="dialog" aria-modal="true" tabindex="-1" aria-label="${esc(L.title)}">
                <div class="masthead">
                  <div>
                    <div class="wordmark">${esc(L.title)} <em>${esc(L.from)}</em><span class="cursor"></span></div>
                    <div class="subhead">${state.win ? `${esc(windowLabel())} · ` : ""}<span class="version">v${esc(scriptVersion())}</span></div>
                  </div>
                  <span class="grow"></span>
                  <div class="controls">
                    <div class="seg">
                      <button data-view="cycle" aria-pressed="${state.view === "cycle"}">${esc(windowCopy("cycle"))}</button>
                      <button data-view="period" aria-pressed="${state.view === "period"}">${esc(L.period)}</button>
                    </div>
                    <div class="seg">
                      <button data-lang="zh" aria-pressed="${lang === "zh"}">中</button>
                      <button data-lang="en" aria-pressed="${lang === "en"}">EN</button>
                    </div>
                    <button class="ghost" data-act="reload" title="${esc(L.reload)}" aria-label="${esc(L.reload)}">↻</button>
                    <button class="ghost" data-act="close" title="${esc(L.close)}" aria-label="${esc(L.close)}">✕</button>
                  </div>
                </div>
                ${sheetHtml()}
              </div>
            </div>`
          : ""
      }
    `;

    // Opening the panel is what triggers the first and only fetch.
    root.querySelector(".trigger").onclick = () => {
      state.open = true;
      state.restoreTriggerFocus = false;
      if (!state.loaded && !state.loading) load();
      else render();
    };

    /*
     * Move focus into the dialog when it opens — but only then. Every render replaces the
     * whole shadow root, so focusing on each one would yank a keyboard user back to the
     * dialog root every time they switch view or language.
     */
    const panel = root.querySelector(".panel");
    if (state.restoreTriggerFocus) root.querySelector(".trigger")?.focus();
    else if (refocus) root.querySelector(refocus)?.focus();
    else if (panel && opening) panel.focus();
    state.restoreTriggerFocus = false;
    wasOpen = state.open;

    root.querySelectorAll("[data-view]").forEach((b) => {
      b.onclick = () => {
        state.view = b.dataset.view;
        render();
      };
    });

    root.querySelectorAll("[data-lang]").forEach((b) => {
      b.onclick = () => {
        lang = b.dataset.lang;
        localStorage.setItem(LANG_KEY, lang);
        render();
      };
    });

    root.querySelectorAll("[data-subscription-choice]").forEach((b) => {
      b.onclick = () => {
        localStorage.setItem(subscriptionChoiceKey(), b.dataset.subscriptionChoice);
        if (!state.loading) load();
      };
    });

    const cost = root.querySelector(".cost-input");
    if (cost)
      cost.onchange = () => {
        setMonthlyCost(cost.value);
        render();
      };

    const clearMem = root.querySelector('[data-act="clear-mem"]');
    if (clearMem)
      clearMem.onclick = () => {
        if (!window.confirm(t().cycleMemClearConfirm)) return;
        clearCurrentMemory();
        render();
      };

    const changeSubscription = root.querySelector('[data-act="change-subscription"]');
    if (changeSubscription)
      changeSubscription.onclick = () => {
        localStorage.removeItem(subscriptionChoiceKey());
        state.ent = {
          ...state.ent,
          renewsAt: null,
          billingPeriod: null,
          accountId: "",
          ambiguous: true,
        };
        state.memory = null;
        render();
      };

    const close = root.querySelector('[data-act="close"]');
    if (close) close.onclick = closePanel;


    root.querySelectorAll("[data-day-drill]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.dayDrill;
        const sub = root.querySelector("#sub-" + id);
        if (sub) {
          const open = sub.classList.toggle("is-open");
          btn.classList.toggle("is-open", open);
        }
      };
    });

    root.querySelectorAll("[data-subtab]").forEach((btn) => {
      btn.onclick = () => {
        const target = btn.dataset.subtab;
        root.querySelectorAll(".sub-tab-btn").forEach((b) => {
          b.classList.toggle("is-active", b.dataset.subtab === target);
        });
        root.querySelectorAll(".ledger-pane").forEach((p) => {
          p.classList.toggle("is-active", p.dataset.pane === target);
        });
      };
    });

    const reload = root.querySelector('[data-act="reload"]');
    if (reload)
      reload.onclick = () => {
        if (!state.loading) load();
      };

    const scrim = root.querySelector(".scrim");
    if (scrim)
      scrim.onclick = (e) => {
        if (e.target === scrim) closePanel();
      };
  }

  // ── Boot ────────────────────────────────────────────────────────────────

  /*
   * @match is chatgpt.com/*, so the script is present during SPA navigation. The trigger
   * only belongs on the usage / analytics settings pages. smoketest.html is treated as
   * on-page so the harness can drive the panel without a Codex URL.
   */
  function isUsagePage() {
    const path = location.pathname || "";
    if (path.includes("smoketest.html")) return true;
    return /\/codex(?:\/[^/]+)*\/settings\/(analytics|usage)(?:\/|$)/i.test(path);
  }

  function syncUsagePage() {
    const on = isUsagePage();
    if (!on && state.open) {
      state.open = false;
      state.restoreTriggerFocus = false;
      wasOpen = false;
    }
    const host = document.getElementById("how-much-i-get");
    if (host) host.hidden = !on;
    if (state.root) render();
  }

  function watchLocation() {
    const notify = () => queueMicrotask(syncUsagePage);
    const wrap = (method) => {
      const orig = history[method];
      if (typeof orig !== "function" || orig.__hmigWrapped) return;
      function wrapped(...args) {
        const ret = orig.apply(this, args);
        notify();
        return ret;
      }
      wrapped.__hmigWrapped = true;
      history[method] = wrapped;
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", notify);
    window.addEventListener("hashchange", notify);
    if (window.navigation && typeof window.navigation.addEventListener === "function") {
      window.navigation.addEventListener("navigate", notify);
    }
  }

  function mount() {
    let host = document.getElementById("how-much-i-get");
    if (!host) {
      host = document.createElement("div");
      host.id = "how-much-i-get";
      document.body.appendChild(host);
    }
    state.root = host.shadowRoot || host.attachShadow({ mode: "open" });
  }

  async function load() {
    state.loading = true;
    state.error = "";
    render();

    try {
      state.token = state.token || (await getToken());
      if (!state.token) throw new Error(t().noToken);

      const [usage, check, resetDetail] = await Promise.all([
        api("/backend-api/wham/usage", state.token),
        soft("/backend-api/accounts/check/v4-2023-04-27", state.token),
        // Optional: per-card status so used reset cards in this billing period can be counted.
        soft("/backend-api/wham/rate-limit-reset-credits", state.token),
      ]);

      state.win = readWindow(usage);
      const selectedAccountId = state.win?.accountId || storedSubscriptionChoice();
      state.ent = check ? readEntitlement(check, state.win?.planType, selectedAccountId) : null;
      if (state.ent) state.ent.choiceLocked = !!state.win?.accountId;
      state.purchased = readPurchasedCredits(usage);
      if (!state.win) throw new Error(t().noWindow);

      /*
       * Reach back far enough to cover the billing period, the current cycle, and one whole
       * cycle before it. That history supports the usage-window ledger, so fetching a partial
       * slice of it would quietly understate the period context.
       */
      const today = dayKey(Date.now());
      const anchors = [state.win, weeklyWindow(), shortWindow()]
        .filter(Boolean)
        .flatMap((window) => [window.startAt, window.startAt - window.windowSec * 1000])
        .map(dayKey);
      const from = [periodRange().from, ...anchors].sort()[0];

      const pRange = periodRange();
      state.resetCards = parseResetCredits(
        resetDetail,
        state.win.resetBank,
        pRange.startMs,
        Math.max(pRange.endMs, Date.now()),
      );
      // Keep the window object in sync with the reconciled available count.
      state.win.resetBank = state.resetCards.available;

      const data = await fetchAll(state.token, from, today);
      state.days = data.days;
      state.unknownModels = data.unknownModels;
      state.legacyModels = data.legacyModels;
      state.unpricedFast = data.unpricedFast;
      state.fetchedFrom = data.fetchedFrom;
      state.freshnessMs = data.freshnessMs;
      state.loaded = true;
      syncCycleMemory();

      // A freshly reset cycle is empty — land on the period rather than an empty panel.
      const cycleFrom = dayKey(state.win.startAt);
      if (state.view === "cycle" && !data.days.some((d) => d.date >= cycleFrom)) state.view = "period";

      state.loading = false;
      render();
    } catch (e) {
      console.error("[How Much I Get]", e);
      state.loading = false;
      state.error = e?.message || String(e);
      render();
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.open) closePanel();
  });

  mount();
  watchLocation();
  syncUsagePage();
})();
