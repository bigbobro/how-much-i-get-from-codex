> **5-hour usage limit — 70% remaining. Weekly usage limit — 40% remaining.**

70% of *what*, exactly? OpenAI has never said. The two bars answer different questions,
and the dollar denominator does not appear anywhere in the product or the docs.

This panel works it out.

### What you get

- What one allowance is actually worth, in dollars
- How much the current week has used, and how much remains
- How many more allowances open before your subscription renews
- What a turn costs you. What a thousand lines of code costs you.
- Which day, which model and which surface ate the most

The desktop panel keeps quota status at the top and the billing-period summary below it.
Switch **Current window / This subscription** within usage analysis to update its subtotal,
metrics, four aligned charts and usage details together. The quota status, subscription-cost
input and billing summary stay in place. Forecast calculations and window history expand below.

### How

The usage endpoint returns one of three shapes: a 5-hour bar beside a 7-day bar, a 7-day
bar alone, or a longer monthly-style window. The 5-hour percentage is a short-term signal
and is never a dollar ceiling; current-week spend divided by the weekly percentage gives the
weekly ceiling, and that ceiling drives the subscription forecast. The forecast counts the
windows that open before renewal and never extends a daily average. The two percentages are
never mixed into one denominator. A 5-hour bar does not appear on its own.

Two spend endpoints each hold half of the dollar measurement. One says what a day cost in
credits. The other says what percentage of an allowance that same day ate. Divide, and
there it is.

On a real Plus account: **49.897 credits per percent, on all 26 days with usage, spread of
exactly zero.** One of those days came in at 100.000% — an entire week's allowance, gone in a
single afternoon.

Token-only days use OpenAI's current Codex rate card, checked 2026-08-10. The dollar display
uses an explicit $0.04-per-credit assumption from the credit purchase page; it is configurable
because OpenAI does not publish a universal credit-to-dollar exchange rate.

A reached limit is its own measurement: the spend standing when the API closed is one whole
allowance, no denominator involved. When the daily percentages disagree with it — seen live
after a plan moved from a monthly to a weekly allowance while the daily endpoint kept the old
denominator — the depletion point wins and the disagreement is spelled out.

### What it won't do

Guess. A five-hour percentage only appears beside a 7-day bar, and is shown as status, not
turned into a dollar ceiling, because usage only arrives in whole days. Some plans report
0% used forever while the reset time quietly slides along with the clock. When the ground
gives way it tells you and shows nothing, because a confident wrong number is worse than a
blank.

Measured values and inferred capacity are labelled separately; dashed lines and hatched
segments identify projections in the dark green interface.

### Privacy

It asks for nothing until you click it. No polling, no requests on page load, nothing left
running after you close it. Every call goes to chatgpt.com, scoped to your own seat, and no
third party is involved at any point.

---

Plus, Pro, Business, Team. English and Chinese. Window length is read from the API and never
assumed — the same plan ships weekly on one account and monthly on another. The panel names
the installed version, and the trigger appears on the Codex usage page
(<https://chatgpt.com/codex/settings/usage> or
<https://chatgpt.com/codex/cloud/settings/analytics>).

Source, and the full derivation of every number:
<https://github.com/bigbobro/how-much-i-get-from-codex>
