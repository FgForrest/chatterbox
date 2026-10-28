---
title: Item knowledge uses the folder knowledge panel and replaces finished Learn cards
date: 2026-10-28
updated: 2026-10-28 16:20
status: proposed
kind: refactor
issues: []
prs: [300]
areas: [src/components/dashboard/folder-knowledge-panel.tsx, src/components/learn/learn-widget.tsx, src/lib/knowledge/read-item-knowledge.ts, src/db/queries/folder-knowledge.ts]
supersedes: [2026-10-22-organization-almanac-grows-on-share]
superseded-by: []
relates: []
---

# Item knowledge uses the folder knowledge panel and replaces finished Learn cards

Recordings and mail open Knowledge from their item header. One panel and one evidence-query family serve folder and item scopes. Completed Learn runs, including runs with nothing new or nothing applied, move there; progress, waiting reviews, failures and stopped runs remain in the detail.

## Why

The detail page accumulated transcript, summary, task and completed Learn controls. Folder Knowledge already answers which people, things, corrections and facts appear in a scope. Keeping another results destination makes the same information follow different navigation and access rules.

### Previous state

A finished Learn run left a compact card opening a results dialog. Folder Knowledge separately listed confirmed evidence and model context. Organization share receipts retained applied and skipped counts without individual review items.

## Options considered

### Keep the finished card and results dialog (declined)

- **Pros:** preserves the existing visible completion indicator and its direct results action.
- **Cons:** leaves another card and a separate destination for item knowledge.
- **Rejected because:** the approved detail design consolidates completed results into Knowledge to reduce controls. Revisit only if users cannot discover the header action and its review badge.

### Use the folder panel with an item scope (chosen)

- **Pros:** one tab, pagination and navigation implementation; bounded evidence queries share authorization-sensitive filtering.
- **Cons:** reviewers need a second view of outcomes within the corresponding knowledge tabs, and received items require a narrower payload.

## Decision

Use the shared panel and item-filtered evidence queries. Review drafts and rejected proposals remain visible only to people allowed to review the item. Organization members see Organization evidence; direct recipients see confirmed speaker names without private record identifiers or the owner's Almanac context. A share grant never grants access to private knowledge outside that item.

## Key technical details

- `/api/items/[id]/knowledge` authorizes recording and mail views through `requireRecordingView` before reading evidence. The shared raw queries receive only that authorized item and owner.
- The item panel replaces detail content in place; Back restores mounted content, including the existing Learn review. Re-learn and forgetting item rejections reuse that widget's existing request paths.
- The summary footer resolves its producing profile through the stored revision. A different profile starts a run explicitly with that profile; an empty summary only remembers the next choice.
- Storage, backup formats, `/api/v1`, environment variables and deployment configuration do not change.

## Verification

`src/tests/knowledge/item-knowledge.integration.test.ts` covers 15 PostgreSQL cases across audio and mail: owner, Organization member, accepted recipient and revocation, stranger refusal, deletion, input validation, earlier Learn additions, repeated facts, private context redaction and proposed speaker provenance. `src/tests/folders/folder-knowledge.test.tsx` exercises the shared panel with folder, recording and mail scopes. Summary and transcript tests cover collapse, footer pencils and key-point placement.

## Consequences & open follow-ups

Self-host and hosted use the same read and UI paths; hosted retains its existing Learn availability. A visibility regression could reveal knowledge to an unintended reader in either mode. Revocation stops subsequent reads, and rolling back the application requires no migration or data conversion. A displayed model preview describes current context, not a retained historical prompt. Historical share receipts with unknown counts remain unknown.

## Related work

[Organization Almanac growth on share](2026-10-22-organization-almanac-grows-on-share.md) is superseded only for the finished Learn results destination. Promotion, share receipts, matching, withdrawal and curator permissions remain in force.

## Timeline

- **2026-10-28:** approved detail design implemented and opened as PR #300 after two cross-review rounds.
