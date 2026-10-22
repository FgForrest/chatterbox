---
title: AI cost is priced from the provider card that made the call, recorded once and never repriced, and shown for every payer
date: 2026-10-19
updated: 2026-10-22 17:05
status: accepted
kind: feature
issues: []
prs: [77, 78, 85, 170, 179]
areas: [src/lib/ai/usage-cost.ts, src/lib/ai/published-rates.ts, src/lib/ai/provider-rate-input.ts, src/components/recordings/ai-cost-summary.tsx, agent-bridge/lib.mjs, src/db/schema.ts]
supersedes: []
superseded-by: []
relates: [2026-10-19-provider-defaults-and-no-fallback, 2026-09-28-agent-bridge-cli-providers]
---

# AI cost is priced from the provider card that made the call, recorded once and never repriced, and shown for every payer

Every AI request on a recording or mail (transcription, summary, topics, Learn, title) records its
usage and an estimated USD cost at the moment it is made. The price comes from the provider card the
call went through: a price typed on that card, else the published price for that model, else
"unknown". Unknown is kept as unknown, never as free. A price set later applies only to future
requests. The item header shows the total spent on the item, whoever paid, and names the payer.

## Why

- **People could not see what processing cost.** Multi-pass summaries, Learn and paid transcription
  vendors made cost per recording a real question, and a subscription-backed bridge reports tokens
  but no bill.
- **The first rate design silently did nothing.** PR #77 keyed custom rates by a typed provider name
  and a free-text model id. Nothing helped pick the model, a typo saved without error and never
  matched, and two cards with the same provider and model had to share one price.
- **Organization-paid work showed no cost.** Once Organization providers paid for members, the
  header counted only the viewer's own payer rows, so a recording processed entirely on
  Organization keys showed `$??` although it had been transcribed, learned and summarized. `$??`
  also stood for two different states: nothing tracked, and tracked without a price.

### Previous state

PR #77 (2026-10-01) added `ai_usage_events` with a price snapshot per request and a separate
`ai_cost_rates` table of per-model overrides; published rates applied only to matching official
endpoints. PR #78 made the agent bridge forward Claude Code's reported tokens and cost and derive
Codex usage from `turn.completed`, labelled as API-equivalent estimates rather than subscription
charges.

## Options considered

### Option A: a price on each provider card (chosen, PR #85)

`api_credentials` gains `input_usd_per_million`, `output_usd_per_million` and `audio_usd_per_hour`.
The Add, Edit and Duplicate dialogs show only the units the provider reports, with the published
price as the placeholder. Usage events carry `credentialId`.

- **Pros:** the price sits where the model is chosen; no free-text matching; two cards for the same
  model (direct and through a proxy, say) can have different prices.
- **Cons:** a migration that drops `ai_cost_rates`; any rows in it were lost (it never shipped in a
  tagged release).

### Option B: a shared rate table keyed by provider name and model (declined)

Either the `ai_cost_rates` form of PR #77, or the same storage filled from the card instead of a
standalone form, which needed no migration.

- **Pros:** no schema change in the second variant.
- **Cons:** cards with the same provider name and model share one price.
- **Rejected because:** the maintainer: "Shared rates are non-sense." A price belongs to the card a
  call went through. Revisit only if cards stop being the unit people configure.

### Reprice past requests when a price is set (declined)

Fill in costs on earlier requests that show "unknown" once a price exists.

- **Rejected because:** the maintainer ruled "no update of existing recordings". A recorded cost is a
  snapshot of the price that applied when the request was made, and repricing would rewrite that
  history (inferred). This is also why a request made before the bridge knew a model's rate stays
  unpriced after the bridge is rebuilt (PR #231).

### An "Included in subscription" toggle for Claude Code and Codex (declined)

A checkbox storing $0 rates, so subscription-backed cards show $0 instead of "unknown".

- **Rejected because:** the maintainer chose the plain rate fields; whoever wants subscription calls
  counted as free types 0. One fewer setting, and "unknown" stays honest for those who do not.

### Whose spend the header shows (2026-10-19)

- **Everything on the item, whoever paid (chosen).** One payer: a single sentence for the whole
  summary ("Paid by the Organization."). Several payers: each line marked with its payer.
- **Yours plus the Organization's, other members' personal keys hidden (declined).** The maintainer
  chose the full figure with payer marks instead.
- **Only what you paid (declined).** This was the old rule; it showed `$??` for Organization-paid
  recordings.

## Decision

**Chosen: Option A, no repricing, no subscription toggle, every payer shown.** The price has one home,
the card, and a cost is fixed when the request is made, so the figure on an item never changes
behind the user's back. Showing every payer gives the true cost of an item; naming the payer keeps
it clear who carried it.

## Key technical details

- **A card's price applies only to the card's own model** (`cardRate` in `src/lib/ai/usage-cost.ts`).
  A call that fell back to another model, such as a Whisper card writing a title through a chat
  model mapped from its base URL, keeps the catalog price, because that is not what the user
  priced.
- **Published prices** live in `src/lib/ai/published-rates.ts`, shared by the dialogs and the
  estimate, and apply only to the vendor's own HTTPS API: a proxy, a local server or a plain-HTTP
  endpoint may bill differently or not at all. A token rate without its pair is rejected on client
  and server (`src/lib/ai/provider-rate-input.ts`).
- **The agent bridge prices Codex turns from its own table**, `CODEX_MODELS` in `agent-bridge/lib.mjs`.
  A model missing there reports tokens but no cost, and the item shows "unpriced"; the card price is
  the only other source. Every new Codex model needs a rate there and a bridge image rebuild
  (PR #231).
- **Display rules** (`src/components/recordings/ai-cost-summary.tsx`, PR #170 and PR #179): priced
  `$0.45`; partly priced `≥ $0.45` (read as "at least" by screen readers); nothing priced "unpriced"
  with a note why; nothing tracked shows nothing. The spend sits at the end of the header's metadata
  row for recordings and mail alike.
- **Payer identity:** a payer is "you", "the Organization" or a member's display name; an e-mail is
  never used as a name. The cost route still requires that the viewer may see the item.
- **Backup:** per-card prices export as `ai/provider-rates.json`, without keys.

## Verification

- `src/tests/ai/provider-pricing.test.ts` (catalog, input parsing, card-rate application; PR #85
  suite 2,281 tests). `src/tests/recordings/ai-cost.integration.test.ts` (10 tests: single payer,
  mixed payers, unknown costs, name fallback) and `ai-cost-summary.test.tsx`.
  `src/tests/ai/agent-bridge.test.ts`: a `gpt-6.1-sol` turn with cached input and cache writes, and an
  unknown model staying unpriced (80/80 bridge tests).

## Consequences & open follow-ups

- Requests recorded before a price existed stay unpriced for good.
- Bridge-reported costs are estimates of API list prices, not what a subscription charges.
- A new Codex model shows "unpriced" until the bridge's rate table and image are updated; the
  `gpt-6.1-sol` rates came from price trackers and could not be confirmed on the vendor's own page.

## Related work

- [2026-10-19-provider-defaults-and-no-fallback](2026-10-19-provider-defaults-and-no-fallback.md):
  Organization defaults made Organization-paid processing common, which is why spend shows every
  payer.
- [2026-09-28-agent-bridge-cli-providers](2026-09-28-agent-bridge-cli-providers.md): the bridge
  that reports Claude Code and Codex usage and keeps the Codex rate table.

## Timeline

- **2026-10-01**: PR #77 (usage and cost per recording) and PR #78 (Claude Code and Codex estimates)
  merged.
- **2026-10-05**: per-card prices decided, no repricing, no subscription toggle; PR #85 merged.
- **2026-10-19**: PR #170 (spend in the header's metadata row) merged; every payer shown and the
  unknown-price display agreed; PR #179 merged.
- **2026-10-22**: follow-up, outside this line: PR #231 added the bridge rate for a new Codex model
  (a price-table update).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
