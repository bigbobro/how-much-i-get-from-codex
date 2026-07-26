# How Much I Get From Codex

**[English](README.md) · [中文](README.zh-CN.md)**

A Tampermonkey panel for the Codex analytics page. It works out the number OpenAI does not
publish: **how much API usage your subscription actually gives you.**

The official page shows one bar — *Monthly usage limit, 70% remaining*. 70% of what? The
denominator is never named anywhere. This reads it off the API.

![](docs/panel-light.jpg)

<sub>Dark theme: <a href="docs/panel-dark.jpg">docs/panel-dark.jpg</a></sub>

For anyone on Plus, Pro, Business or Team who uses Codex enough to wonder what the
subscription is really worth.

**It requests nothing until you open it.** No polling, nothing on page load, nothing left
running after you close it.

---

## What it tells you

- What one allowance is worth, and how many you have used
- What is left in the current window, and when you run out at your pace
- How much more opens before your subscription renews
- What a turn costs, and what a thousand lines of code costs
- Which day, which model, and which surface took the most

---

## How the allowance is read

Two endpoints each hold half the answer:

| Endpoint | Gives | Missing |
|---|---|---|
| `daily-workspace-usage-counts` | what each day cost, in credits | what a full allowance is |
| `usage/daily-token-usage-breakdown` | each day as a **percentage of one allowance** | any amount |

Divide one by the other and you have the value of one percent:

```
allowance = a day's credits ÷ that day's percentage × 100
```

On a live Plus account that ratio came out at **49.897 credits per percent on all 26 days
with usage, with a spread of exactly zero** — an allowance of 4,989.7 credits. One of those
days landed on exactly 100.000%, so the figure can also just be read straight off it.

A single day is enough, and the rate limit window is never involved. That matters, because
the window is not always real: on some plans `used_percent` sits at 0 permanently while
`reset_at` slides forward with the clock. Dividing spend by that produces a confident number
resting on nothing. The panel detects it and hides everything built on those boundaries.

It also disposes of the question *when will it reset next*, by never asking. A day's
percentage is how much of an allowance that day ate, so adding them up counts allowances
directly. Crossing 100% means another one was spent.

### Where credits come from

Personal plans report credits directly, and reported credits always win. Plans that meter no
credits report 0, and only then does the script price the tokens itself from the
[official rate card](https://help.openai.com/en/articles/20001106-codex-rate-card).

| Model | Uncached input | Cached input | Output |
|---|---|---|---|
| gpt-5.6-sol | 125 | 12.5 | 750 |
| gpt-5.6-terra | 62.5 | 6.25 | 375 |
| gpt-5.6-luna | 25 | 2.5 | 150 |
| gpt-5.5 | 125 | 12.5 | 750 |
| gpt-5.5-cyber | 500 | 50 | 3000 |
| gpt-5.4 | 62.5 | 6.25 | 375 |
| gpt-5.4-mini | 18.75 | 1.875 | 113 |
| gpt-5.3-codex | 43.75 | 4.375 | 350 |
| gpt-5.2 | 43.75 | 4.375 | 350 |

Credits per 1M tokens. Fast mode multiplies them — **2.5×** for GPT-5.6 and 5.5, **2×** for
GPT-5.4 ([source](https://learn.chatgpt.com/docs/agent-configuration/speed)) — and the script
reads the `speed` field so each tier is priced separately.

### Dollars

**1 credit = $0.04**, checked against OpenAI's
[published API prices](https://developers.openai.com/api/docs/pricing). Every rate card entry
divides into its list price at exactly that rate:

| | rate card | list price | $/credit |
|---|---|---|---|
| gpt-5.6-sol input | 125 credits / 1M | $5.00 / 1M | 0.0400 |
| gpt-5.6-luna input | 25 | $1.00 | 0.0400 |
| gpt-5.4-mini input | 18.75 | $0.75 | 0.0400 |
| gpt-5.6-sol output | 750 | $30.00 | 0.0400 |

Six models across three token classes, eighteen checks, all landing on the same number.
Change `USD_PER_CREDIT` at the top of the script if OpenAI ever moves it.

Note what the dollar figure means: **what the same work would cost at API list price.** Not
OpenAI's cost, and not the price of the allowance.

---

## Where it refuses to answer

A wrong number stated confidently is worse than a blank, so the panel withholds a figure
whenever the ground under it gives way:

- **The window is shorter than a day.** Usage only arrives in whole UTC days, so a five-hour
  window has nothing to divide into. No ceiling, no cycle view.
- **The window never opens.** 0% used with a reset that slides forward is a placeholder. The
  measured allowance and the spending still stand; the cycle boundaries and everything
  counted off them are hidden.
- **The allowance changed mid-period.** Then "N windows × today's allowance" would overstate
  what the payment bought — 43% high on a doubling. The count is shown, the product is not.
- **Fast mode with no published multiplier.** Priced at the standard rate and flagged as
  understated, rather than borrowing a neighbouring model's multiplier.
- **A model missing from the rate card.** The reported credits take over.

### Projections

Two things open an allowance: the window rolling on its own schedule, and a **reset card**
spent by hand to open one early. Both are readable — `reset_at` steps forward on a fixed
boundary, and `rate_limit_reset_credits.available_count` says how many cards are left — so
the forecast is arithmetic rather than a guess about the future.

Spending is capped per window, not per day. Burn an allowance on the first morning and the
rest of that window yields nothing however fast you were going, so a daily average run
forward will happily print totals the account cannot reach. The projection is capped by the
allowances that actually open before renewal, and the panel names which constraint is
binding.

---

## Known biases, and which way they point

These are not unknowns. They lean in a known direction — read the numbers with them in mind.

| Source | Direction |
|---|---|
| **The pool is shared.** Codex, ChatGPT Work and ChatGPT for Excel draw on one allowance, but this API only sees Codex | Spend reads low, so the allowance reads low |
| **Cycle boundaries do not align with days.** The window opens at a timestamp; usage is bucketed by whole UTC days, and `group_by=hour` is rejected | The opening day is over-counted, so cycle spend reads high. Flagged when it happens |
| **The window percentage is coarse** — reported to the integer | Only affects the fallback path, used when no daily percentages exist |

Two things the API does not expose at all:

- **Per-turn cost.** The finest grain is day × model × speed, so the panel gives the dearest
  *day* per turn and the dearest *model* per turn instead.
- **Per-repository spend.** `code-attribution` accepts `group=workspace` and rejects
  everything else, so there is no split by project. Surface — CLI, VS Code, web, GitHub — is
  the closest available.

### Which subscription you are looking at

One login can hold a personal Plus and a workspace seat at once. The Codex endpoints answer
for whichever context Codex is in, and that is **not always the account the profile menu
names** — a `ChatGPT-Account-ID` header does not override it. The masthead therefore carries
the plan and the account email, and says so outright when more than one subscription is live.

Every request carries `workspace_user=true`, so the figures cover the current seat only.

---

## Install

The repository is private, so a one-click raw link will not resolve. By hand:

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. New script in the dashboard, paste in
   [`how-much-i-get-from-codex.user.js`](how-much-i-get-from-codex.user.js)
3. Open <https://chatgpt.com/codex/cloud/settings/analytics> and click the label in the
   top-right corner

Interface language follows the browser and can be switched in the panel.

`@match` fires on page load, so arriving at Analytics through the settings sidebar leaves no
trigger — reload once and it is there.

---

## Development

`smoketest.html` replays recorded API responses at the script, with no network and no login:

```bash
python3 -m http.server 8731
```

| Scenario | What it covers |
|---|---|
| *(default)* | rate card + window division. **Must read $249.83 spent / $250.00 ceiling** |
| `#personal` | Plus-style: the workspace breakdown 400s, allowance measured at **$199.59** |
| `#multi` | 7-day window, a completed cycle, multi-opening forecast |
| `#boundary` | windows opening at 06:00 UTC — segments must partition the days exactly |
| `#changed` | allowance doubles mid-range; the reading follows today and says what it dropped |
| `#unknownmodel` | a metered day whose only model is not in the rate card — must never show NaN |
| `#bank` | reset cards left, counted on top of the windows that roll on their own |
| `#twosubs` | one login, two subscriptions — the panel must name which one it reports |
| `#hourly` | 5-hour window — refuses to infer, and says why |
| `#fresh` | placeholder window |
| `#fast` | fast mode, including a model with no published multiplier |
| `#noent` | no renewal date — falls back to the calendar month |

The default case is the regression that matters: recorded real usage, and $250.00 is the
ceiling it has to reproduce.

The stub honours `start_date` / `end_date` deliberately. One that returned everything would
let a scenario pass on data the script never fetched, which is how an under-fetching bug
survives a green test.

---

## Licence

MIT
