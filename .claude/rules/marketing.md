---
paths:
  - "src/components/landing/**"
  - "src/components/marketing/**"
  - "src/app/page.tsx"
  - "src/app/for-professionals/**"
  - "src/app/*legal*/**"
  - "src/app/changelog/**"
  - "src/app/rebrand/**"
  - "src/app/updates/**"
  - "src/lib/seo/**"
  - "scripts/send-*-email.ts"
  - "README.md"
---

# Marketing surfaces and positioning

Marketing surfaces (landing page copy, FAQ, pricing, e-mails, README feature sections, any in-app
marketing surface) follow product design, not the agent style rules in `AGENTS.md`. They do follow
the positioning rules below. The landing page is shown only when `IS_HOSTED=true`
(`src/app/page.tsx`).

## Positioning rules

Chatterbox is **not** positioned as a Plaud competitor or a "subscription killer." Even though Plaud
is the only device family supported today, marketing copy stays vendor-agnostic and forward-looking:

- Frame Chatterbox as a **multi-device transcription layer**, not a Plaud alternative.
- Use the category noun **"voice recorders"** (not "Plaud devices") wherever possible.
- Plaud references are factual / interoperability only ("currently supports the Plaud Note
  family"). No "replace", "subscription", "cheaper than", "$X/mo", or "skip the subscription"
  framing.
- When pricing context is needed, present it survey-style across 3+ vendors (Plaud Pro, Otter
  Business, Rev AI Pro, not just Plaud) with each vendor's published number. No qualitative claims.
- Do not republish disparaging third-party quotes about Plaud (the previous `reddit-quotes.tsx` was
  removed for commercial-disparagement risk; do not reinstate without legal review).
- A future Chatterbox-branded device is on the roadmap but **must not be announced** in any
  user-facing copy until product confirms.
- **Write marketing copy for the non-technical user.** The hosted product exists for people who
  don't want to think about infrastructure; that's the audience for landing, FAQ, pricing, e-mails,
  and any in-app marketing surface. Name real vendors and outcomes ("OpenAI, Anthropic, Groq",
  "your recordings, your transcripts"), not categories or implementation details
  ("OpenAI-compatible providers", "S3-compatible object storage", "JWT bearer tokens"). Technical /
  self-host readers parse plain-user language fine; the reverse isn't true.
  Implementation-detail language belongs in `README.md`, docs, release notes, and code comments,
  not marketing surfaces. Per-vendor escape hatches ("+ any OpenAI-compatible endpoint")
  stay as tail clauses for the technical reader, never as the lead.
- **Never claim compliance we don't own.** HIPAA, SOC2, attorney-client privilege: the claim belongs
  to the user's AI provider and their self-host setup, not to Chatterbox.

## Audience slices

- **Slice 1: voice recorder owners who want choice** (default path; hero, features, pricing, the-math
  target these). Driver: own your transcripts, choose your AI, choose your storage, leave anytime.
  Don't care where the code runs.
- **Slice 2: privacy / compliance professionals** (`for-professionals.tsx`): lawyers, journalists,
  consultants, researchers. Driver: sovereignty. Default to self-host + local AI (Whisper /
  Ollama). Care about auditability (AGPL) and infrastructure control.

## Delivery tiers

- **Self-host (free, forever)**: AGPL source, `docker compose up`. Shipped. Default for Slice 2.
  `IS_HOSTED` unset or false.
- **Hosted**: same codebase, `IS_HOSTED=true`, operated by upstream Riffado (`.claude/rules/hosted.md`).

## Marketing-vs-product gap

Chatterbox has "marketing ahead of code" in some places. **Always cross-check landing / pricing /
changelog claims against actual code before designing features that depend on them.** Known gaps:

- Plaud refresh-token handling was removed (`0d31b39b`); Plaud issues only long-lived access tokens
  (~300 day JWT). Do not re-add refresh-token plumbing.

## Screenshots

Dev screenshot route: `/dev/demo-dashboard` (dev-only, hidden in production) renders the real
dashboard `<Workstation>` against hand-curated fixtures in `src/lib/demo/fixtures.ts`. Used to
capture marketing screenshots without polluting a real account. Summaries for `demo-` ids are
served by a dev-only branch in `/api/recordings/[id]/summary` GET; audio playback is intentionally
broken (404) since screenshots don't need it. User-guide screenshots use the demo stack instead
(`.claude/rules/i18n.md`, Docs pages).
