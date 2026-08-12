> **Monthly usage limit — 70% remaining.**

70% of *what*, exactly? OpenAI has never said. The number on the other side of that
percentage sign does not appear anywhere in the product or the docs.

This panel works it out.

### What you get

- What one allowance is actually worth, in dollars
- How much is left, and when you run out at your current pace
- How many more allowances open before your subscription renews
- What a turn costs you. What a thousand lines of code costs you.
- Which day, which model and which surface ate the most

### How

Two endpoints each hold half the answer. One says what a day cost in credits. The other says
what percentage of an allowance that same day ate. Divide, and there it is.

On a real Plus account: **49.897 credits per percent, on all 26 days with usage, spread of
exactly zero.** One of those days came in at 100.000% — an entire week's allowance, gone in a
single afternoon.

Token-only days use OpenAI's current Codex rate card, checked 2026-08-10. The dollar display
uses an explicit $0.04-per-credit assumption from the credit purchase page; it is configurable
because OpenAI does not publish a universal credit-to-dollar exchange rate.

### What it won't do

Guess. Some plans run a five-hour window; some report 0% used forever while the reset time
quietly slides along with the clock. When the ground gives way it tells you and shows
nothing, because a confident wrong number is worse than a blank.

Solid means measured. Dashed amber means worked out. You always know which one you are
looking at.

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
