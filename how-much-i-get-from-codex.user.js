// ==UserScript==
// @name         How Much I Get From Codex
// @name:zh-CN   How Much I Get From Codex · 你从 Codex 到底拿到多少
// @namespace    https://github.com/bigbobro
// @version      1.0.0
// @homepageURL  https://github.com/bigbobro/how-much-i-get-from-codex
// @supportURL   https://github.com/bigbobro/how-much-i-get-from-codex/issues
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
 *   per-model tokens × official rate card = credits spent   exact
 *   credits ÷ used percent               = the ceiling      inferred
 *
 * The credits step is exact rather than an approximation: the per-model shares this
 * script computes match the ones OpenAI returns from its own endpoint to 4-5 significant
 * figures. Everything downstream of the division is an estimate, and the interface says
 * so — solid blue is measured, dashed amber is inferred.
 *
 * Nothing is requested until you open the panel. No background polling.
 */

(function () {
  "use strict";

  if (window.__howMuchIGet) return;
  window.__howMuchIGet = true;

  // ── Rate card ───────────────────────────────────────────────────────────
  // credits per 1M tokens: [uncached input, cached input, output]
  // https://help.openai.com/en/articles/20001106-codex-rate-card
  const RATE_CARD = {
    "gpt-5.6-sol": [125, 12.5, 750],
    "gpt-5.6-terra": [62.5, 6.25, 375],
    "gpt-5.6-luna": [25, 2.5, 150],
    "gpt-5.5": [125, 12.5, 750],
    "gpt-5.5-cyber": [500, 50, 3000],
    "gpt-5.4": [62.5, 6.25, 375],
    "gpt-5.4-mini": [18.75, 1.875, 113],
    "gpt-5.3-codex": [43.75, 4.375, 350],
    "gpt-5.2": [43.75, 4.375, 350],
    "gpt-image-2": [200, 50, 750],
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

  const SURFACES = {
    cli: "CLI",
    vscode: "VS Code",
    jetbrains: "JetBrains",
    web: "Web",
    desktop_app: "Desktop",
    mobile: "Mobile",
    work_web: "Work · web",
    work_desktop: "Work · desktop",
    work_mobile: "Work · mobile",
    github: "GitHub",
    github_code_review: "Code review",
    slack: "Slack",
    linear: "Linear",
    sdk: "SDK",
    exec: "Exec",
    agent_identity: "Agent",
    unknown: "Unknown",
  };

  // ── Copy ────────────────────────────────────────────────────────────────

  const I18N = {
    en: {
      brand: "How much I get",
      title: "How Much I Get",
      from: "from Codex",
      window: (plan, days) => `${plan} · ${days}-day cycle`,
      windowHours: (plan, hours) => `${plan} · ${hours}-hour cycle`,

      cycle: "This cycle",
      period: "This subscription",
      calendarMonth: "This month",

      spent: "Spent",
      ceiling: "Ceiling",
      measured: "Measured",
      inferred: "Inferred",
      noCeiling: (p) => `${p}% used — not enough yet to infer a ceiling`,
      windowTooShort: "The allowance window is shorter than a day, but usage only arrives in whole days — there is nothing to divide.",
      leftSuffix: (p) => `left (${p})`,
      windowSpan: (a, b) => `${a} → ${b}`,
      resetInPre: "resets in",
      resetInPost: "days",
      perDaySuffix: "/day",
      runOut: (d) => `On this pace you run out ${d}, before the reset`,
      endAt: (a) => `On this pace the cycle ends around ${a}`,

      untilRenewal: "Left before renewal",
      renewalOn: (d) => `renews ${d}`,
      renewalMath: (a, n, l, partial) =>
        `${a} left in this cycle, then ${n} more allowance${n > 1 ? "s" : ""} of about ${l}` +
        (partial ? " — a window hands over the whole amount even with days left to spend it" : ""),
      renewalOneCycle: (a) => `${a} left — the subscription renews before this cycle does`,

      periodGranted: "Allowance this payment bought",
      periodWindows: (n, l) => `${n} allowances of about ${l}`,
      periodResets: (n) => `the window reset ${n} time${n > 1 ? "s" : ""} inside the billing period`,
      periodNoReset: "one allowance — the window did not reset inside the billing period",
      periodFloor: "at least — an extra reset would mean more, never fewer",
      renewalUnknown: "Needs a ceiling before it can project",

      onPaceInline: (a, p, d) => `at the pace of the cycle that ended ${d} you would actually use ${a} of it — ${p}`,

      cycles: "Cycle by cycle",
      cyclesSub: "boundaries ahead are firm; earlier ones drift if a reset moved them",
      thWhen: "Window",
      thSpend: "Spend",
      cyclePast: "earlier",
      cycleNow: "now",
      cycleNext: "ahead",
      cycleCutShort: "renewal lands mid-window",
      cycleHidden: (n) => `and ${n} more opening${n > 1 ? "s" : ""} before renewal, not listed`,
      gaugeAria: (a, b) => `spent ${a} of an inferred ${b} ceiling`,

      payback: "Payback",
      paybackOn: (paid, got) => `paid ${paid}, used ${got}`,
      setCost: "What do you pay a month?",
      costPlaceholder: "e.g. 30",

      periodTotal: "used this subscription period",
      periodSpan: (a, b) => `${a} → ${b}`,
      periodWhy:
        "Measured over the real billing period, not the calendar month. The allowance resets on its own clock, so the billing period is the honest answer to what one payment buys.",
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

      bySurface: "By surface",
      bySurfaceSub: "approximate — surfaces are not broken down per model",
      byDay: "By day",
      byDaySub: (n) => `${n} day${n === 1 ? "" : "s"} with usage`,
      byModel: "By model",
      byModelSub: "fast mode listed separately, multiplier applied",
      topSkills: "Most used skills",
      topPlugins: "Most used plugins",
      invocations: "Calls",

      thDate: "Date",
      thCost: "Cost",
      thCredits: "Credits",
      thTurns: "Turns",
      thPerTurn: "Per turn",
      thTokens: "Tokens",
      thCache: "Cached",
      thModel: "Model",
      thShare: "Share",
      thName: "Name",
      thSurface: "Surface",
      thLoc: "Lines",

      emptyCycle: "Nothing spent this cycle yet.",
      emptyPeriod: "Nothing spent this period yet.",
      emptyHint: "Try the other view.",
      loading: "Reading usage data…",
      noToken: "Could not get an access token. Sign in to ChatGPT and reload the page.",
      noWindow: "The API returned no rate limit window, so the cycle range is unknown.",

      notesTitle: "What is measured and what is inferred",
      n1: "Cost comes from per-model token counts × the official rate card. Checked against OpenAI's own model-share numbers: matches to 4-5 significant figures. Treat it as exact.",
      n2: (r) => `Credits convert at 1 credit = $${r} (1000 credits = $40). OpenAI has never published this rate — change USD_PER_CREDIT at the top of the script if yours differs.`,
      n3: "The ceiling is inferred: spend ÷ the used percentage the API reports. The more you have used, the tighter it gets.",
      n4: (t, d, a) => `The cycle opened at ${t}, but usage only arrives in whole UTC days. The ${d} row counts that entire day — ${a} — and some of it was spent before the cycle opened. How much cannot be known, but it pushes both the spend and the ceiling high.`,
      n10: (m) => `Fast mode has no published multiplier for ${m}, so it is priced at the standard rate — the real cost is higher.`,
      n11: "The allowance window here is shorter than a day. Usage is only reported by whole days, so no ceiling can be inferred from it and the projections are hidden.",
      n5: "Codex, ChatGPT Work and ChatGPT for Excel draw on the same pool, but this API only sees Codex — so the spend, and the ceiling, come out low.",
      n6: "Scoped to the current seat only. Other people in the workspace are not counted.",
      n7: (m) => `Not in the rate card, so not priced: ${m}`,
      n8: "There is no per-repository breakdown in the API, so spend cannot be split by project. Surface is the closest thing available.",
      n9: "Nothing is requested until you open this panel, and nothing runs in the background after you close it.",

      reload: "Reload",
      close: "Close",
      openPanel: "Work out what I get",
    },

    zh: {
      brand: "我到底拿到多少",
      title: "我到底拿到多少",
      from: "Codex 额度",
      window: (plan, days) => `${plan} · ${days} 天周期`,
      windowHours: (plan, hours) => `${plan} · ${hours} 小时周期`,

      cycle: "本周期",
      period: "本期订阅",
      calendarMonth: "本自然月",

      spent: "已花",
      ceiling: "额度",
      measured: "实测",
      inferred: "推算",
      noCeiling: (p) => `已用 ${p}%，还不够反推额度`,
      windowTooShort: "这个账号的额度窗口不到一天，而用量只能按整天取 —— 没有可除的东西。",
      leftSuffix: (p) => `未用（${p}）`,
      windowSpan: (a, b) => `${a} → ${b}`,
      resetInPre: "还有",
      resetInPost: "天重置",
      perDaySuffix: " 日均",
      runOut: (d) => `按这个速度，${d} 就用完了，赶不到重置`,
      endAt: (a) => `按这个速度，周期结束时约花掉 ${a}`,

      untilRenewal: "续费前还能拿",
      renewalOn: (d) => `${d} 续费`,
      renewalMath: (a, n, l, partial) =>
        `本周期还剩 ${a}，之后还会开出 ${n} 份额度，每份约 ${l}` +
        (partial ? " —— 窗口一开就是满额发放，哪怕只剩几天用" : ""),
      renewalOneCycle: (a) => `本周期还剩 ${a} —— 订阅比周期先续`,

      periodGranted: "这笔订阅费买到的额度",
      periodWindows: (n, l) => `${n} 份额度，每份约 ${l}`,
      periodResets: (n) => `账期内额度重置了 ${n} 次`,
      periodNoReset: "一份额度 —— 账期内窗口没有重置过",
      periodFloor: "这是下限 —— 多一次重置只会更多，不会更少",
      renewalUnknown: "要先推算出额度才能往后推",

      onPaceInline: (a, p, d) => `按 ${d} 结束的那个周期的用法，你实际会用掉其中 ${a} —— ${p}`,

      cycles: "一个周期一个周期看",
      cyclesSub: "往后的边界是硬的；往回推的可能因为中途重置而偏移",
      thWhen: "窗口",
      thSpend: "花费",
      cyclePast: "过去",
      cycleNow: "现在",
      cycleNext: "往后",
      cycleCutShort: "续费日落在这个窗口中间",
      cycleHidden: (n) => `续费前还会再开 ${n} 次，没有逐条列出`,
      gaugeAria: (a, b) => `已花 ${a}，推算额度 ${b}`,

      payback: "回本",
      paybackOn: (paid, got) => `付了 ${paid}，用掉 ${got}`,
      setCost: "你一个月付多少？",
      costPlaceholder: "比如 30",

      periodTotal: "本期订阅已用掉",
      periodSpan: (a, b) => `${a} → ${b}`,
      periodWhy:
        "按真实账期算，不按自然月。额度按自己的时钟重置，所以「一次付费到底买到了什么」，只有账期这把尺子答得准。",
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

      bySurface: "花在哪个入口",
      bySurfaceSub: "近似值 —— 接口没按入口拆模型",
      byDay: "每日明细",
      byDaySub: (n) => `${n} 天有用量`,
      byModel: "按模型",
      byModelSub: "fast mode 单独列，倍率已计入",
      topSkills: "用得最多的技能",
      topPlugins: "用得最多的插件",
      invocations: "调用次数",

      thDate: "日期",
      thCost: "花费",
      thCredits: "credits",
      thTurns: "turns",
      thPerTurn: "每 turn",
      thTokens: "tokens",
      thCache: "缓存",
      thModel: "模型",
      thShare: "占比",
      thName: "名称",
      thSurface: "入口",
      thLoc: "代码行",

      emptyCycle: "本周期还没花钱。",
      emptyPeriod: "这一期订阅还没花钱。",
      emptyHint: "换另一个视图看看。",
      loading: "正在读用量数据…",
      noToken: "拿不到访问令牌。登录 ChatGPT 后刷新页面再试。",
      noWindow: "接口没返回限流窗口，确定不了本周期的范围。",

      notesTitle: "哪些是实测，哪些是推算",
      n1: "花费 = 每天每模型的 token 数 × 官方 rate card。跟 OpenAI 自己返回的模型占比对过，吻合到 4~5 位有效数字，可以当精确值用。",
      n2: (r) => `credits 换美元按 1 credit = $${r}（1000 credits = $40）。这个汇率 OpenAI 从没公布过 —— 你那边不一样就改脚本顶部的 USD_PER_CREDIT。`,
      n3: "额度是推算的：花费 ÷ 接口给的已用百分比。用得越多，推得越准。",
      n4: (t, d, a) => `周期是 ${t} 开始的，但用量只能按整个 UTC 天取。${d} 这一行算的是一整天（${a}），其中一部分花在周期开始之前。具体多少无从得知，但它会把花费和推算额度一起抬高。`,
      n10: (m) => `${m} 的 fast mode 没有公布倍率，这里按标准价计，实际花费只会更高。`,
      n11: "这个账号的额度窗口不到一天，而用量只按整天上报，没法从中反推额度，相关推算已隐藏。",
      n5: "Codex、ChatGPT Work、ChatGPT for Excel 共用一个额度池，但这个接口只看得到 Codex —— 所以花费偏低，推算额度也跟着偏低。",
      n6: "只统计当前 seat，不含 workspace 里其他人。",
      n7: (m) => `不在 rate card 里，没计价：${m}`,
      n8: "接口没有按仓库拆的维度，所以分不出「哪个项目花了多少」。入口是能拿到的最接近的东西。",
      n9: "不点开就不发任何请求，关掉之后也不会在后台跑。",

      reload: "重新读取",
      close: "关闭",
      openPanel: "算算我拿到多少",
    },
  };

  const savedLang = localStorage.getItem(LANG_KEY);
  let lang = savedLang || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
  const t = () => I18N[lang];

  // ── Formatting ──────────────────────────────────────────────────────────

  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const usd = (c) => "$" + (c * USD_PER_CREDIT).toFixed(2);
  const int = (v) => Math.round(v).toLocaleString("en-US");
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
    const rate = RATE_CARD[entry.model];
    if (!rate) return { unknown: true, unpricedFast: false, credits: 0, uncached: 0, cached: 0, output: 0 };

    const isFast = !!entry.speed && entry.speed !== "standard";
    const mult = isFast ? FAST_MULTIPLIER[entry.model] || 1 : 1;

    const uncached = ((entry.uncached_text_input_tokens || 0) / 1e6) * rate[0] * mult;
    const cached = ((entry.cached_text_input_tokens || 0) / 1e6) * rate[1] * mult;
    const output = ((entry.text_output_tokens || 0) / 1e6) * rate[2] * mult;

    return {
      unknown: false,
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
      resetAt,
      startAt: resetAt - windowSec * 1000,
      planType: usage.plan_type,
    };
  }

  // The renewal date lives on the account entitlement, not on any Codex endpoint.
  function readEntitlement(check) {
    const accounts = check?.accounts || {};
    for (const key of Object.keys(accounts)) {
      const e = accounts[key]?.entitlement;
      if (!e?.has_active_subscription || !e.renews_at) continue;

      const renewsAt = Date.parse(e.renews_at);
      if (!Number.isFinite(renewsAt)) continue;

      return { renewsAt, billingPeriod: e.billing_period };
    }
    return null;
  }

  /*
   * Five endpoints, joined on date. Everything is scoped to the current seat —
   * without workspace_user=true the counts come back for the whole workspace while
   * the used percentage stays personal, and the two do not divide.
   */
  async function fetchAll(token, startKey, endKey) {
    const range = `start_date=${startKey}&end_date=${addDays(endKey, 1)}&group_by=day`;
    const seat = `${range}&workspace_user=true`;
    const A = "/backend-api/wham/analytics/";

    // Only the breakdown is load-bearing — it is where every money figure comes from.
    // The rest decorate, so a failure there costs a column, not the panel.
    const [breakdown, counts, skills, plugins, attribution] = await Promise.all([
      api(`/backend-api/wham/usage/daily-workspace-user-token-usage-breakdown?${range}`, token),
      soft(`${A}daily-workspace-usage-counts?${seat}`, token),
      soft(`${A}daily-skill-usage-metrics?${seat}&top_skill_limit=20`, token),
      soft(`${A}daily-plugin-usage-metrics?${seat}&top_plugin_limit=20`, token),
      soft(`${A}code-attribution?${seat}&group=workspace`, token),
    ]);

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
    const unpricedFast = new Set();

    for (const row of breakdown.data || []) {
      const activity = activityByDate.get(row.date) || { turns: 0, threads: 0, perModel: new Map() };
      const models = [];
      const pv = row.premium_usage_values || {};
      const day = {
        date: row.date,
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
        bySurface: {
          uncached: pv.uncached_text_input_tokens_by_surface || {},
          cached: pv.cached_text_input_tokens_by_surface || {},
          output: pv.text_output_tokens_by_surface || {},
        },
        models,
      };

      const priced = [];
      for (const m of row.models || []) {
        if (!m.text_total_tokens) continue;

        const p = priceOf(m);
        if (p.unknown) unknownModels.add(m.model);
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
      // reported once per model name. Give each row its token share instead of the whole
      // count, or the model table double-counts turns and every per-turn figure halves.
      const tokensByModel = new Map();
      for (const { m } of priced) {
        tokensByModel.set(m.model, (tokensByModel.get(m.model) || 0) + m.text_total_tokens);
      }

      for (const { m, p } of priced) {
        const share = m.text_total_tokens / (tokensByModel.get(m.model) || m.text_total_tokens);
        models.push({
          model: m.model,
          speed: m.speed || "standard",
          credits: p.credits,
          turns: (activity.perModel.get(m.model) || 0) * share,
          tokens: m.text_total_tokens,
        });
      }

      if (day.credits <= 0) continue;
      days.push(day);
    }

    days.sort((a, b) => a.date.localeCompare(b.date));

    return {
      days,
      unknownModels: [...unknownModels],
      unpricedFast: [...unpricedFast],
      fetchedFrom: startKey,
      skills: skills?.data || [],
      plugins: plugins?.data || [],
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

  /*
   * Surfaces come with token counts but no model split, so each day's blended
   * per-token-class rate is applied. Exact when a day used one model, close otherwise.
   */
  function surfaceSplit(days) {
    const totals = new Map();

    for (const d of days) {
      const rateU = d.uncached ? d.uncachedCredits / d.uncached : 0;
      const rateC = d.cached ? d.cachedCredits / d.cached : 0;
      const rateO = d.output ? d.outputCredits / d.output : 0;

      const names = new Set([
        ...Object.keys(d.bySurface.uncached),
        ...Object.keys(d.bySurface.cached),
        ...Object.keys(d.bySurface.output),
      ]);

      for (const name of names) {
        const u = d.bySurface.uncached[name] || 0;
        const c = d.bySurface.cached[name] || 0;
        const o = d.bySurface.output[name] || 0;
        const credits = u * rateU + c * rateC + o * rateO;
        if (credits <= 0) continue;

        const cur = totals.get(name) || { name, credits: 0, tokens: 0 };
        cur.credits += credits;
        cur.tokens += u + c + o;
        totals.set(name, cur);
      }
    }

    return [...totals.values()].sort((a, b) => b.credits - a.credits);
  }

  function rankInvocations(rows, listKey, nameKey, from, to) {
    const totals = new Map();
    for (const row of rows) {
      if (row.date < from || row.date > to) continue;
      for (const item of row[listKey] || []) {
        const name = item.display_name || item[nameKey] || "—";
        totals.set(name, (totals.get(name) || 0) + (item.invocation_counts || 0));
      }
    }
    return [...totals.entries()]
      .map(([name, count]) => ({ name, count }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count);
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
        sub: `${shortDate(dearestTurnDay.date)} · ${int(dearestTurnDay.turns)} turns`,
      });
    }

    if (topModel && s.models.size > 1 && topModel.credits / s.credits < 0.95) {
      cards.push({
        label: L.cTopModel,
        value: usd(topModel.credits),
        sub: `${topModel.name} · ${L.subShare(pct(topModel.credits / s.credits))}`,
      });
    }

    if (topTurnModel && topTurnModel !== topModel && s.models.size > 1) {
      cards.push({
        label: L.cTopTurnModel,
        value: usd(topTurnModel.credits / topTurnModel.turns),
        sub: topTurnModel.name,
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
    unpricedFast: [],
    fetchedFrom: "",
    skills: [],
    plugins: [],
    view: "cycle", // cycle | period
    loaded: false,
    loading: false,
    error: "",
    open: false,
    root: null,
  };

  const monthlyCost = () => Number(localStorage.getItem(COST_KEY)) || 0;

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

  // The billing period the subscription is actually in, or the calendar month if unknown.
  function periodRange() {
    const today = dayKey(Date.now());
    if (!state.ent) {
      const first = dayMs(today.slice(0, 8) + "01");
      return { from: today.slice(0, 8) + "01", to: today, startMs: first, endMs: Date.now(), isBilling: false };
    }

    const end = new Date(state.ent.renewsAt);
    const start = rollBack(end, state.ent.billingPeriod === "yearly" ? 12 : 1);

    return {
      from: dayKey(start.getTime()),
      to: dayKey(end.getTime()),
      startMs: start.getTime(),
      endMs: end.getTime(),
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
    const W = state.win ? state.win.windowSec * 1000 : 0;
    if (!W || W < DAY_MS / 24) return null;

    const p = periodRange();
    const CAP = 400; // a year of 5-hour windows, and a hard stop on any bad clock

    let past = 0;
    for (let open = state.win.startAt; open > p.startMs && past < CAP; open -= W) past++;

    let ahead = 0;
    for (let open = state.win.resetAt; open < p.endMs && ahead < CAP; open += W) ahead++;

    // Plus the one already running when the period began.
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
    let ceiling = null;
    if (state.win.inferable) {
      if (used > 0) ceiling = s.credits / (used / 100);
      else if (state.win.limitReached && s.credits > 0) ceiling = s.credits;
    }

    return { days, s, used, ceiling };
  }

  const spendInDays = (fromKey, toKey) =>
    toKey < fromKey ? 0 : summarize(state.days.filter((d) => d.date >= fromKey && d.date <= toKey)).credits;

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
    if (!state.win || !r || !state.win.inferable) return null;

    const W = state.win.windowSec * 1000;
    const currentFrom = dayKey(state.win.startAt);
    const dayBeforeCurrent = addDays(currentFrom, -1);

    /*
     * A window opening mid-day shares that day with the window before it, and a day bucket
     * cannot be split. The boundary day goes to the current cycle, and earlier segments stop
     * the day before — otherwise the same spend is counted in two cycles at once.
     *
     * A segment counts as trusted only if all of its days were actually fetched. An
     * uncovered segment would report a partial sum as a whole cycle, and that segment is
     * exactly the one the pace estimate leans on.
     */
    const past = [];
    for (let k = 1; k <= 8; k++) {
      const start = state.win.startAt - k * W;
      const fromKey = dayKey(start);
      const lastDay = dayKey(start + W - 1);
      const toKey = lastDay > dayBeforeCurrent ? dayBeforeCurrent : lastDay;
      if (toKey < fromKey) break;

      const covered = !!state.fetchedFrom && fromKey >= state.fetchedFrom;
      past.unshift({ start, end: start + W, spend: spendInDays(fromKey, toKey), covered });
      if (!covered) break;
    }

    // Count openings arithmetically and cap only the rendered rows. A display cap must never
    // silently become a cap on the total.
    let openings = 0;
    const future = [];
    if (state.ent && state.ent.renewsAt > state.win.resetAt) {
      openings = Math.ceil((state.ent.renewsAt - state.win.resetAt) / W);
      for (let i = 0; i < Math.min(openings, 10); i++) {
        const start = state.win.resetAt + i * W;
        const end = Math.min(start + W, state.ent.renewsAt);
        future.push({ start, end, endsEarly: end < start + W });
      }
    }

    const trusted = past.filter((p) => p.covered && p.spend > 0);
    const lastFull = trusted.length ? trusted[trusted.length - 1] : null;

    return {
      past,
      future,
      openings,
      hiddenOpenings: Math.max(0, openings - future.length),
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
    if (!seg || !state.ent || !r) return null;

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
    const openings = seg.openings;
    const usableTime = Math.max(0, state.ent.renewsAt - state.win.resetAt) / W;
    const basis = seg.lastFull ? seg.lastFull.spend : Math.min(r.ceiling, perMs * W);

    return {
      renewsAt: state.ent.renewsAt,
      ceiling: r.ceiling,
      seg,
      leftThisCycle,
      openings,
      hasPartial: usableTime % 1 > 0.001,
      allowance: leftThisCycle + openings * r.ceiling,
      expected: restOfThisCycle + usableTime * basis,
      basis,
      basisIsLastFull: !!seg.lastFull,
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
      position: fixed; top: 14px; right: 18px; z-index: 2147483646;
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
    .sheet { padding: 20px; }

    /* three tiers of separation: conclusion, diagnosis, ledger */
    .rule.major { margin: 28px 0; }

    .gauge-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
    .eyebrow { font-size: 9.5px; letter-spacing: .15em; text-transform: uppercase; font-weight: 600; color: var(--ink-3); margin-bottom: 4px; }
    .eyebrow.is-inferred { color: var(--inferred); }
    .amount { font-family: var(--mono); font-size: 38px; font-weight: 620; letter-spacing: -.04em; line-height: .95; font-variant-numeric: tabular-nums; }
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

    .legend-key { display: flex; gap: 14px; margin-top: 7px; font-size: 10px; color: var(--ink-3); }
    .key-solid, .key-dash { display: inline-block; width: 14px; height: 7px; margin-right: 5px; vertical-align: 0; border-radius: 1px; }
    .key-solid { background: var(--measured); }
    .key-dash { border: 1px dashed var(--inferred); background: var(--inferred-soft); }

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

    .readout { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 12px; color: var(--ink-2); }
    .readout b { color: var(--ink); font-weight: 600; font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .readout .alarm, .readout .alarm b { color: var(--alarm); }
    .why { margin-top: 8px; font-size: 12px; color: var(--ink-2); max-width: 62ch; }

    .rule { height: 1px; background: var(--rule); margin: 20px 0; }

    .forecast { display: flex; gap: 24px; flex-wrap: wrap; }
    .forecast > div { flex: 1 1 230px; }
    .cost-input {
      font: inherit; font-family: var(--mono); font-size: 14px; width: 92px;
      padding: 4px 8px; border: 1px solid var(--rule); border-radius: 4px;
      background: var(--panel); color: var(--ink);
    }
    .cost-input:focus-visible { outline: 2px solid var(--measured); outline-offset: 1px; }

    /* hairlines drawn per cell, not by letting a grid gap show through: a partly filled
       last row would otherwise leave a slab of rule colour in the empty tracks */
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); background: var(--paper); border: 1px solid var(--rule); border-radius: 6px; overflow: hidden; }
    .cell { background: var(--paper); padding: 11px 13px; box-shadow: -1px -1px 0 0 var(--rule); }
    .cell .k { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
    .cell .v { font-family: var(--mono); font-size: 17px; font-weight: 600; letter-spacing: -.02em; margin-top: 3px; font-variant-numeric: tabular-nums; }
    .cell .s { font-size: 11px; color: var(--ink-2); margin-top: 1px; }

    h2 { font-size: 10px; letter-spacing: .15em; text-transform: uppercase; font-weight: 700; margin: 0 0 9px; color: var(--ink); }
    h2 em { font-style: normal; font-weight: 400; letter-spacing: .02em; text-transform: none; color: var(--ink-3); margin-left: 8px; font-size: 11px; }

    /* hairline separators so segments stay legible against paper in either theme */
    .bars { display: flex; height: 26px; border-radius: 3px; overflow: hidden; border: 1px solid var(--rule); }
    .bars > div { min-width: 0; }
    .bars > div + div { box-shadow: inset 1px 0 0 var(--paper); }
    .keys { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 8px; font-size: 11px; color: var(--ink-2); }
    .swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
    .keys b { font-family: var(--mono); color: var(--ink); font-weight: 600; }

    .two-up { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 620px) { .two-up { grid-template-columns: 1fr; } }

    .scroll { border: 1px solid var(--rule); border-radius: 6px; overflow: auto; max-height: 290px; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th { position: sticky; top: 0; background: var(--paper); text-align: left; z-index: 1; padding: 7px 11px; font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; font-weight: 700; color: var(--ink-3); white-space: nowrap; border-bottom: 1px solid var(--rule); }
    td { padding: 7px 11px; border-bottom: 1px solid var(--rule); white-space: nowrap; }
    tr:last-child td { border-bottom: 0; }
    .n { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .n.strong { font-weight: 600; }
    .cyc-note { color: var(--ink-3); font-size: 11px; }
    tr.cyc-now td { background: color-mix(in srgb, var(--measured) 9%, transparent); }
    tr.cyc-now td:first-child { box-shadow: inset 2px 0 0 var(--measured); }
    @media (prefers-color-scheme: dark) {
      tr.cyc-now td { background: color-mix(in srgb, var(--measured) 18%, transparent); }
    }

    .notes { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--rule); }
    .notes h3 { font-size: 10px; letter-spacing: .15em; text-transform: uppercase; font-weight: 700; margin: 0 0 8px; color: var(--ink-2); }
    .notes ul { margin: 0; padding: 0; list-style: none; }
    .notes li { position: relative; padding-left: 16px; margin-bottom: 6px; font-size: 11.5px; line-height: 1.6; color: var(--ink-2); }
    .notes li::before { content: ""; position: absolute; left: 0; top: 8px; width: 8px; height: 1px; background: var(--ink-3); }
    .notes li.warn { color: var(--inferred); }
    .notes li.warn::before { background: var(--inferred); }

    .status { padding: 56px 20px; text-align: center; color: var(--ink-2); }
    .status.bad { color: var(--alarm); text-align: left; white-space: pre-wrap; font-family: var(--mono); font-size: 11.5px; }
    .status .hint { color: var(--ink-3); font-size: 12px; margin-top: 6px; }

    @media (max-width: 620px) {
      .amount { font-size: 30px; }
      .trigger { top: auto; bottom: 14px; right: 14px; }
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

    const ratio = r.ceiling ? Math.min(1, r.s.credits / r.ceiling) : 0;
    const elapsedDays = Math.max(0.5, (now - win.startAt) / DAY_MS);
    const perDay = r.s.credits / elapsedDays;
    const remaining = r.ceiling ? r.ceiling - r.s.credits : null;
    const runOutMs = remaining != null && perDay > 0 ? now + (remaining / perDay) * DAY_MS : null;
    const willRunOut = runOutMs != null && runOutMs < win.resetAt;

    return `
      <div class="gauge-head">
        <div>
          <div class="eyebrow">${esc(L.measured)} · ${esc(L.spent)}</div>
          <div class="amount">${usd(r.s.credits)}</div>
        </div>
        ${
          r.ceiling
            ? `<div class="right">
                 <div class="eyebrow is-inferred">${esc(L.inferred)} · ${esc(L.ceiling)}</div>
                 <div class="amount small is-inferred">${usd(r.ceiling)}</div>
               </div>`
            : ""
        }
      </div>

      <div class="gauge">
        <div class="track ${r.ceiling ? "" : "blank"}" role="img"
             aria-label="${esc(r.ceiling ? L.gaugeAria(usd(r.s.credits), usd(r.ceiling)) : L.noCeiling(Math.round(r.used)))}">
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
            : `<p class="verdict">${esc(win.inferable ? L.noCeiling(Math.round(r.used)) : L.windowTooShort)}</p>`
      }

      <div class="readout">
        ${r.ceiling ? `<span><b class="inf">${usd(remaining)}</b> ${esc(L.leftSuffix(pct(1 - ratio)))}</span>` : ""}
        <span>${esc(L.windowSpan(clock(win.startAt), clock(win.resetAt)))}</span>
        <span>${esc(L.resetInPre)} <b>${Math.max(0, (win.resetAt - now) / DAY_MS).toFixed(1)}</b> ${esc(L.resetInPost)}</span>
        <span><b>${usd(perDay)}</b>${esc(L.perDaySuffix)}</span>
      </div>
    `;
  }

  // Says which window openings the remaining allowance is actually made of.
  function breakdownLine(proj) {
    const L = t();
    const left = usd(proj.leftThisCycle);
    if (!proj.openings) return L.renewalOneCycle(left);
    return L.renewalMath(left, proj.openings, usd(proj.ceiling), proj.hasPartial);
  }

  function forecastHtml() {
    const L = t();
    const proj = projectToRenewal();
    if (!proj) return "";

    const cost = monthlyCost();
    const p = periodRange();
    const periodSpend = summarize(state.days.filter((d) => d.date >= p.from)).credits;

    /*
     * The expected figure used to sit beside the allowance as a second big number, but the
     * two are usually within a few percent of each other and the reader was left doing the
     * subtraction. Stated as a share of the allowance it says the thing directly.
     */
    const onPace =
      proj.ceiling != null && proj.basisIsLastFull && proj.allowance > 0
        ? `<div class="readout"><span>${esc(
            L.onPaceInline(
              usd(proj.expected),
              pct(Math.min(1, proj.expected / proj.allowance)),
              shortDate(dayKey(proj.seg.lastFull.end)),
            ),
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

    const payback =
      cost > 0
        ? `<div class="amount small">${((periodSpend * USD_PER_CREDIT) / cost).toFixed(1)}×</div>
           <div class="readout"><span>${esc(L.paybackOn("$" + cost, usd(periodSpend)))}</span></div>
           <div class="readout"><span>${esc(L.periodSpan(shortDate(p.from), shortDate(p.to)))}</span></div>`
        : `<div class="readout" style="margin:2px 0 6px"><span>${esc(L.setCost)}</span></div>
           <input class="cost-input" type="number" min="0" step="1" inputmode="decimal"
                  placeholder="${esc(L.costPlaceholder)}" aria-label="${esc(L.setCost)}">`;

    return `
      <div class="forecast">
        <div style="flex:2 1 320px"><div class="eyebrow is-inferred">${esc(L.inferred)} · ${esc(L.untilRenewal)}</div>${allowance}</div>
        <div><div class="eyebrow">${esc(L.payback)}</div>${payback}</div>
      </div>
      ${cycleStripHtml(proj)}
    `;
  }

  function cycleStripHtml(proj) {
    const L = t();
    const seg = proj.seg;
    if (!seg || (!seg.past.length && !seg.future.length)) return "";

    const span = (a, b) => `${shortDate(dayKey(a))} → ${shortDate(dayKey(b))}`;
    const rows = [];

    // A segment whose days were never fetched has nothing to say; a row of dashes only
    // invites it to be read as "no usage".
    for (const p of seg.past) {
      if (!p.covered) continue;
      rows.push([span(p.start, p.end), L.cyclePast, p.spend > 0 ? usd(p.spend) : "—", "past"]);
    }

    rows.push([
      span(seg.current.start, seg.current.end),
      L.cycleNow,
      seg.current.ceiling
        ? `${usd(seg.current.spend)} <span class="inf">/ ${usd(seg.current.ceiling)}</span>`
        : usd(seg.current.spend),
      "now",
    ]);

    // Every opening grants the whole ceiling, including the one the billing period cuts
    // short — so the strip shows full grants and marks where the period ends, rather than
    // pro-rating and contradicting the headline above it.
    for (const f of seg.future) {
      rows.push([
        span(f.start, f.end),
        f.endsEarly ? `${L.cycleNext} · ${L.cycleCutShort}` : L.cycleNext,
        proj.ceiling ? usd(proj.ceiling) : "—",
        "ahead",
      ]);
    }

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
                <td class="n strong">${kind === "ahead" ? `<span class="inf">${amount}</span>` : amount}</td>
              </tr>`,
            )
            .join("")}</tbody>
        </table></div>
        ${seg.hiddenOpenings ? `<div class="readout" style="margin-top:6px"><span>${esc(L.cycleHidden(seg.hiddenOpenings))}</span></div>` : ""}
      </div>
    `;
  }

  function periodHeadHtml(s) {
    const L = t();
    const p = periodRange();
    const grant = periodAllowances();
    const ceiling = cycleReading()?.ceiling;
    const granted = grant && ceiling ? grant.windows * ceiling : null;

    return `
      <div class="gauge-head">
        <div>
          <div class="eyebrow">${esc(L.measured)} · ${esc(L.periodTotal)}</div>
          <div class="amount">${usd(s.credits)}</div>
        </div>
        ${
          granted
            ? `<div class="right">
                 <div class="eyebrow is-inferred">${esc(L.inferred)} · ${esc(L.periodGranted)}</div>
                 <div class="amount small is-inferred">${usd(granted)}</div>
               </div>`
            : ""
        }
      </div>
      ${
        granted
          ? `<div class="readout" style="margin-top:10px">
               <span>${esc(L.periodWindows(grant.windows, usd(ceiling)))}</span>
               <span>${esc(grant.resets > 0 ? L.periodResets(grant.resets) : L.periodNoReset)}</span>
               <span>${esc(L.periodFloor)}</span>
             </div>`
          : ""
      }
      <div class="readout" style="margin-top:${granted ? "6px" : "14px"}">
        <span>${esc(L.periodSpan(shortDate(p.from), shortDate(p.to)))}</span>
        <span>${esc(L.activeDays)} <b>${esc(s.days)}</b></span>
        <span>${esc(L.dailyAvg)} <b>${usd(s.days ? s.credits / s.days : 0)}</b></span>
        <span>${esc(L.turnsTotal(int(s.turns)))}</span>
      </div>
      <div class="why">${esc(p.isBilling ? L.periodWhy : L.monthWhy)}</div>
    `;
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

  function surfaceHtml(days) {
    const L = t();
    const rows = surfaceSplit(days);
    // One row saying "CLI 100%" is a table that tells you nothing. It earns space only
    // once work is actually spread across more than one place.
    if (rows.length < 2) return "";
    const total = rows.reduce((a, r) => a + r.credits, 0) || 1;

    return `
      <h2>${esc(L.bySurface)}<em>${esc(L.bySurfaceSub)}</em></h2>
      <div class="scroll" tabindex="0" role="region" aria-label="${esc(L.bySurface)}"><table>
        <thead><tr><th>${esc(L.thSurface)}</th><th class="n">${esc(L.thCost)}</th><th class="n">${esc(L.thShare)}</th><th class="n">${esc(L.thTokens)}</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr>
              <td>${esc(SURFACES[r.name] || r.name)}</td>
              <td class="n strong">${usd(r.credits)}</td>
              <td class="n">${pct(r.credits / total)}</td>
              <td class="n">${tokenCount(r.tokens)}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table></div>
    `;
  }

  function dayTableHtml(days) {
    const L = t();
    const rows = [...days].reverse();
    const anyLoc = rows.some((d) => d.loc.added || d.loc.removed);

    return `
      <h2>${esc(L.byDay)}<em>${esc(L.byDaySub(rows.length))}</em></h2>
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
    const rows = [...s.models.values()].sort((a, b) => b.credits - a.credits);
    return `
      <h2>${esc(L.byModel)}<em>${esc(L.byModelSub)}</em></h2>
      <div class="scroll" tabindex="0" role="region" aria-label="${esc(L.byModel)}"><table>
        <thead><tr>
          <th>${esc(L.thModel)}</th><th class="n">${esc(L.thCost)}</th><th class="n">${esc(L.thShare)}</th>
          <th class="n">${esc(L.thTurns)}</th><th class="n">${esc(L.thPerTurn)}</th><th class="n">${esc(L.thTokens)}</th>
        </tr></thead>
        <tbody>${rows
          .map(
            (m) => `<tr>
              <td>${esc(m.name)}</td>
              <td class="n strong">${usd(m.credits)}</td>
              <td class="n">${pct(m.credits / (s.credits || 1))}</td>
              <td class="n">${m.turns ? esc(int(m.turns)) : "—"}</td>
              <td class="n">${m.turns ? usd(m.credits / m.turns) : "—"}</td>
              <td class="n">${tokenCount(m.tokens)}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table></div>
    `;
  }

  function rankTableHtml(title, rows) {
    const L = t();
    if (!rows.length) return "";
    return `
      <div>
        <h2>${esc(title)}</h2>
        <div class="scroll" tabindex="0" role="region" aria-label="${esc(title)}"><table>
          <thead><tr><th>${esc(L.thName)}</th><th class="n">${esc(L.invocations)}</th></tr></thead>
          <tbody>${rows
            .slice(0, 12)
            .map((r) => `<tr><td>${esc(r.name)}</td><td class="n strong">${int(r.count)}</td></tr>`)
            .join("")}</tbody>
        </table></div>
      </div>
    `;
  }

  function notesHtml(days) {
    const L = t();
    const win = state.win;
    const first = days[0];
    // Any opening that is not exactly midnight UTC shares its day with the window before it.
    const opensMidDay = win && win.startAt % DAY_MS !== 0;
    const overlap = state.view === "cycle" && opensMidDay && first && first.date === dayKey(win.startAt);

    const items = [
      [L.n1, false],
      [L.n2(USD_PER_CREDIT), false],
      ...(win && !win.inferable ? [[L.n11, true]] : [[L.n3, false]]),
      ...(overlap ? [[L.n4(clock(win.startAt), first.date, usd(first.credits)), true]] : []),
      [L.n5, false],
      [L.n6, false],
      [L.n8, false],
      [L.n9, false],
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
    if (days < 1) return L.windowHours(state.win.planType, Math.round(state.win.windowSec / 3600));

    const shown = Number.isInteger(days) ? String(days) : days.toFixed(1);
    return L.window(state.win.planType, shown);
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
    const surface = surfaceHtml(days);
    const skills = rankTableHtml(L.topSkills, rankInvocations(state.skills, "skill_usage_overviews", "skill_name", from, to));
    const plugins = rankTableHtml(L.topPlugins, rankInvocations(state.plugins, "plugin_usage_overviews", "plugin_name", from, to));

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
        ${surface ? `<div class="rule"></div>${surface}` : ""}
        <div class="rule major"></div>
        ${dayTableHtml(days)}
        <div class="rule"></div>
        ${modelTableHtml(s)}
        ${skills || plugins ? `<div class="rule"></div><div class="two-up">${skills}${plugins}</div>` : ""}
        ${notesHtml(days)}
      </div>
    `;
  }

  function render() {
    const root = state.root;
    if (!root) return;
    const L = t();
    const periodLabel = state.ent ? L.period : L.calendarMonth;

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
      if (!state.loaded && !state.loading) load();
      else render();
    };

    // Move focus into the dialog on open, so Escape and Tab land where the reader is looking.
    const panel = root.querySelector(".panel");
    if (panel && state.open && !root.contains(root.getRootNode().activeElement)) panel.focus();

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
        localStorage.setItem(COST_KEY, String(Number(cost.value) || 0));
        render();
      };

    const close = root.querySelector('[data-act="close"]');
    if (close)
      close.onclick = () => {
        state.open = false;
        render();
      };

    const reload = root.querySelector('[data-act="reload"]');
    if (reload)
      reload.onclick = () => {
        if (!state.loading) load();
      };

    const scrim = root.querySelector(".scrim");
    if (scrim)
      scrim.onclick = (e) => {
        if (e.target === scrim) {
          state.open = false;
          render();
        }
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

      const [usage, check] = await Promise.all([
        api("/backend-api/wham/usage", state.token),
        soft("/backend-api/accounts/check/v4-2023-04-27", state.token),
      ]);

      state.win = readWindow(usage);
      state.ent = check ? readEntitlement(check) : null;
      if (!state.win) throw new Error(t().noWindow);

      /*
       * Reach back far enough to cover the billing period, the current cycle, and one whole
       * cycle before it. That last one is what the pace estimate is built on, so fetching a
       * partial slice of it would quietly understate every projection.
       */
      const today = dayKey(Date.now());
      const priorCycle = dayKey(state.win.startAt - state.win.windowSec * 1000);
      const from = [dayKey(state.win.startAt), periodRange().from, priorCycle].sort()[0];

      const data = await fetchAll(state.token, from, today);
      state.days = data.days;
      state.unknownModels = data.unknownModels;
      state.unpricedFast = data.unpricedFast;
      state.fetchedFrom = data.fetchedFrom;
      state.skills = data.skills;
      state.plugins = data.plugins;
      state.loaded = true;

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
    if (e.key === "Escape" && state.open) {
      state.open = false;
      render();
    }
  });

  mount();
  render();
})();
