// ==UserScript==
// @name         How Much I Get From Codex
// @name:zh-CN   How Much I Get From Codex · 你从 Codex 到底拿到多少
// @namespace    https://github.com/bigbobro
// @version      3.0.0
// @homepageURL  https://github.com/bigbobro/how-much-i-get-from-codex
// @supportURL   https://github.com/bigbobro/how-much-i-get-from-codex/issues
// @downloadURL  https://github.com/bigbobro/how-much-i-get-from-codex/raw/main/how-much-i-get-from-codex.user.js
// @updateURL    https://github.com/bigbobro/how-much-i-get-from-codex/raw/main/how-much-i-get-from-codex.user.js
// @description  Work out the Codex spending ceiling OpenAI never tells you. Exact per-model pricing from the official rate card, the cycle limit inferred from the used percentage, and a projection of what is left before your subscription renews. Reads nothing until you open it.
// @description:zh-CN 算出 OpenAI 从不告诉你的那个数字。按官方 rate card 逐模型精确计价，用已用百分比反推本周期额度，再推算到订阅续费日之前你还能拿到多少。不点开就不发任何请求。
// @match        https://chatgpt.com/codex/cloud/settings/analytics*
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
 *   /wham/usage                       → percent of this cycle used, but no denominator
 *   /wham/usage/daily-…-breakdown     → per-model token counts, but no money
 *
 * Put them together:
 *   credits the API reports (or tokens × rate card) = spend        exact
 *   spend ÷ used percent                            = the ceiling  inferred
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

  // OpenAI has never published this rate. It comes from the credit purchase page.
  const USD_PER_CREDIT = 0.04;

  const DAY_MS = 86400000;
  const LANG_KEY = "hmig-lang";
  const COST_KEY = "hmig-monthly-cost";
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

      cycle: "This usage window",
      period: "This subscription",
      calendarMonth: "This month",

      spent: "Spent",
      ceiling: "Ceiling",
      measured: "Measured",
      inferred: "Inferred",
      noCeiling: (p) => `${p}% used — not enough yet to infer a ceiling`,
      twoSubscriptions: (n, plan) => `This login holds ${n} active subscriptions. Every figure here belongs to the ${plan} one, whichever the Codex API answers for. That is not always the account the profile menu names.`,
      ambiguousSubscription: (n, structure) =>
        `This login has ${n} active ${structure} subscriptions, so the Codex seat cannot be matched to one renewal date. This month is shown instead; renewal-dependent figures are hidden.`,
      measuredFrom: (n) => `read off ${n} day${n === 1 ? "" : "s"} of usage`,
      allowanceConflict: (daily, window) =>
        `Daily usage measures this allowance as ${daily}, while the live window percentage implies ${window}. The measured daily value wins; the mismatch is left visible for diagnosis.`,
      overspent: (n) => `${n} allowances used this cycle, so it reset partway through. "Left" below means what remains of the current one.`,
      allowanceChanged: (n) => `${n} earlier day${n === 1 ? "" : "s"} imply a different allowance, so the plan changed in this range. Only days matching today are counted.`,
      topRateWarning: "Some days have no per-model split and no reported credits, so they are priced at the dearest model's rate. Those days read high.",
      placeholderWindow: "This plan does not run the rate limit window: used percent stays at 0 and the reset time slides along with the clock. The boundaries are not real, so the cycle view and anything counted off it are hidden. The allowance and the spending still hold.",
      allowanceNote: (n) => `How the allowance is read: each day's cost, divided by the percentage of the allowance the API says that day used. All ${n} day${n === 1 ? "" : "s"} here point at the same value.`,
      windowTooShort: "The allowance window is shorter than a day, but usage only arrives in whole days — there is nothing to divide.",
      leftSuffix: (p) => `left (${p})`,
      windowSpan: (a, b) => `${a} → ${b}`,
      resetInPre: "resets in",
      resetInPost: "days",
      perDaySuffix: "/day",
      runOut: (d) => `On this pace you run out ${d}, before the reset`,
      endAt: (a) => `On this pace this usage window ends around ${a}`,

      untilRenewal: "Left before renewal",
      renewalOn: (d) => `renews ${d}`,
      renewalMath: (a, n, l, partial) =>
        `${a} left in this usage window, then ${n} more allowance${n > 1 ? "s" : ""} of about ${l}` +
        (partial ? " — a window hands over the whole amount even with days left to spend it" : ""),
      renewalOneCycle: (a) => `${a} left — the subscription renews before this usage window does`,

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
      periodCardLeft: "still obtainable before renewal",
      periodCardLeftSub: "at today's allowance size — a ceiling on grants, not a spend forecast",
      remainingStack: "What you can still draw before renewal",
      remainingStackSub: "future layers use today's one-allowance size",
      remWindow: "left in this usage window",
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
      narrPaceCapped: (days, rate, end, paced) => `${days} days in at ${rate}/day — pace alone would reach ${paced} by ${end}, but the allowance tops out first, so pace does not decide.`,
      narrPaceUnder: (days, rate, end, paced) => `${days} days in at ${rate}/day runs to about ${paced} by ${end}, short of the cap.`,
      narrPacePlain: (days, rate, end, paced) => `${days} days in at ${rate}/day runs to about ${paced} by ${end}.`,
      projEarly: "Less than a fifth of the period has gone; this is a coarse extrapolation",
      projNoWindow: "What the period costs depends on how many allowances open before renewal, and this plan does not report its window boundaries, so it cannot be worked out. The spend and the allowance count below are measured.",
      projNotYet: "Not enough completed days to extrapolate the period",
      projPayback: (x) => `${x}× projected for the period`,
      chartDaily: "Spend per day",
      chartDailySub: (r) => `dashed line is ${r} per calendar day`,
      chartModel: "Where the money goes by model",
      unattributed: "Unattributed",
      seeNumbers: "See the numbers",
      today: "today",
      partialDay: "today is still filling — this bar will grow",

      onPaceInline: (a, p, d) => `at the pace of the usage window that ended ${d} you would use ${a} of it (${p})`,

      cycles: "Usage window by window",
      cyclesSub: "remembered rows are local; inferred rows assume a fixed window length and can drift after an early reset",
      thWhen: "Window",
      thSpend: "Spend",
      cycleNow: "now",
      cycleRemembered: "remembered",
      cycleInferred: "inferred",
      cycleSuspect: "spend looks like more than one allowance",
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
      monthWhy: "No renewal date available, so this falls back to the calendar month.",
      activeDays: "Days with usage",
      dailyAvg: "Average on those days",
      turnsTotal: (n) => `${n} turns`,

      cTotal: "Total",
      cPerTurn: "Per turn",
      cPerKLoc: "Per 1000 lines",
      cPriciestDay: "Priciest day",
      cPriciestTurnDay: "Dearest turns",
      cTopModel: "Biggest spender",
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
      n4: (t, d, a) => `The cycle opened at ${t}, but usage only arrives in whole UTC days. The ${d} row counts that entire day — ${a} — and some of it was spent before the cycle opened. How much cannot be known, but it pushes both the spend and the ceiling high.`,
      n10: (m) => `Fast mode has no published multiplier for ${m}, so it is priced at the standard rate — the real cost is higher.`,
      n11: "The allowance window here is shorter than a day. Usage is only reported by whole days, so no ceiling can be inferred from it and the projections are hidden.",
      n5: "Codex, ChatGPT Work and ChatGPT for Excel draw on the same pool, but this API only sees Codex — so the spend, and the ceiling, come out low.",
      n6: "Scoped to the current seat only. Other people in the workspace are not counted.",
      n7: (m) => `Not in the rate card, so its tokens are not priced: ${m}. Any reported remainder stays visible as Unattributed.`,
      n8: "There is no per-repository breakdown in the API, so spend cannot be split by project.",
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

      cycle: "本份用量",
      period: "本期订阅",
      calendarMonth: "本自然月",

      spent: "已花",
      ceiling: "额度",
      measured: "实测",
      inferred: "推算",
      noCeiling: (p) => `已用 ${p}%，还不够反推额度`,
      twoSubscriptions: (n, plan) => `这个登录下有 ${n} 份有效订阅。这里的数字都属于 ${plan} 这一份，也就是 Codex 接口当前回答的那份。它跟档案菜单显示的账号常常不是同一个。`,
      ambiguousSubscription: (n, structure) =>
        `这个登录下有 ${n} 份有效的${structure === "workspace" ? "工作区" : "个人"}订阅，无法把 Codex seat 唯一对应到一个续费日。这里退回显示本自然月，并隐藏依赖续费日的数字。`,
      measuredFrom: (n) => `由 ${n} 天用量测出`,
      allowanceConflict: (daily, window) =>
        `每日用量测出的本份额度是 ${daily}，实时窗口百分比反推的是 ${window}。这里采用每日实测值，同时保留差异供排查。`,
      overspent: (n) => `这份用量窗口已经用掉 ${n} 份额度，说明中途重置过。下面的「未用」是指当前这一份还剩多少。`,
      allowanceChanged: (n) => `另外 ${n} 天推出来的额度跟今天不一样，说明这段时间里换过套餐。只采用与今天一致的那些天。`,
      topRateWarning: "有些天既没有按模型的拆分，接口也没给 credits，只能按最贵的模型计价，这些天会偏高。",
      placeholderWindow: "这个套餐不走限流窗口：已用百分比一直是 0%，重置时间跟着当前时间往前滑。边界不是真的，所以周期视图和据此数出来的份数都已隐藏。额度和花费照常。",
      allowanceNote: (n) => `额度这么读出来：拿每天的花费，除以接口给的「这天用掉额度的百分之几」。这里 ${n} 天的数据都指向同一个值。`,
      windowTooShort: "这个账号的额度窗口不到一天，而用量只能按整天取 —— 没有可除的东西。",
      leftSuffix: (p) => `未用（${p}）`,
      windowSpan: (a, b) => `${a} → ${b}`,
      resetInPre: "还有",
      resetInPost: "天重置",
      perDaySuffix: " 日均",
      runOut: (d) => `按这个速度，${d} 就用完了，赶不到重置`,
      endAt: (a) => `按这个速度，这份用量窗口结束时约花掉 ${a}`,

      untilRenewal: "续费前还能拿",
      renewalOn: (d) => `${d} 续费`,
      renewalMath: (a, n, l, partial) =>
        `本份用量还剩 ${a}，之后还会开出 ${n} 份额度，每份约 ${l}` +
        (partial ? " —— 窗口一开就是满额发放，哪怕只剩几天用" : ""),
      renewalOneCycle: (a) => `本份用量还剩 ${a} —— 订阅比重置先到`,

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
      periodCardOne: "当前一份",
      periodCardOneSub: "只描述本份用量窗口，不是整期平均",
      periodCardLeft: "续费前还能拿",
      periodCardLeftSub: "按今天的一份大小估 —— 是能拿的上限，不是会花的预测",
      remainingStack: "续费前还能动用的",
      remainingStackSub: "后面几层按「当前一份」大小估算",
      remWindow: "本份用量窗口剩余",
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
      narrPaceCapped: (days, rate, end, paced) => `按已过 ${days} 天、日均 ${rate} 的节奏，到 ${end} 本会冲到 ${paced} —— 但额度先到顶，节奏说了不算。`,
      narrPaceUnder: (days, rate, end, paced) => `按已过 ${days} 天、日均 ${rate} 的节奏，到 ${end} 约 ${paced}，够不着封顶。`,
      narrPacePlain: (days, rate, end, paced) => `按已过 ${days} 天、日均 ${rate} 推到 ${end}，约 ${paced}。`,
      projEarly: "账期才过了不到两成，这个外推还很粗",
      projNoWindow: "整期花多少，取决于续费前会开出几份额度；而这个套餐不报窗口边界，所以算不出来。下面的花费和份数都是实测的。",
      projNotYet: "已完成的天数还不够外推整期",
      projPayback: (x) => `整期预计 ${x}×`,
      chartDaily: "每天花了多少",
      chartDailySub: (r) => `虚线是自然日日均 ${r}`,
      chartModel: "钱花在哪个模型上",
      unattributed: "未归因",
      seeNumbers: "看具体数字",
      today: "今天",
      partialDay: "今天还没走完，这一天的数还在涨",

      onPaceInline: (a, p, d) => `按 ${d} 结束那份用量窗口的用法，你实际会用掉其中 ${a}（${p}）`,

      cycles: "一份额度一份看",
      cyclesSub: "「本地记录」存在本机；「推算」按固定窗口长度往回切，中途 reset 后可能偏",
      thWhen: "窗口",
      thSpend: "花费",
      cycleNow: "现在",
      cycleRemembered: "本地记录",
      cycleInferred: "推算",
      cycleSuspect: "花费像不止一份额度",
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
      monthWhy: "拿不到续费日期，退回按自然月统计。",
      activeDays: "有用量的天数",
      dailyAvg: "这些天的日均",
      turnsTotal: (n) => `共 ${n} turns`,

      cTotal: "总花费",
      cPerTurn: "平均每 turn",
      cPerKLoc: "每千行代码",
      cPriciestDay: "花得最多的一天",
      cPriciestTurnDay: "单 turn 最贵的一天",
      cTopModel: "最烧钱的模型",
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

      emptyCycle: "这份用量窗口还没花钱。",
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
      n4: (t, d, a) => `周期是 ${t} 开始的，但用量只能按整个 UTC 天取。${d} 这一行算的是一整天（${a}），其中一部分花在周期开始之前。具体多少无从得知，但它会把花费和推算额度一起抬高。`,
      n10: (m) => `${m} 的 fast mode 没有公布倍率，这里按标准价计，实际花费只会更高。`,
      n11: "这个账号的额度窗口不到一天，而用量只按整天上报，没法从中反推额度，相关推算已隐藏。",
      n5: "Codex、ChatGPT Work、ChatGPT for Excel 共用一个额度池，但这个接口只看得到 Codex —— 所以花费偏低，推算额度也跟着偏低。",
      n6: "只统计当前 seat，不含 workspace 里其他人。",
      n7: (m) => `不在 rate card 里，token 没法计价：${m}。接口报出的剩余花费仍会显示为「未归因」。`,
      n8: "接口没有按仓库拆的维度，所以分不出「哪个项目花了多少」。",
      n9: "不点开就不发任何请求，关掉之后也不会在后台跑。",

      reload: "重新读取",
      close: "关闭",
      openPanel: "算算我拿到多少",
    },
  };

  const savedLang = localStorage.getItem(LANG_KEY);
  let lang = savedLang || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
  const t = () => I18N[lang];
  const modelName = (name) => (name === "__unattributed__" ? t().unattributed : name);

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
    const w = usage?.rate_limit?.primary_window;
    if (!w) return null;

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

    const windowSec = Number(w.limit_window_seconds);
    const resetAt = Number(w.reset_at) * 1000;
    if (!Number.isFinite(windowSec) || windowSec <= 0 || !Number.isFinite(resetAt)) return null;

    // Window length is read, never assumed. The same plan tier ships weekly on one account
    // and monthly on another, and Plus/Pro also run a 5-hour window.
    return {
      usedPercent: Math.min(100, Math.max(0, Number(w.used_percent) || 0)),
      limitReached: !!usage.rate_limit.limit_reached,
      windowSec,
      inferable: windowSec >= MIN_INFERABLE_WINDOW_SEC,
      /*
       * Some plans never open the window at all: used_percent stays at zero and reset_at is
       * simply now plus the window length, sliding forward on every request. Its boundaries
       * are fiction, so anything anchored to them would be reinvented on each fetch.
       */
      placeholder:
        !(Number(w.used_percent) > 0) && Math.abs(resetAt - (Date.now() + windowSec * 1000)) < 90000,
      resetAt,
      startAt: resetAt - windowSec * 1000,
      resetBank: bank,
      planType: usage.plan_type,
      email: usage.email || "",
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
  function readEntitlement(check, planType) {
    const wanted = planType === "plus" || planType === "pro" || planType === "free" ? "personal" : "workspace";

    const live = Object.values(check?.accounts || {})
      .filter((a) => a?.entitlement?.has_active_subscription && a.entitlement.renews_at)
      .filter((a) => Number.isFinite(Date.parse(a.entitlement.renews_at)));

    if (!live.length) return null;

    const matching = live.filter((a) => a.account?.structure === wanted);
    const pick = matching.length === 1 ? matching[0] : live.length === 1 ? live[0] : null;

    /*
     * One login can hold both a personal Plus and a workspace seat. The Codex endpoints
     * answer for whichever context Codex itself is in, and that does not have to agree with
     * the account the profile menu names — a ChatGPT-Account-ID header does not override it.
     * Counting the live subscriptions is what lets the panel warn instead of quietly
     * reporting a different subscription than the reader has in mind.
     */
    const distinct = new Set(live.map((a) => a.account?.account_id).filter(Boolean));

    if (!pick) {
      return {
        renewsAt: null,
        billingPeriod: null,
        liveSubscriptions: distinct.size || live.length,
        accountId: "",
        structure: wanted,
        ambiguous: true,
      };
    }

    return {
      renewsAt: Date.parse(pick.entitlement.renews_at),
      billingPeriod: pick.entitlement.billing_period,
      liveSubscriptions: distinct.size,
      accountId: pick.account?.account_id || "",
      structure: pick.account?.structure || "",
      ambiguous: false,
    };
  }

  /*
   * Three endpoints, joined on date. Everything is scoped to the current seat —
   * without workspace_user=true the counts come back for the whole workspace while
   * the used percentage stays personal, and the two do not divide.
   */
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
    for (const row of percents?.data || []) {
      const pct = Object.values(row.product_surface_usage_values || {}).reduce((a, b) => a + (b || 0), 0);
      if (pct > 0) percentByDate.set(row.date, pct);
    }
    const modelPercentByDate = new Map((percents?.data || []).map((r) => [r.date, r.models || []]));
    const breakdownByDate = new Map((breakdown?.data || []).map((r) => [r.date, r]));

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
    ent: null,
    days: [],
    unknownModels: [],
    legacyModels: [],
    unpricedFast: [],
    fetchedFrom: "",
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
    const ceiling = r.ceiling > 0 ? r.ceiling : null;
    const spend = r.s.credits;

    if (bucket.open && !sameWindowStart(bucket.open.startAt, startAt)) {
      bucket.closed.push({
        startAt: bucket.open.startAt,
        resetAt: bucket.open.resetAt,
        ceiling: bucket.open.ceiling > 0 ? bucket.open.ceiling : null,
        spend: Number(bucket.open.spend) || 0,
        closedAt: Date.now(),
      });
      if (bucket.closed.length > MEMORY_KEEP) bucket.closed = bucket.closed.slice(-MEMORY_KEEP);
      bucket.open = null;
    }

    if (!bucket.open || !sameWindowStart(bucket.open.startAt, startAt)) {
      bucket.open = { startAt, resetAt, ceiling, spend, updatedAt: Date.now() };
    } else {
      bucket.open.resetAt = resetAt;
      bucket.open.spend = spend;
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

  // The billing period the subscription is actually in, or the calendar month if unknown.
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
  function periodAllowances() {
    // Without a renewal date there is no billing period, and counting allowances "per
    // payment" would be a claim about something we cannot see. Same for a placeholder
    // window: its openings would be counted from a boundary that moves on every fetch.
    if (!hasRenewalDate() || state.win?.placeholder) return null;

    const W = state.win ? state.win.windowSec * 1000 : 0;
    if (!W) return null;

    const p = periodRange();

    // Counted arithmetically rather than by stepping, so no loop bound can quietly become a
    // bound on the answer. An opening landing exactly on the period start is not counted
    // here — it is the window already running when the period began, added once below.
    const past = state.win.startAt > p.startMs ? Math.ceil((state.win.startAt - p.startMs) / W) : 0;
    const ahead = p.endMs > state.win.resetAt ? Math.ceil((p.endMs - state.win.resetAt) / W) : 0;

    return { windows: past + ahead + 1, resets: past + ahead, ...p };
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
  function measuredAllowance() {
    const all = state.days.filter((d) => d.percent > 0 && d.credits > 0);
    if (!all.length) return null;

    const winFrom = state.win ? dayKey(state.win.startAt) : null;
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
   * Live window size: spend in this usage window ÷ the rate-limit used%. Integer used% and
   * mid-day openings make this the noisier source, so it is a fallback and a cross-check for
   * the daily-ratio measurement rather than a silent override.
   */
  function windowAllowance(spendCredits, usedPercent, limitReached) {
    if (!(spendCredits > 0) || !state.win?.inferable) return null;
    if (limitReached || usedPercent >= 99.5) {
      return usedPercent > 0 ? spendCredits / (usedPercent / 100) : spendCredits;
    }
    if (usedPercent >= 20) return spendCredits / (usedPercent / 100);
    return null;
  }

  /*
   * One authority for allowance value and provenance. Consumers never infer provenance from
   * whether a number happens to exist: the daily ratio is measured, the window division is
   * inferred, and a material disagreement remains attached to the chosen value.
   */
  function allowanceReading(spendCredits, usedPercent, limitReached) {
    const daily = measuredAllowance();
    const window = windowAllowance(spendCredits, usedPercent, limitReached);

    if (daily) {
      const rel = window > 0 ? Math.abs(daily.credits - window) / Math.max(daily.credits, window) : 0;
      return {
        ...daily,
        source: "daily-ratio",
        conflict: rel > 0.05 ? { daily: daily.credits, window } : null,
      };
    }

    let credits = window;
    if (!(credits > 0) && state.win?.inferable) {
      if (usedPercent > 0 && spendCredits > 0) credits = spendCredits / (usedPercent / 100);
      else if (limitReached && spendCredits > 0) credits = spendCredits;
    }

    return credits > 0
      ? { credits, source: "window-percent", samples: 0, dropped: 0, conflict: null }
      : null;
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
    const allowance = allowanceReading(s.credits, used, state.win.limitReached);
    return { days, s, used, ceiling: allowance?.credits ?? null, allowance };
  }

  const spendInDays = (fromKey, toKey) =>
    toKey < fromKey ? 0 : summarize(state.days.filter((d) => d.date >= fromKey && d.date <= toKey)).credits;

  // The period's pace is visible in its own spending, even when the API withholds a ceiling.
  function projectPeriodSpend() {
    const p = periodRange();
    const periodDays = Math.round((p.fullEndMs - p.startMs) / DAY_MS);
    const todayKey = dayKey(Date.now());
    const lastCompleteKey = addDays(todayKey, -1);
    const basisDays = Math.max(0, (dayMs(lastCompleteKey) - dayMs(p.from)) / DAY_MS + 1);
    const basisSpend = spendInDays(p.from, lastCompleteKey);
    const measured = spendInDays(p.from, todayKey);
    const activeDays = state.days.filter((d) => d.date >= p.from && d.date <= lastCompleteKey && d.credits > 0).length;
    const remainingDays = periodDays - basisDays;

    if (basisDays < 3 || basisSpend <= 0 || activeDays < 2 || remainingDays <= 0) return null;

    /*
     * With a placeholder window there is no way to know how many allowances still open
     * before renewal, so there is no cap to hold the pace down — and an uncapped pace is
     * exactly the figure that overshoots what the account can reach. Report what was
     * measured and say the rest is unknowable, rather than print a number with nothing
     * behind it.
     */
    if (state.win?.placeholder) return null;

    /*
     * A daily average run forward is the wrong shape for this. Spending is capped per window,
     * not per day: burn the whole allowance on the first morning and the rest of that window
     * yields nothing, no matter how fast you were going. Extrapolating the rate through the
     * cap produces totals the account could not reach even in principle — on the account this
     * was found on, $2,568 against a structural maximum of $1,530.
     *
     * What actually decides the period is how many allowances open before renewal. The rate
     * only says whether you will get through them.
     */
    const rate = basisSpend / basisDays;
    const paced = Math.max(measured, basisSpend + rate * remainingDays);

    const proj = projectToRenewal();
    const ceiling = cycleReading()?.ceiling;
    const obtainable = proj && proj.allowance != null ? proj.allowance : null;
    const cap = obtainable != null ? measured + obtainable : null;

    const projected = cap != null ? Math.min(paced, cap) : paced;

    return {
      p,
      periodDays,
      todayKey,
      lastCompleteKey,
      basisDays,
      basisSpend,
      measured,
      activeDays,
      remainingDays,
      rate,
      paced,
      cap,
      ceiling,
      openings: proj?.openings ?? null,
      capBinds: cap != null && paced > cap,
      projected,
      early: basisDays / periodDays < 0.2,
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
   * When a full past cycle exists, only the most recent one sets the expected pace.
   * Averaging older cycles would smear over exactly the change you want to see.
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
     * uncovered segment would report a partial sum as a whole cycle, and that segment is
     * exactly the one the pace estimate leans on.
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
    if (hasRenewalDate() && state.ent.renewsAt > state.win.resetAt) {
      openings = Math.ceil((state.ent.renewsAt - state.win.resetAt) / W);
      for (let i = 0; i < Math.min(openings, 10); i++) {
        const start = state.win.resetAt + i * W;
        const end = Math.min(start + W, state.ent.renewsAt);
        future.push({ start, end, endsEarly: end < start + W });
      }
    }

    const trusted = past.filter((p) => p.covered);
    const lastFull = trusted.length ? trusted[trusted.length - 1] : null;

    return {
      past,
      future,
      openings,
      lastFull,
      current: { start: state.win.startAt, end: state.win.resetAt, spend: r.s.credits, ceiling: r.ceiling },
    };
  }

  /*
   * How much allowance is still coming before the subscription renews, two ways:
   *   allowance — every remaining cycle used to the ceiling
   *   expected  — every remaining cycle used the way the last full one was
   */
  function projectToRenewal() {
    const seg = cycleSegments();
    const r = cycleReading();
    if (!seg || !hasRenewalDate() || !r) return null;

    const now = Date.now();
    if (state.ent.renewsAt <= now) return null;
    if (!r.ceiling) return { renewsAt: state.ent.renewsAt, ceiling: null, seg };

    const W = state.win.windowSec * 1000;
    const leftThisCycle = Math.max(0, r.ceiling - r.s.credits);

    const elapsed = Math.max(0.5 * DAY_MS, now - state.win.startAt);
    const perMs = r.s.credits / elapsed;
    const restOfThisCycle = Math.min(leftThisCycle, perMs * Math.max(0, state.win.resetAt - now));

    /*
     * Granted and usable are different quantities. A window opening hands over the whole
     * ceiling even when only two days of the billing period remain — what limits you then is
     * time, not allowance. So the allowance counts openings at full value, while the
     * expectation counts the hours you actually have, at the pace of the last finished cycle.
     */
    // Every unused reset card is one more allowance that can be opened before renewal.
    const bank = state.resetCards?.available ?? state.win.resetBank ?? 0;
    const openings = seg.openings + bank;
    const usableTime = Math.max(0, state.ent.renewsAt - state.win.resetAt) / W;
    // Prefer a locally remembered closed window — its boundaries were observed, not guessed.
    const lastMem = state.memory?.closed?.length
      ? state.memory.closed[state.memory.closed.length - 1]
      : null;
    const hasRememberedBasis = !!lastMem && Number.isFinite(lastMem.spend) && lastMem.spend >= 0;
    const basis = hasRememberedBasis
      ? lastMem.spend
      : seg.lastFull
        ? seg.lastFull.spend
        : Math.min(r.ceiling, perMs * W);
    const basisEnd = lastMem?.resetAt || (seg.lastFull ? seg.lastFull.end : null);

    // Purchased credit balance is spendable after the plan pool; add it to what is still left.
    const creditLeft = state.purchased?.unlimited ? 0 : Math.max(0, state.purchased?.balance || 0);
    const windowLeft = leftThisCycle + openings * r.ceiling;

    return {
      renewsAt: state.ent.renewsAt,
      ceiling: r.ceiling,
      seg,
      leftThisCycle,
      openings,
      bank,
      naturalOpenings: seg.openings,
      hasPartial: usableTime % 1 > 0.001,
      creditLeft,
      allowance: windowLeft + creditLeft,
      expected: restOfThisCycle + usableTime * basis + creditLeft,
      basis,
      basisIsLastFull: hasRememberedBasis || !!seg.lastFull,
      basisEnd,
    };
  }

  // ── Styles ──────────────────────────────────────────────────────────────
  /*
   * Two accents carry meaning rather than decoration:
   *   blue  = measured, straight from the API
   *   amber = inferred by this script, and always drawn dashed
   */
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    :host {
      --paper: #FBFAF8; --ink: #17161A; --ink-2: #6C6862; --ink-3: #75716A;
      --rule: #E4E0D9; --panel: #FFFFFF;
      --measured: #1B3FD4; --measured-soft: #A8B8EE;
      --inferred: #B9762A; --inferred-text: #96601F; --inferred-soft: #F6EBDC;
      --alarm: #B3261E;
      --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", system-ui, sans-serif;
      --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --paper: #131315; --ink: #ECE9E3; --ink-2: #9A958D; --ink-3: #847F77;
        --rule: #2C2B2E; --panel: #1A1A1D;
        --measured: #7C9BFF; --measured-soft: #4A5C9E;
        --inferred: #E0A055; --inferred-text: #E0A055; --inferred-soft: #2A2118;
        --alarm: #F2857C;
      }
    }

    /* the trigger — an instrument label, not a call-to-action blob */
    .trigger {
      position: fixed; top: 66vh; right: 18px; z-index: 2147483646;
      display: flex; align-items: stretch; padding: 0; overflow: hidden;
      background: var(--panel); color: var(--ink);
      border: 1px solid var(--rule); border-radius: 5px;
      box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px -14px rgba(0,0,0,.4);
      font-family: var(--sans); cursor: pointer;
      transition: box-shadow .18s, transform .18s;
    }
    .trigger:hover { box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 12px 30px -14px rgba(0,0,0,.5); transform: translateY(-1px); }
    .trigger:focus-visible { outline: 2px solid var(--measured); outline-offset: 2px; }
    .trigger-mark { width: 3px; background: var(--inferred); flex: none; }
    .trigger-body { padding: 6px 12px 6px 10px; text-align: left; }
    .trigger-kicker { font-size: 9px; letter-spacing: .16em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; line-height: 1.4; display: block; }
    .trigger-name { font-size: 12.5px; font-weight: 650; letter-spacing: -.015em; line-height: 1.25; display: block; }
    .trigger.busy .trigger-name { color: var(--ink-3); }

    .scrim {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(18,16,14,.36);
      display: grid; place-items: start center; padding: 22px 16px 60px;
      overflow: auto; font-family: var(--sans);
    }
    .panel {
      width: 100%; max-width: 960px; background: var(--paper); color: var(--ink);
      border: 1px solid var(--rule); border-radius: 8px;
      box-shadow: 0 30px 80px -20px rgba(0,0,0,.55);
      font-size: 13px; line-height: 1.55; overflow: hidden;
    }

    .masthead { display: flex; align-items: flex-start; gap: 14px; padding: 15px 20px 13px; border-bottom: 1px solid var(--rule); flex-wrap: wrap; }
    .wordmark { font-size: 16px; font-weight: 680; letter-spacing: -.025em; line-height: 1.15; }
    .wordmark em { font-style: normal; color: var(--ink-3); font-weight: 400; }
    .subhead { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; margin-top: 3px; }
    .grow { flex: 1; }
    .controls { display: flex; align-items: center; gap: 6px; }

    .seg { display: flex; border: 1px solid var(--rule); border-radius: 5px; overflow: hidden; }
    .seg button { border: 0; background: transparent; color: var(--ink-2); font: inherit; font-size: 11px; padding: 5px 11px; cursor: pointer; white-space: nowrap; }
    .seg button + button { border-left: 1px solid var(--rule); }
    .seg button[aria-pressed="true"] { background: var(--ink); color: var(--paper); font-weight: 600; }
    .seg button:focus-visible { outline: 2px solid var(--measured); outline-offset: -2px; }

    .ghost { border: 1px solid var(--rule); background: transparent; color: var(--ink-2); width: 26px; height: 26px; border-radius: 5px; cursor: pointer; font-size: 13px; line-height: 1; display: grid; place-items: center; }
    .ghost:hover { color: var(--ink); }
    .ghost:focus-visible { outline: 2px solid var(--measured); outline-offset: 1px; }

    .panel:focus { outline: none; }
    .sheet { padding: 22px 22px 28px; }

    /* three tiers of separation: conclusion, diagnosis, ledger */
    .rule { height: 1px; background: var(--rule); margin: 22px 0; }
    .rule.major { margin: 28px 0; }

    .section { margin-top: 22px; }
    .section:first-child { margin-top: 0; }
    .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 0 0 10px; flex-wrap: wrap; }
    .section-head h2 { margin: 0; }
    .section-note { font-size: 11.5px; color: var(--ink-2); line-height: 1.45; max-width: 70ch; }

    .gauge-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
    .eyebrow { font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; font-weight: 600; color: var(--ink-3); margin-bottom: 5px; }
    .eyebrow.is-inferred { color: var(--inferred); }
    .amount { font-family: var(--mono); font-size: 38px; font-weight: 620; letter-spacing: -.04em; line-height: 1.05; font-variant-numeric: tabular-nums; }
    .amount.small { font-size: 23px; font-weight: 560; }
    .amount.is-inferred {
      display: inline-block; color: var(--inferred);
      border-bottom: 1.5px dashed var(--inferred); padding-bottom: 2px;
    }
    .gauge-head .right { text-align: right; }

    /* every inferred figure wears the same two marks: amber, and a dash */
    .inf {
      display: inline-block; color: var(--inferred-text); font-family: var(--mono);
      border-bottom: 1px dashed var(--inferred); padding-bottom: 1px;
    }

    /* the one sentence that states a conclusion rather than a quantity */
    .verdict { margin: 14px 0 10px; font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
    .verdict.alarm { color: var(--alarm); }

    .legend-key { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 10px; font-size: 10.5px; color: var(--ink-3); align-items: center; }
    .key-solid, .key-dash, .key-line {
      display: inline-block; width: 14px; height: 7px; margin-right: 6px; vertical-align: 0; border-radius: 1px;
    }
    .key-solid { background: var(--measured); }
    .key-solid.soft { background: var(--measured-soft); }
    .key-dash { border: 1px dashed var(--inferred); background: var(--inferred-soft); }
    .key-line { height: 0; border-top: 2px solid var(--ink); border-radius: 0; width: 16px; vertical-align: 3px; }
    .key-line.dash { border-top-style: dashed; border-top-color: var(--inferred); }

    .gauge { margin: 18px 0 10px; }
    .track {
      position: relative; height: 12px; border-radius: 2px; overflow: hidden;
      background: var(--inferred-soft); border: 1px dashed var(--inferred);
    }
    .track::after {
      content: ""; position: absolute; inset: 0; opacity: .32;
      background-image: repeating-linear-gradient(-45deg, transparent 0 4px, var(--inferred) 4px 5px);
    }
    .track.blank { background: transparent; }
    .track.blank::after { display: none; }
    .fill { position: relative; z-index: 1; height: 100%; background: var(--measured); transition: width .5s cubic-bezier(.22,.8,.3,1); }
    .fill.hot { background: var(--alarm); }
    .ticks { display: flex; justify-content: space-between; margin-top: 5px; font-family: var(--mono); font-size: 9.5px; color: var(--ink-3); font-variant-numeric: tabular-nums; }

    .readout { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--ink-2); line-height: 1.45; }
    .readout b { color: var(--ink); font-weight: 600; font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .readout .alarm, .readout .alarm b { color: var(--alarm); }
    .readout.meta { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--rule); font-size: 11.5px; }
    .why { margin-top: 10px; font-size: 12px; color: var(--ink-2); max-width: 68ch; line-height: 1.5; overflow-wrap: anywhere; }

    .summary-cards {
      display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px;
    }
    .summary-card {
      background: var(--panel); border: 1px solid var(--rule); border-radius: 8px;
      padding: 14px 15px 15px; min-width: 0; min-height: 100%;
      display: flex; flex-direction: column; gap: 2px;
      box-shadow: 0 1px 0 rgba(0,0,0,.02);
    }
    .summary-card.primary { border-color: color-mix(in srgb, var(--measured) 28%, var(--rule)); }
    .summary-card.infer { border-color: color-mix(in srgb, var(--inferred) 30%, var(--rule)); }
    .summary-card .amount { font-size: 28px; letter-spacing: -.03em; line-height: 1.1; overflow-wrap: anywhere; margin-top: 2px; }
    .summary-card .amount.small { font-size: 24px; }
    .summary-card .hint { font-size: 11px; color: var(--ink-2); margin-top: auto; padding-top: 8px; line-height: 1.4; overflow-wrap: anywhere; }
    .summary-card .eyebrow { white-space: normal; letter-spacing: .08em; line-height: 1.35; margin-bottom: 0; }
    @media (max-width: 720px) {
      .summary-cards { grid-template-columns: 1fr; }
    }

    .stack-wrap { margin-top: 0; }
    .stack-bar {
      display: flex; height: 14px; border-radius: 999px; overflow: hidden;
      background: var(--rule); margin-top: 4px;
    }
    .stack-seg { height: 100%; min-width: 0; }
    .stack-seg.window { background: var(--measured); }
    .stack-seg.natural { background: var(--measured-soft); }
    .stack-seg.cards { background: var(--inferred); }
    .stack-seg.credits { background: var(--ink-2); opacity: .5; }
    .stack-keys {
      display: grid; grid-template-columns: 1fr auto; gap: 6px 16px;
      margin-top: 12px; font-size: 12px; color: var(--ink-2); align-items: baseline;
    }
    .stack-keys .row { display: contents; }
    .stack-keys .lab { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .stack-keys .val { font-family: var(--mono); font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; text-align: right; }
    .stack-keys i {
      display: inline-block; width: 9px; height: 9px; border-radius: 2px; flex: none;
    }
    .stack-keys .k-window { background: var(--measured); }
    .stack-keys .k-natural { background: var(--measured-soft); }
    .stack-keys .k-cards { background: var(--inferred); }
    .stack-keys .k-credits { background: var(--ink-2); opacity: .5; }
    .stack-total-row {
      display: flex; justify-content: space-between; align-items: baseline;
      margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--rule);
      font-size: 12px; color: var(--ink-2);
    }
    .stack-total-row b { font-family: var(--mono); font-size: 15px; color: var(--ink); font-weight: 620; }

    .forecast { display: flex; gap: 28px; flex-wrap: wrap; margin-top: 4px; }
    .forecast > div { flex: 1 1 230px; min-width: 0; }
    .cost-input {
      font: inherit; font-family: var(--mono); font-size: 14px; width: 92px;
      padding: 4px 8px; border: 1px solid var(--rule); border-radius: 4px;
      background: var(--panel); color: var(--ink);
    }
    .cost-input:focus-visible { outline: 2px solid var(--measured); outline-offset: 1px; }
    .cost-line { align-items: center; gap: 4px 6px; }
    .cost-line .cost-input { width: 64px; padding: 2px 6px; font-size: 12px; }
    .cost-currency { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }

    .mem-foot { margin-top: 12px; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px 16px; }
    .mem-note { margin: 0; font-size: 11px; color: var(--ink-3); max-width: 52ch; line-height: 1.5; }
    .mem-clear {
      font: inherit; font-size: 11px; padding: 5px 11px; border-radius: 5px; cursor: pointer;
      border: 1px solid var(--rule); background: var(--panel); color: var(--ink-2);
    }
    .mem-clear:hover { color: var(--alarm); border-color: color-mix(in srgb, var(--alarm) 40%, var(--rule)); }
    .mem-clear:focus-visible { outline: 2px solid var(--measured); outline-offset: 1px; }

    /* hairlines drawn per cell, not by letting a grid gap show through: a partly filled
       last row would otherwise leave a slab of rule colour in the empty tracks */
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
    .cell { background: var(--paper); padding: 12px 14px; box-shadow: -1px -1px 0 0 var(--rule); }
    .cell .k { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
    .cell .v { font-family: var(--mono); font-size: 17px; font-weight: 600; letter-spacing: -.02em; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .cell .s { font-size: 11px; color: var(--ink-2); margin-top: 2px; line-height: 1.35; }

    h2 { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; font-weight: 700; margin: 0 0 10px; color: var(--ink); line-height: 1.3; }
    h2 em { font-style: normal; font-weight: 400; letter-spacing: .01em; text-transform: none; color: var(--ink-3); margin-left: 8px; font-size: 11.5px; }

    /* hairline separators so segments stay legible against paper in either theme */
    .bars { display: flex; height: 26px; border-radius: 4px; overflow: hidden; border: 1px solid var(--rule); }
    .bars > div { min-width: 0; }
    .bars > div + div { box-shadow: inset 1px 0 0 var(--paper); }
    .keys { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 8px; font-size: 11px; color: var(--ink-2); }
    .swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
    .keys b { font-family: var(--mono); color: var(--ink); font-weight: 600; }

    .scroll { border: 1px solid var(--rule); border-radius: 8px; overflow: auto; max-height: 280px; background: var(--panel); }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th { position: sticky; top: 0; background: var(--panel); text-align: left; z-index: 1; padding: 8px 12px; font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; font-weight: 700; color: var(--ink-3); white-space: nowrap; border-bottom: 1px solid var(--rule); }
    td { padding: 8px 12px; border-bottom: 1px solid var(--rule); white-space: nowrap; }
    tr:last-child td { border-bottom: 0; }
    .n { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .n.strong { font-weight: 600; }
    .cyc-note { color: var(--ink-3); font-size: 11px; }
    tr.cyc-now td { background: color-mix(in srgb, var(--measured) 8%, transparent); }
    tr.cyc-now td:first-child { box-shadow: inset 2px 0 0 var(--measured); }
    tr.cyc-ahead td { color: var(--ink-2); }
    tr.cyc-total td { border-top: 1px solid var(--ink-3); border-bottom: 0; }
    @media (prefers-color-scheme: dark) {
      tr.cyc-now td { background: color-mix(in srgb, var(--measured) 16%, transparent); }
    }

    .notes { margin-top: 26px; padding-top: 18px; border-top: 1px solid var(--rule); }
    .notes h3 { font-size: 10px; letter-spacing: .15em; text-transform: uppercase; font-weight: 700; margin: 0 0 8px; color: var(--ink-2); }
    .notes ul { margin: 0; padding: 0; list-style: none; }
    .notes li { position: relative; padding-left: 16px; margin-bottom: 6px; font-size: 11.5px; line-height: 1.6; color: var(--ink-2); }
    .notes li::before { content: ""; position: absolute; left: 0; top: 8px; width: 8px; height: 1px; background: var(--ink-3); }
    .notes li.warn { color: var(--inferred); }
    .notes li.warn::before { background: var(--inferred); }

    .chart { margin-top: 0; }
    .chart svg { display: block; width: 100%; height: auto; overflow: visible; }
    .chart .axis { stroke: var(--rule); stroke-width: 1; }
    .chart text { font-family: var(--sans); font-size: 10px; fill: var(--ink-3); }
    .chart .muted { font-size: 9px; }
    .chart .label-strong { fill: var(--ink); font-weight: 600; }
    details { margin-top: 12px; }
    summary { color: var(--ink-2); cursor: pointer; font-size: 12px; }
    details .scroll { margin-top: 8px; }

    .status { padding: 56px 20px; text-align: center; color: var(--ink-2); }
    .status.bad { color: var(--alarm); text-align: left; white-space: pre-wrap; font-family: var(--mono); font-size: 11.5px; }
    .status .hint { color: var(--ink-3); font-size: 12px; margin-top: 6px; }

    @media (max-width: 620px) {
      .amount { font-size: 30px; }
      .sheet { padding: 16px 16px 22px; }
      .summary-card .amount { font-size: 24px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .fill, .trigger { transition: none; }
    }
  `;

  // ── Rendering ───────────────────────────────────────────────────────────

  function gaugeHtml() {
    const L = t();
    const r = cycleReading();
    const win = state.win;
    const now = Date.now();
    const allowanceMeasured = r.allowance?.source === "daily-ratio";

    const ratio = r.ceiling ? Math.min(1, r.s.credits / r.ceiling) : 0;
    const elapsedDays = Math.max(0.5, (now - win.startAt) / DAY_MS);
    const perDay = r.s.credits / elapsedDays;
    const enoughElapsed = (now - win.startAt) / DAY_MS >= 2;
    /*
     * A measured ceiling is one allowance, and day buckets can hold more than one — a boundary
     * day shared with the previous window, or a reset genuinely crossed mid-cycle. Unclamped
     * this prints a negative remainder and an alarm dated in the past.
     */
    const remaining = r.ceiling ? Math.max(0, r.ceiling - r.s.credits) : null;
    const overspent = r.ceiling ? r.s.credits > r.ceiling : false;
    const runOutMs = remaining > 0 && perDay > 0 ? now + (remaining / perDay) * DAY_MS : null;
    const willRunOut = runOutMs != null && runOutMs > now && runOutMs < win.resetAt;

    return `
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
                 ${allowanceMeasured ? `<div class="eyebrow" style="margin:5px 0 0">${esc(L.measuredFrom(r.allowance.samples))}</div>` : ""}
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
          <div class="fill ${ratio > 0.8 ? "hot" : ""}" style="width:${r.ceiling ? (ratio * 100).toFixed(1) : 0}%"></div>
        </div>
        <div class="ticks"><span>0</span><span>25</span><span>50</span><span>75</span><span>100%</span></div>
        <div class="legend-key">
          <span><i class="key-solid"></i>${esc(L.measured)}</span>
          <span><i class="key-dash"></i>${esc(L.inferred)}</span>
        </div>
      </div>

      ${
        willRunOut
          ? `<p class="verdict alarm">${esc(L.runOut(clock(runOutMs)))}</p>`
          : r.ceiling
            ? `<p class="verdict">${esc(L.endAt(usd(Math.min(r.ceiling, perDay * (win.windowSec / 86400)))))}</p>`
            : win.inferable && enoughElapsed
              ? `<p class="verdict"><span class="inf">${esc(L.endAt(usd(perDay * (win.windowSec / 86400))))}</span></p>`
            : `<p class="verdict">${esc(win.inferable ? L.noCeiling(Math.round(r.used)) : L.windowTooShort)}</p>`
      }

      ${
        overspent
          ? `<p class="verdict">${esc(L.overspent(allowancesUsed(dayKey(win.startAt), dayKey(now)).toFixed(1)))}</p>`
          : ""
      }
      <div class="readout">
        ${r.ceiling ? `<span><b class="inf">${usd(remaining)}</b> ${esc(L.leftSuffix(pct(1 - ratio)))}</span>` : ""}
        ${!r.ceiling && win.inferable && enoughElapsed ? `<span>${esc(L.noCeiling(Math.round(r.used)))}</span>` : ""}
        <span>${esc(L.windowSpan(clock(win.startAt), clock(win.resetAt)))}</span>
        <span>${esc(L.resetInPre)} <b>${Math.max(0, (win.resetAt - now) / DAY_MS).toFixed(1)}</b> ${esc(L.resetInPost)}</span>
        ${
          /* A per-day rate needs at least a day of window to divide by. On a 5-hour window
             the whole day's spend would be attributed to a fraction of a day. */
          win.inferable ? `<span><b>${usd(perDay)}</b>${esc(L.perDaySuffix)}</span>` : ""
        }
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
      ? L.renewalOneCycle(left)
      : L.renewalMath(left, proj.naturalOpenings, usd(proj.ceiling), proj.hasPartial);

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
    if (!state.win) return "";

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
      /*
       * You cannot use more than you were granted, so the expectation is capped at the
       * allowance — a past cycle can out-spend the inferred ceiling (the shared pool makes the
       * ceiling read low), and an uncapped figure would print "$700 of it — 100.0%" under a
       * $650 headline.
       */
      const expected = proj.ceiling == null ? 0 : Math.min(proj.expected, proj.allowance);
      const paceEnd = proj.basisEnd || proj.seg?.lastFull?.end;
      const onPace =
        proj.ceiling != null && proj.basisIsLastFull && proj.allowance > 0 && paceEnd
          ? `<div class="readout"><span>${esc(
              L.onPaceInline(usd(expected), pct(expected / proj.allowance), shortDate(dayKey(paceEnd))),
            )}</span></div>`
          : "";

      const allowance =
        proj.ceiling == null
          ? `<div class="amount small" style="color:var(--ink-3)">—</div>
             <div class="readout"><span>${esc(L.renewalUnknown)}</span></div>`
          : `<div class="amount small is-inferred">${usd(proj.allowance)}</div>
             <div class="readout"><span>${esc(L.renewalOn(dateOnly(proj.renewsAt)))}</span></div>
             <div class="readout"><span>${esc(breakdownLine(proj))}</span></div>
             ${onPace}`;

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

    // Remembered closed windows first — observed start/reset, not arithmetic lookback.
    for (const c of closed) {
      const suspect = ceiling && c.spend > ceiling * 1.15;
      const note = suspect ? `${L.cycleRemembered} · ${L.cycleSuspect}` : L.cycleRemembered;
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
        const suspect = ceiling && p.spend > ceiling * 1.15;
        const note = suspect ? `${L.cycleInferred} · ${L.cycleSuspect}` : L.cycleInferred;
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
        <h2>${esc(L.cycles)}<em>${esc(L.cyclesSub)}</em></h2>
        <div class="scroll" tabindex="0" role="region" aria-label="${esc(L.cycles)}"><table>
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
    const leftWindow = r?.ceiling != null ? Math.max(0, r.ceiling - r.s.credits) : 0;
    const natural = proj && ceiling ? Math.max(0, proj.naturalOpenings) * ceiling : 0;
    const bank = state.resetCards?.available || 0;
    const cards = ceiling && bank > 0 ? bank * ceiling : 0;
    const credits = state.purchased?.unlimited ? 0 : Math.max(0, state.purchased?.balance || 0);
    const total = leftWindow + natural + cards + credits;
    return { leftWindow, natural, cards, bank, credits, total, proj, reading: r };
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
          <div class="eyebrow ${measured ? "" : "is-inferred"}">${esc(measured ? L.measured : L.inferred)} · ${esc(L.periodCardOne)}</div>
          <div class="amount small ${measured ? "" : "is-inferred"}">${ceiling ? usd(ceiling) : "—"}</div>
          <div class="hint">${esc(L.periodCardOneSub)}</div>
        </div>
        <div class="summary-card infer">
          <div class="eyebrow is-inferred">${esc(L.inferred)} · ${esc(L.periodCardLeft)}</div>
          <div class="amount small is-inferred">${leftTotal > 0 ? usd(leftTotal) : "—"}</div>
          <div class="hint">${esc(L.periodCardLeftSub)}</div>
        </div>
      </div>`;
  }

  function remainingStackHtml(parts) {
    const L = t();
    const segs = [
      [parts.leftWindow, "window", L.remWindow],
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
        <p class="section-note">${esc(L.remainingStackSub)}</p>
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
          fill="${fill}" rx="4"><title>${esc(tip)}</title></rect>`;
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
    const bars = keys
      .map((key, i) => {
        const value = values[i];
        const barHeight = (value / max) * plotHeight;
        return `<rect x="${left + i * slot + 1}" y="${y(value)}" width="${barWidth}" height="${barHeight}" rx="4" fill="var(--measured)"${key === today ? ' opacity=".45"' : ""}><title>${esc(`${key} ${usd(value)}${key === today ? ` — ${L.partialDay}` : ""}`)}</title></rect>`;
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
        <details><summary>${esc(L.seeNumbers)}</summary>${dayTableHtml(days)}</details>
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
          <rect x="${labelWidth}" y="${y}" width="${w}" height="18" rx="4" fill="var(--measured)"><title>${esc(`${name} · ${usd(m.credits)} · ${perTurn}/turn`)}</title></rect>
          <text class="label-strong" x="${labelWidth + w + 7}" y="${y + 12}">${esc(usd(m.credits))}</text>
          <text class="muted" x="${labelWidth + w + 7}" y="${y + 23}">${esc(`${perTurn}/turn`)}</text>`;
      })
      .join("");

    return `
      <div class="chart">
        <h2>${esc(L.chartModel)}</h2>
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(L.chartModel)}">${marks}</svg>
        <details><summary>${esc(L.seeNumbers)}</summary>${modelTableHtml(s)}</details>
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
     * made of, whether pace or allowance decides it, and where the window count comes
     * from. narrCap must quote the cap itself — projected can sit below it, and then
     * "spent + still to open" would no longer add up to the number in the sentence.
     * Today's one-allowance size only prices the future, never historical window dollars.
     */
    const endKey = projection ? shortDate(dayKey(p.fullEndMs)) : "";
    const footnotes = [
      projection && projection.cap != null
        ? L.narrCap(
            usd(projection.cap),
            usd(projection.measured),
            usd(Math.max(0, projection.cap - projection.measured)),
          )
        : null,
      projection
        ? projection.cap == null
          ? L.narrPacePlain(projection.basisDays, usd(projection.rate), endKey, usd(projection.paced))
          : projection.capBinds
            ? L.narrPaceCapped(projection.basisDays, usd(projection.rate), endKey, usd(projection.paced))
            : L.narrPaceUnder(projection.basisDays, usd(projection.rate), endKey, usd(projection.paced))
        : null,
      projection?.early ? L.projEarly : null,
      grant && ceiling
        ? grant.resets > 0
          ? L.narrWindows(grant.windows, grant.resets, usd(ceiling))
          : L.periodNoReset
        : null,
      cards.n > 0 ? L.resetCardsUsed(cards.n, usd(cards.credits)) : null,
    ].filter(Boolean);

    return `
      <div class="section">${periodSummaryCardsHtml(s.credits, reading?.allowance, leftTotal)}</div>
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
      <div class="why">${esc(p.isBilling ? L.periodWhy : L.monthWhy)}</div>
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
    const anyLoc = rows.some((d) => d.loc.added || d.loc.removed);

    return `
      <div class="scroll" tabindex="0" role="region" aria-label="${esc(L.byDay)}"><table>
        <thead><tr>
          <th>${esc(L.thDate)}</th><th class="n">${esc(L.thCost)}</th><th class="n">${esc(L.thCredits)}</th>
          <th class="n">${esc(L.thTurns)}</th><th class="n">${esc(L.thPerTurn)}</th>
          <th class="n">${esc(L.thTokens)}</th><th class="n">${esc(L.thCache)}</th>
          ${anyLoc ? `<th class="n">${esc(L.thLoc)}</th>` : ""}
        </tr></thead>
        <tbody>${rows
          .map((d) => {
            const inTok = d.cached + d.uncached;
            return `<tr>
              <td>${esc(d.date)}</td>
              <td class="n strong">${usd(d.credits)}</td>
              <td class="n">${int(d.credits)}</td>
              <td class="n">${d.turns ? esc(int(d.turns)) : "—"}</td>
              <td class="n">${d.turns ? usd(d.credits / d.turns) : "—"}</td>
              <td class="n">${tokenCount(d.uncached + d.cached + d.output)}</td>
              <td class="n">${inTok ? pct(d.cached / inTok) : "—"}</td>
              ${anyLoc ? `<td class="n">${d.loc.added ? "+" + int(d.loc.added) : "—"}</td>` : ""}
            </tr>`;
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
        ? [[L.ambiguousSubscription(state.ent.liveSubscriptions, state.ent.structure), true]]
        : state.ent?.liveSubscriptions > 1
          ? [[L.twoSubscriptions(state.ent.liveSubscriptions, win?.planType || "?"), true]]
          : []),
      ...(win?.placeholder ? [[L.placeholderWindow, true]] : []),
      ...(win && !win.placeholder && !win.resetBank ? [[L.bankEmpty, false]] : []),
      ...(days.some((d) => d.pricedAtTopRate) ? [[L.topRateWarning, true]] : []),
      ...(allowance?.dropped ? [[L.allowanceChanged(allowance.dropped), true]] : []),
      ...(allowance?.source === "daily-ratio"
        ? [[L.allowanceNote(allowance.samples), false]]
        : win && !win.inferable
          ? [[L.n11, true]]
          : [[L.n3, false]]),
      ...(allowance?.conflict ? [[L.allowanceConflict(usd(allowance.conflict.daily), usd(allowance.conflict.window)), true]] : []),
      ...(overlap ? [[L.n4(clock(win.startAt), first.date, usd(first.credits)), true]] : []),
      ...(days.some((d) => d.models.some((m) => m.speed && m.speed !== "standard"))
        ? [[L.nTurnSplit, false]]
        : []),
      [L.n5, false],
      [L.n6, false],
      [L.n8, false],
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
      <button class="trigger ${state.loading ? "busy" : ""}" title="${esc(L.openPanel)}">
        <span class="trigger-mark"></span>
        <span class="trigger-body">
          <span class="trigger-kicker">Codex</span>
          <span class="trigger-name">${state.loading ? esc(L.loading) : esc(L.brand)}</span>
        </span>
      </button>
    `;
  }




  function sheetHtml() {
    const L = t();

    if (state.loading) return `<div class="status">${esc(L.loading)}</div>`;
    if (state.error) return `<div class="status bad">${esc(state.error)}</div>`;

    const { days, s, from, to } = currentSlice();
    if (!days.length) {
      return `<div class="status">${esc(state.view === "cycle" ? L.emptyCycle : L.emptyPeriod)}
        <div class="hint">${esc(L.emptyHint)}</div></div>`;
    }

    const forecast = state.view === "cycle" ? forecastHtml() : "";

    return `
      <div class="sheet">
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
        ${notesHtml(days)}
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
    const periodLabel = hasRenewalDate() ? L.period : L.calendarMonth;
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
                    <div class="wordmark">${esc(L.title)} <em>${esc(L.from)}</em></div>
                    <div class="subhead">${state.win ? esc(windowLabel()) : ""}</div>
                  </div>
                  <span class="grow"></span>
                  <div class="controls">
                    <div class="seg">
                      <button data-view="cycle" aria-pressed="${state.view === "cycle"}">${esc(L.cycle)}</button>
                      <button data-view="period" aria-pressed="${state.view === "period"}">${esc(periodLabel)}</button>
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

    const close = root.querySelector('[data-act="close"]');
    if (close) close.onclick = closePanel;

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
      state.ent = check ? readEntitlement(check, state.win?.planType) : null;
      state.purchased = readPurchasedCredits(usage);
      if (!state.win) throw new Error(t().noWindow);

      /*
       * Reach back far enough to cover the billing period, the current cycle, and one whole
       * cycle before it. That last one is what the pace estimate is built on, so fetching a
       * partial slice of it would quietly understate every projection.
       */
      const today = dayKey(Date.now());
      const priorCycle = dayKey(state.win.startAt - state.win.windowSec * 1000);
      const from = [dayKey(state.win.startAt), periodRange().from, priorCycle].sort()[0];

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
  render();
})();
