---
title: Organization providers are every member's defaults per role, explicit choices fail loudly, and nothing falls back to a hard-coded model
date: 2026-10-19
updated: 2026-10-22 16:00
status: accepted
kind: feature
issues: []
prs: [70, 76, 144, 153, 178]
areas: [src/lib/ai/default-provider.ts, src/lib/ai/provider-resolution-order.ts, src/lib/ai/enhancement-provider.ts, src/lib/ai/list-providers.ts, src/lib/profiles/organization-providers.ts, src/lib/profiles/default-rule.ts, src/components/settings/provider-card.tsx]
supersedes: []
superseded-by: []
relates: [2026-10-19-processing-profiles-and-workflow, 2026-10-05-ai-cost-per-provider-card, 2026-10-19-employee-first-onboarding, 2026-09-23-shared-organization-scope]
---

# Organization providers are every member's defaults per role, explicit choices fail loudly, and nothing falls back to a hard-coded model

Whoever manages Organization providers sets an Organization default per role (transcription,
summaries, Learn, topics, titles). Every member uses it for anything a profile does not pin, private
items included, until they choose a default of their own; members may also choose any Organization
provider as their own default. A choice someone made explicitly (a profile pin, a member's own
pointer) that is missing, disabled or no longer authorized stops the step with an error naming that
choice and never falls through to another payer's key. Two implicit fallbacks remain at the end of
the order: the member's own oldest enabled chat provider (for single-user self-host) and the
Organization's oldest suitable provider (for new members). There is no fallback to a hard-coded
model: a chat provider without a Default Model cannot be saved and fails at use. Organization
profiles follow the same pattern as defaults per channel.

## Why

- **A fresh install with Organization providers showed members an empty default picker.** The
  processing-pipeline design let members reach Organization providers only through profile pins
  ([processing profiles and workflow](2026-10-19-processing-profiles-and-workflow/README.md), D6 and
  its "no silent fallback to another payer's key"). A step left unpinned used the executing
  person's own default, so a member without keys of their own got nothing unless every profile
  named a provider. The maintainer: "we want to setup central organization providers for every
  member of organization to use."
- **A hidden model fallback produced misleading errors.** A chat provider without a Default Model
  silently ran on `gpt-4o-mini`. Once the agent bridge routed every `gpt-` id to Codex (PR #151), a
  bridge provider left without a model failed with Codex's refusal of `gpt-4o-mini` instead of the
  cause. The fallback had been reported gone on the strength of a truncated search; a review bot
  found it still in place.
- **New members still could not transcribe.** On a self-hosted Organization whose providers
  predated Organization defaults, no default pointers existed: the upgrade copied only defaults the
  Organization login already had, and nothing in the UI flagged their absence. A new member had no
  candidate at all and every transcription failed with `NO_TRANSCRIPTION_PROVIDER`.
- **Constraint:** the Organization pays for these calls, so whose key runs must be predictable, and
  single-user self-host must keep summarizing without anyone ever picking a default.

### Previous state

PR #70 (2026-09-30) replaced the per-row "Use for" buttons with one picker per job and added
Duplicate, which copies a provider's encrypted key without decrypting it, so a second model of the
same provider needs no new token: models stay on credentials. PR #76 (2026-10-01) moved provider
choice into each AI feature's settings and gave Topics its own choice, defaulting to the summary
provider. Defaults were `is_default_*` flags on credential rows plus a `default_providers` JSON for
topics and titles, all personal.

## Options considered

### Option A: Organization default per role, members may override (chosen, 2026-10-17)

- **Pros:** a new member works without setup; the Organization pays and usage is shown per member;
  members keep their own keys if they want.
- **Cons:** a member's unpinned processing, including retries of earlier failed automatic
  transcriptions, silently moves to the Organization's keys once defaults exist; the upgrade note
  had to say so.

### Option B: members pick only (declined)

Each member's pickers list their own providers and the Organization's, with no Organization-wide
default.

- **Pros:** nothing changes for a member until they act.
- **Cons:** a new member has nothing until they choose.
- **Rejected because:** it fails the goal that triggered the change, members using central providers
  without setup.

### Option C: keep pins only (declined)

- **Pros:** whose key runs is always written in a profile.
- **Cons:** every Organization profile must pin every step, and personal private recordings can never
  use Organization providers.
- **Rejected because:** a fresh install showed members an empty picker; it was the rule being
  replaced.

### New members on an Organization without default pointers (2026-10-19)

- **(a) Fall back to the Organization's oldest enabled provider suited to the role, and show
  managers a notice with "Make default" (chosen).**
- **(b) No automatic fallback; warn managers and tell members the Organization has no default
  (declined).** Rejected because it contradicts "new members follow the Organization without
  setup"; the member still cannot work until a manager acts.

### The hard-coded model (2026-10-18)

- **Fix the fallback: no Default Model fails summaries, topics and Learn with "Set a Default Model
  on <provider>", and such a provider cannot be saved (chosen, breaking).**
- **Exempt exactly `gpt-4o-mini` in the bridge so it answers "Set a Default Model" (declined).**
  Rejected because `gpt-4o-mini` itself could then never go through the bridge, and every other
  provider kept the silent guess.
- **Keep routing as is and only correct the documentation (declined).** Rejected because the user
  sees Codex's refusal naming a model they never chose, not the cause.

## Decision

**Chosen: Option A, the Organization fallback (a), and no hard-coded model.** The order is
predictable because an explicit choice ends the search: if it cannot run, the step fails and says
which choice failed. Only when nobody chose anything do the two implicit fallbacks apply, and both
use a key the person or their Organization deliberately added. The review restored the member's own
oldest enabled chat provider as the last personal step after it had been dropped: without it a single-user
self-host that never picked a default would stop summarizing. What would change this: if an
Organization needed members to be unable to use central keys for private items, defaults would need
a scope switch.

The same pattern applies to profiles (PR #144): a member's default per channel is "Organization
default" (follows the curators), a specific Organization profile, or one of their own. New members
get no personal profiles seeded, and a member may delete all personal profiles and use only
Organization ones; a referenced profile is archived, not deleted, and is never re-seeded.

## Key technical details

- **Pointers:** `user_settings.default_transcription_provider_id` and `user_settings.default_providers`
  hold one credential id per role (own or Organization), written only by `setDefaultProvider()` in
  `src/lib/ai/default-provider.ts`. The `api_credentials.is_default_*` flags are mirrors of own rows;
  a legacy flag still counts when no pointer exists.
- **Order** (`src/lib/ai/provider-resolution-order.ts`, `defaultProviderCandidates`): member role,
  then member summary (for Learn, topics, titles), then Organization role, then Organization
  summary, then the member's oldest enabled chat provider (chat roles only), then the Organization's
  oldest suitable provider, then managed transcription where configured (hosted), then an error.
  The first explicit pointer found returns immediately; that early return is the "fail loudly"
  invariant, not an omission.
- **The Organization fallback** skips bridge presets for transcription and transcription-only
  providers for chat roles; ties break on `createdAt`, then `id`. It runs through the same
  authorization, payer, hourly cap and audit path as an Organization pin.
- **Profiles:** `src/lib/profiles/default-rule.ts`; pointers `user_settings.default_audio_profile_id`
  and `default_mail_profile_id` (migration 0131, additive, `ON DELETE SET NULL`).
- **Looks like a fallback, is not:** `enhancementChatModel()` in `src/lib/ai/enhancement-provider.ts`
  still maps a Default Model that is a Whisper id to a chat model per base URL (including
  `gpt-4o-mini` for plain OpenAI). That mapping was kept on purpose; only the blank-model guess went.
- **Upgrade note (PR #144):** in local-auth shared mode the Organization login's existing defaults
  became every member's defaults without a manager action.

## Verification

- `src/tests/profiles/provider-default-order.test.ts` (both orders), `src/tests/regressions/org-fallback-new-member.test.ts`
  (replays the state that blocked a new member), `src/tests/settings/organization-providers.integration.test.ts`,
  `organization-providers-card.test.tsx`, `provider-role-select.test.tsx`;
  `src/tests/ai/enhancement-provider.test.ts`, `provider-default-model-routes.test.ts`;
  `src/tests/ai/provider-duplicate.test.ts` (6 tests: ciphertext copied without decrypting, another
  user's source reads as missing, a key cannot move to another provider).
- PR #144: whole unit suite 3,798 passed, database suite 5,012 passed. PR #153: 3,856 unit and 5,078
  database tests. PR #178: 37 new tests, database suite 5,487 passed.

## Consequences & open follow-ups

- **Breaking (PR #153):** a provider used for summaries, titles, topics or Learn without a Default
  Model fails until one is set. The PR description carries the SQL to find such rows.
- Unpinned processing of members on an Organization without default pointers now runs on, and is
  paid by, the Organization's oldest suitable provider. Managers see a notice until they choose a
  default.
- The onboarding wizard counts inherited Organization providers as covering a role
  ([employee-first onboarding](2026-10-19-employee-first-onboarding.md)).

## Related work

- [2026-10-19-processing-profiles-and-workflow](2026-10-19-processing-profiles-and-workflow/README.md):
  introduced Organization providers with the pins-only rule this record replaces.
- [2026-10-05-ai-cost-per-provider-card](2026-10-05-ai-cost-per-provider-card.md): prices live on
  the same provider cards, and spend shows every payer once the Organization pays for members.
- [2026-10-19-employee-first-onboarding](2026-10-19-employee-first-onboarding.md): the wizard
  relies on members inheriting the Organization's providers.
- [2026-09-23-shared-organization-scope](2026-09-23-shared-organization-scope/README.md): the Organization scope whose providers became members' defaults.

## Timeline

- **2026-09-30**: PR #70 merged (Duplicate on the stored key, one picker per job).
- **2026-10-01**: PR #76 merged (provider choice inside each AI feature, independent Topics provider).
- **2026-10-17**: Organization defaults plus own override ruled; profiles follow the Organization
  default.
- **2026-10-18**: PR #144 merged (Organization providers and profiles as members' defaults, one
  provider card); the `gpt-4o-mini` fallback found still in place; PR #153 merged (Default Model
  required).
- **2026-10-19**: PR #178 merged (Organization fallback for members without any default).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
