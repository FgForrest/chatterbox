---
title: A shared recording is one set of rows that the Organization edits; the owner reads, withdraws or erases it
date: 2026-09-30
updated: 2026-10-22 16:00
status: superseded
kind: feature
issues: []
prs: [69]
areas: [src/lib/sharing/writer-rule.ts, src/lib/sharing/writer.ts, src/lib/folders/folders.ts, src/db/queries/retention.ts, src/db/migrations/0066_merge_org_rows.sql, src/components/recordings/withdraw-retention-warning.tsx]
supersedes: []
superseded-by: [2026-10-22-owner-edits-shared-recording]
relates: [2026-09-30-learn, 2026-09-23-shared-organization-scope]
---

# A shared recording is one set of rows that the Organization edits; the owner reads, withdraws or erases it

Sharing a recording into the Organization stopped being a copy and stopped being two parallel
views: one set of transcript, speaker, summary and topic rows serves the owner and the
Organization. While the recording is shared, only the Organization (its account, later its
curators) changes it; the owner can read it, withdraw it, or erase it. Withdrawal gives the
recording back as the Organization left it, erasing withdraws first, and the Organization's
retention alone governs the recording while it is shared. Decided on 2026-09-28 during the Learn
work and shipped in PR #69. The owner's loss of edit rights was reversed on 2026-10-22 (see
*Consequences & open follow-ups*); the rest still holds.

## Why

Learn (PR #69) needed to know whose facts and speaker names a shared transcript carries. Its
first sharing build (Phase 1B) gave the Organization a snapshot copy at share time and froze the
owner's own copy. Reviewing that build, the maintainer stated his model: what the owner shares
"is still her content", and erasing it should withdraw it from the Organization and then erase
it, so it is gone from both. The snapshot contradicted that in several places, and two copies
would also have forced Learn to copy every fact's evidence into the Organization copy.

### Previous state

- **PR #53 (2026-09-23):** two views of one recording. The private view showed the owner's rows;
  the Organization view showed Organization-owned rows, falling back to the owner's until someone
  ran something there. Any member could re-run AI in the Organization view (the clicker paid).
  Audio retention: the longer of the owner's and the Organization's periods, then a 7-day grace
  after withdrawal.
- **Phase 1B (local branch, never released on its own, 2026-09-28):** sharing took a snapshot
  (transcripts, speaker names, summaries, topics) for the Organization once; the owner's copy was
  frozen for speakers and re-transcription but stayed theirs for erase, retention, new summaries
  and topics. Erasing the owner's transcript left the Organization's copy; a summary the owner made
  after sharing stayed hers only.

## Options considered

### Option A: snapshot copy at share, as built in Phase 1B (declined)

- **Pros:** already built and reviewed; the owner's copy and the Organization's evolve
  independently; withdrawal can hand back exactly what was shared.
- **Cons:** a partial erase left the Organization's copy; transcript and summary retention
  followed different rules than audio; summaries and topics made after sharing diverged; Learn
  would need each fact's evidence copied into the Organization's copy at share time (plan task 2.11).
- **Rejected because:** it broke the maintainer's rule that the shared content stays the owner's
  and that erasing it removes it everywhere, and it doubled Learn's evidence handling.

### Option B: one shared set of rows, owner and Organization both edit ("a" in the maintainer's terms) (declined)

The owner keeps full rights; owner and Organization account edit the same rows and see each other's
changes.

- **Pros:** simplest for the owner; no hand-over.
- **Cons:** contradicted the maintainer's rulings of 2026-09-27 that only the Organization account
  changes speaker names on a shared recording and that facts and speakers freeze for the owner
  after sharing; the owner could put a private person on a transcript the whole Organization reads.
- **Rejected because:** it reopened the private-people leak and conflicted with the curator rule
  in force. (This is roughly what was adopted on 2026-10-22, once the speaker picker on a shared
  recording offered only Organization people.)

### Option C: one shared set of rows, sharing hands the recording over ("b") (chosen)

The owner gives up edits while shared; the Organization edits the one set of rows; the owner reads,
withdraws or erases.

- **Pros:** fits the rulings in force; one transcript means the Organization's facts and the
  owner's private facts point at the same text, and withdrawal only deletes the Organization's.
- **Cons:** about half of Phase 1B redone, plus a one-time migration of recordings shared under
  PR #53 that already had Organization-owned rows; the owner cannot fix anything while shared.

The deciding question, raised by the advisor, was what withdrawal gives back: the recording *as
the Organization left it* (one set of rows works) or *as the owner shared it* (needs a copy, which
is Option A again). The maintainer chose "as the Organization left it", which is what the owner's
recording page shows all along.

## Decision

**Chosen: Option C.** The maintainer's rule (2026-09-28): sharing gives up the owner's ability to
modify anything in the recording; the owner can withdraw and gets it back as the Organization left
it, then owns it fully again; Erase withdraws automatically, so immediate erasure is one action.
Consequences he confirmed the same afternoon:

- **Retention:** while shared, only the Organization's policy runs, audio included; after withdrawal
  the owner's applies at once. The 7-day grace was dropped (he asked why it was needed); instead the
  withdraw confirmation warns when the owner's policy will delete parts of the recording. This
  replaces PR #53's "longer period wins".
- **Summaries:** one set, not one per side (overriding the advisor's per-side proposal). The
  Organization sees the owner's pre-share summaries; the owner keeps the Organization's after
  withdrawal.
- **Partial erase:** erasing any one part (only the summary, say) withdraws the whole recording; the
  confirmation says so.
- **Names after withdrawal:** they keep pointing at the Organization's people. The proposal to turn
  them back into private people was withdrawn: promotion moves the person row into the Organization
  in place, so there is no private original, and private recordings naming Organization people are
  already normal. People promoted by sharing stay in the Organization after withdrawal.
- **Title:** frozen for the owner while shared; filing into the owner's private folders stays
  allowed. (Decided the same evening and built the next day: the Organization account renames the
  title, detects topics on the Organization view, and can withdraw the recording from the
  Organization side, confirming the owner's retention warning.)
- **Out of reach:** copies already exported (Drive export, downloads) stay where they went.

Also part of the same change: re-transcription on the Organization view became the Organization
account's alone, and the owner could not re-transcribe or run Learn while shared. Local mode
(`SELF_HOST_MODE=local`) lifts the rule, because no Organization is shown.

## Key technical details

- **Writer rule:** `writerRefusal` in `src/lib/sharing/writer-rule.ts` (owner gets 409
  `RECORDING_SHARED` while shared, as built here), checked under the recording lock that sharing
  and withdrawal also take, so a run rechecks its permission against the current sharing state.
- **Withdrawal from the last Organization folder** needs `withdraw: true`, else 409
  `WITHDRAW_UNCONFIRMED` (`src/lib/folders/folders.ts`). This was a breaking change for API clients
  (PR #69).
- **Migrations:** `0064_org_snapshot_at` and `0065_drop_org_snapshot_at` ship as an add-then-drop pair
  (the Phase 1B snapshot marker); `0066_merge_org_rows` folds Organization-owned transcripts and
  summaries of still-shared recordings into the owner's rows, the Organization's winning per source,
  and drops Organization rows left on unshared recordings.
- **Retention:** `src/db/queries/retention.ts` runs the organization account's policy first and alone
  for every shared recording; `src/components/recordings/withdraw-retention-warning.tsx` is the
  warning that replaced the grace period.

## Verification

PR #69: 2523 tests passed and 12 skipped with the PostgreSQL integration tests. The sharing rules
are covered by `src/tests/sharing/one-recording.integration.test.ts`,
`src/tests/sharing/freeze.integration.test.ts`, `src/tests/sharing/merge-org-rows-migration.integration.test.ts`
and `src/tests/sharing/writer-rule.test.ts`. The rework was browser-checked on the e2e stack,
including migration 0066 merging a snapshot copy.

## Consequences & open follow-ups

**Superseded in part.** On 2026-10-21 the maintainer asked why an owner cannot keep working on a recording shared at step
two of the workflow; nothing technical required it. He ruled that the owner writes a shared
recording like a curator of it, in the Organization scope (PR #221,
[2026-10-22-owner-edits-shared-recording](2026-10-22-owner-edits-shared-recording.md)). What survives from this record: one set of rows, no
copy; withdrawal returns the recording as the Organization left it; erase withdraws first; the
Organization's retention while shared with no grace period; names keep pointing at Organization
people after withdrawal; other members stay read-only.

## Related work

- [2026-09-23-shared-organization-scope](2026-09-23-shared-organization-scope/README.md): the two-view model and the retention rule this replaced.
- [2026-09-30-learn](2026-09-30-learn/README.md): the Learn work whose evidence model needed one transcript per shared recording.
- [2026-10-22-owner-edits-shared-recording](2026-10-22-owner-edits-shared-recording.md): gives the owner edit rights back.

## Timeline

- **2026-09-28**: Phase 1B review raised the ownership question; the maintainer chose one set of
  rows and the hand-over rule, then confirmed the consequences (no grace period, names stay on
  Organization people); rework and its reviews done the same evening.
- **2026-09-30**: shipped in PR #69.
- **2026-10-21**: owner edit rights restored by ruling; shipped in PR #221 on 2026-10-22.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
