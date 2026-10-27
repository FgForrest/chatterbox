---
title: AI usage outlives item erasure but remains bounded by account deletion
date: 2026-10-26
updated: 2026-10-26 21:09
status: proposed
kind: fix
issues: [290]
prs: []
areas: [src/db/schema.ts, src/lib/ai/usage-cost.ts, src/lib/ai/usage-attempt.ts, src/lib/knowledge/embeddings.ts, src/db/queries/statistics.ts, src/lib/export/build-archive.ts]
supersedes: []
superseded-by: []
relates: [2026-10-26-member-visible-usage-statistics]
---

# AI usage outlives item erasure but remains bounded by account deletion

Erasing a recording or mail removes its content and clears the usage ledger's item link. The numerical usage remains in spend and Models. Deleting either the owning account or the paying account still deletes its usage rows.

## Why

Deleting an old item must not reduce money already spent. The retention boundary also needs to remain discoverable by people changing erasure, account deletion, statistics or archives, rather than being an incidental foreign-key detail.

### Previous state

Usage had a required item link with cascade deletion. It recorded only successful server calls. Browser transcription and embeddings were absent, and the statistics usage query required an existing item.

## Options considered

### Keep numerical usage after item deletion (chosen)

- **Pros:** spend and model counts remain stable when content is removed; no content needs to survive.
- **Cons:** item erasure no longer removes all metadata about processing. Historical rows whose kind was never recorded become unknown once their item is gone.

### Delete usage with the item (declined)

- **Pros:** erasure removes the processing metadata too, and the old cascade needs no maintenance.
- **Cons:** historical spend shrinks when content is deleted.
- **Rejected because:** issue #290 requires durable spend. Revisit if erasure must also erase account-scoped financial metadata; such a change needs an explicit new retention decision.

## Decision

**Keep the account-scoped numerical ledger.** Retained rows contain account/actor/payer identifiers, time, operation, item kind, provider/model, outcome, token/audio counts, cost and price source. They contain no titles, transcript or mail text, prompts, answers, provider error messages, credentials or retained item identifiers after hard deletion. Account deletion remains the outer boundary through the existing owner and payer cascades; deleting only an actor clears that actor link.

## Key technical details

- Generated migration `0144_foamy_ares.sql` makes the item link nullable with `ON DELETE SET NULL`, adds nullable kind and defaults outcome to succeeded. Existing data and account cascades stay intact; no new index is needed.
- New writes snapshot the authorized item's kind under a key-share lock. Legacy rows use the current item's kind at read time. Drizzle cannot generate a relational data backfill, so no historical kind is invented and no migration SQL is edited by hand.
- Spend follows payer identity without requiring an item. Activity still requires an existing item and a successful call. Unattached and unknown-kind usage contributes to total spend, but not mail or recording cost per hour. Embeddings use Other, preserving the five colored processing steps.
- The common attempt wrapper preserves original errors and the existing retry policies. SDK retry transport records each failed HTTP attempt. Mynah's optional internal transport does the same without recording budget/storage refusals before a request. Gemini and chat errors carry only measured numeric usage when an answer is withheld or truncated.
- Browser transcription uses provider `browser`, the validated reported model, server-held duration and zero cost. Embeddings log once per HTTP batch, attributed to their item owner or knowledge scope. A single provider card is used only when payer, endpoint, model and decrypted request key match; ambiguous cards stay unpriced. Search queries are logged only for a positively priced card or a positive provider-reported cost.
- Archives include the payer's ledger in `ai/usage.json`, including mail and unattached rows, and retain the existing per-recording usage files. Usage remains exported financial history; content restore continues not to replay historical usage events, as before this change.

## Verification

- `src/tests/regressions/290-durable-usage-ledger.integration.test.ts`: 15 PostgreSQL cases cover migration over 0143 with existing usage, both item kinds, owner/payer deletion, Organization spend, failed calls, browser duration, embedding batches, pricing and query logging.
- `src/tests/regressions/290-usage-attempts.test.ts`: original-error identity, measured failures, SDK retries, concurrent payers and logging failures, including withheld Gemini and truncated chat transcription.
- Statistics component tests check retained spend without activity, failed counts in model tooltips/tables and the Other step. Archive tests check unattached usage in both archive scopes.

## Consequences & open follow-ups

Both self-host and hosted receive the additive schema change without new environment variables or compose changes. A logging failure loses that measurement and emits a content-free diagnostic; it does not replace the caller's result. A statistics regression could affect every viewer's totals in either mode, while existing scope authorization remains unchanged. Rolling back the application leaves retained rows available, though older item-joining readers will omit them. No data recovery or configuration change is required for an existing installation.

Unmeasured usage and unmatched provider prices stay unknown. Existing rows with null kind cannot retain their mail/recording split after deletion, but their spend still counts. Account-scoped spend is not a permanent audit trail because account deletion removes it.

## Related work

- [2026-10-26-member-visible-usage-statistics](2026-10-26-member-visible-usage-statistics.md): defines the unchanged member-visible aggregate scopes and payer attribution.

## Timeline

- **2026-10-26**: issue #290 specifies durable usage and authorizes the generated migration; implementation prepared for review without a commit.
