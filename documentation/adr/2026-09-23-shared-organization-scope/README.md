---
title: Shared Organization scope on self-host, with a dedicated Organization account and nothing copied
date: 2026-09-23
updated: 2026-10-22 22:30
status: superseded
kind: feature
issues: []
prs: [53]
areas: [src/lib/sharing, src/lib/org, src/lib/folders/folders.ts, src/lib/knowledge/people.ts, src/db/queries/retention.ts, src/db/queries/events.ts, src/app/api/events/route.ts, src/lib/folder-exports, content/docs/self-hosting/organization.mdx]
supersedes: []
superseded-by: [2026-09-30-shared-recording-edited-by-organization, 2026-10-14-identity-provider-authorization, 2026-10-19-processing-profiles-and-workflow, 2026-10-19-provider-defaults-and-no-fallback, 2026-10-21-curators-manage-organization-almanac]
relates: [2026-10-07-backup-scope, 2026-09-30-learn, 2026-10-22-owner-edits-shared-recording]
---

# Shared Organization scope on self-host, with a dedicated Organization account and nothing copied

A self-hosted instance in `SELF_HOST_MODE=shared` with `ORG_ACCOUNT_EMAIL` set gets one
Organization account and, for every user, an Organization folder tree next to Private. An owner
shares a recording by filing it into that tree; nothing is copied. Colleagues read it, run AI on
it, attribute speakers to Organization people, and see changes live. PR #53 built all three phases
(shared tree and view, Organization knowledge base, Organization retention and exports) in one
merge. Several of its rules were changed within a month; the *Later changes* list below says which,
and points to the records that carry them. **Superseded in part:** those records supersede this one
for the rules they changed; the rest still holds.

## Why

The maintainer wanted colleagues on one self-hosted instance to share recordings and build one
common people directory, without giving up private recordings. Three constraints made this
non-obvious:

- **Isolation is authorization only.** Encryption at rest uses one instance-wide AES-256-GCM key
  (`ENCRYPTION_KEY`); passwords only authenticate, and audio is not encrypted. About 150 queries in
  about 50 files filter by `userId`. Sharing had to be added through one gate, not by editing every
  query, and a missed query either leaks or hides a recording.
- **Hosted runs several processes**, so live updates and locks could not live in memory.
- **The people directory must never contradict itself** between a user's private knowledge and the
  shared one (the maintainer's requirement).

### Previous state

Upstream gave every user a "Private" and a "Public" root folder. "Public" was an unfinished
label: the rows were still the user's own, filtered by their `userId`, invisible to everyone else.
`SELF_HOST_MODE=local|shared` only toggled whether the Public root was shown.

## Decisions taken

All taken in the design session of 2026-09-22 (several after an adversarial review of the rules)
and shipped in PR #53 on 2026-09-23.

| Date | Decision | Why | Detail |
|------|----------|-----|--------|
| 2026-09-22 | A dedicated Organization account created from env (`ORG_ACCOUNT_EMAIL`, `ORG_ACCOUNT_PASSWORD`), bound by `users.role = 'org'`, not a curator role on regular users | The account owns every Organization row, has no private scope and no Plaud connection, sees nothing private, and holds its own AI keys and templates. Accepted cost: curation through one shared login is not attributable to a person | Changed 2026-10-14, see *Later changes* |
| 2026-09-22 | Sharing is filing into the Organization tree; nothing is copied. Assignment rows for Organization folders keep the owner's `userId` | A copy adds no security under one instance key and doubles audio and sync work (see *Rejected outright*) | |
| 2026-09-22 | Only the owner shares or withdraws. Anyone moves a shared recording between Organization folders and edits the tree; deleting an Organization folder moves its recordings to the Organization root, still shared | Collaborative filing without anyone hiding a colleague's recording | Tree editing narrowed 2026-10-16 |
| 2026-09-22 | Two views of one recording: the private view shows the owner's rows; the Organization view shows Organization-owned rows, falling back read-only to the owner's until a run there creates its own | The maintainer: the owner's own transcript and summary stay as they are privately, while the Organization view shows output made with the Organization's templates; no copy at share time | Replaced 2026-09-28 by one set of rows |
| 2026-09-22 | A run in the Organization view uses the clicking user's provider, model and keys (the clicker pays) with the Organization account's templates, prompts and language. It skips title generation, Plaud title sync, webhooks, auto-summary chaining and the owner's automations. Automations act only on the owner's rows, on the owner's keys | Who pays follows who acted; the shared output keeps one format and language whoever clicks | Refined 2026-09-28 and 2026-10-17 |
| 2026-09-22 | One Organization knowledge base plus a private delta per user. Sharing promotes every person confirmed on the recording by re-owning the person row to the Organization account (no copy, permanent). Notes move to a per-user overlay (`person_notes`); suggestions are never promoted or shown to anyone but the owner | One record per identity, so private and shared knowledge cannot disagree; private notes stay private | |
| 2026-09-22 | Members attribute speakers in the Organization view to Organization people, creating new ones by doing so; only the Organization account renames, merges or erases Organization people, and its changes reach every user's knowledge, private recordings included | The maintainer wanted "some ultimate force that can correct, align and shape shared data" | Curators added 2026-10-14 and 2026-10-21 |
| 2026-09-22 | A re-transcription in the Organization view carries the replaced transcript's names over as suggestions | A renumbered diarization would otherwise put a confirmed name on the wrong voice | |
| 2026-09-22 | Retention: while shared, the longer audio period of owner and Organization wins; after withdrawal a 7-day grace before the owner's policy reaps; deleting the Plaud original stays the owner's setting alone | Nothing is copied, so whichever policy applies deletes the owner's only copy; the Organization may extend, never shorten | Replaced 2026-09-28 |
| 2026-09-22 | The Organization account configures filesystem exports of Organization folders; they write the Organization view, with audio read from each owner's storage | The Organization tree needs its own egress, separate from personal exports | |
| 2026-09-22 | Live updates: shared mutations call `pg_notify` inside their transaction (payload ids only), one `LISTEN` per process, one SSE stream per tab, the client refetches. Organization folders carry a `version`; a stale rename or move answers 409 | No new service, works across processes, fires only on commit | |
| 2026-09-22 | Existing per-user Public roots: empty ones deleted, non-empty ones moved under Private as "Former Public"; nothing is shared or promoted on deploy | The old label never shared anything, so nothing may become visible without the owner acting | |
| 2026-09-22 | The folder tree shows two roots, Private and Organization; the root a recording is opened from selects the view | The view (private or Organization rows) must be unambiguous for an owner whose recording appears in both | |

## Rejected outright

| Option | Rejected because | Revisit if |
|--------|------------------|------------|
| Copy each shared recording to an Organization user, encrypted with an Organization key unlocked at start (the maintainer's first idea) | Encryption at rest uses one instance-wide key and passwords only authenticate, so an Organization key adds no protection. Copies double audio storage and must be kept in sync through edits, re-summaries, renames, retention and deletion | Per-user or per-Organization keys are ever introduced |
| A curator role on regular users (`ORG_CURATORS`), or both role and account | More surface than one account that owns the shared rows and sees nothing private | Happened: identity-provider authorization added `org.curate` (PR #131) |
| One shared result per recording, the last run replacing it for everyone including the owner's private view (first chosen, then reversed in the same session) | The maintainer wanted the owner's own output preserved privately and the Organization view to show output made with Organization templates | Happened in a different form: one set of rows, record [2026-09-30-shared-recording-edited-by-organization](../2026-09-30-shared-recording-edited-by-organization.md) |
| Per-user results on a shared recording | More storage and UI, and the Organization knowledge base would have to pick which transcript counts | |
| Copy the owner's transcript into an Organization row at share time (with or without the owner's names as suggestions, with or without an automatic Organization summary) | The maintainer chose no copy at all; suggested names would show the owner's private names to every member, and an automatic summary would charge the owner for every share | |
| Two linked knowledge bases, personal people linked to Organization people with Organization fields overriding | Needs a sync and override layer with race windows where the two disagree | |
| One instance-wide knowledge base | A speaker named only in someone's private recording becomes visible to everyone by name | |
| Everyone edits Organization people, the Organization account locks; or only the Organization account creates them | More churn; or members wait on the curator for every new person | |
| The Organization's retention replaces the owner's while shared (the maintainer's first rule) | Nothing is copied, so a shorter Organization period deletes the owner's only copy earlier than they configured | Happened once sharing became a hand-over (record [2026-09-30-shared-recording-edited-by-organization](../2026-09-30-shared-recording-edited-by-organization.md)) |
| The actor's settings for everything in an Organization-view run | The shared summary would flip language and format with whoever clicked last | |
| Anyone may withdraw, and deleting a folder withdraws its recordings | One careless folder delete hides many recordings from everyone | |
| Polling for tree changes | Seconds of lag and constant load | |
| WebSockets | Needs a custom server replacing the standalone `server.js`, proxy upgrade configuration, and still `NOTIFY` for multi-process fan-out | |
| Auto-share old Public folders, or ask each owner once | Shares and promotes without anyone acting; or extra UI to build and remove again | |
| One mixed list of own and shared recordings with a filter | Which rows open (private or Organization) becomes ambiguous for the owner | |

## Key technical details

- **Activation:** `src/lib/org/config.ts`. `isOrgScopeVisible()` is self-host with `SELF_HOST_MODE=shared`
  (the default); `isOrgScopeEnabled()` also needs the account's env. The account is found by
  `users.role = 'org'` (at most one), not by e-mail, so it outlives env changes; with its env removed
  the Organization stays readable and nothing is deleted. Hosted never shows the scope.
- **One access gate:** `src/lib/sharing/access.ts` (`resolveRecordingAccess`: owner, member,
  curator, or none, which answers 404). Every recording route *and method* must be classified;
  `src/tests/sharing/route-classification.test.ts` fails on an unclassified one. Other queries keep
  their `userId` filter.
- **Names in the Organization view** come only from Organization people (`orgPeopleOnly`), so an
  owner's private people never appear there.
- **Lock order for tree changes:** the `riffado:org-tree` advisory transaction lock, then the
  recording row `FOR UPDATE` (`src/lib/folders/folders.ts`).
- **Live updates:** `src/db/queries/events.ts` (`pg_notify` in the transaction), `src/lib/org/events.ts`
  (one `LISTEN` per process), `src/app/api/events/route.ts` (SSE).
- **Looks like a bug, is intended:** an Organization folder assignment carries the owner's `userId`,
  so owner-scoped queries keep working and deleting the owner's account removes their shared
  recordings for everyone.
- **Migration:** `0055_shared_org_scope` only adds columns, an index and `person_notes`; retiring the
  old Public roots happens in app code on startup.

## Verification

PR #53: 1566 tests passed and 102 skipped without a database; with Postgres all 1660 passed (8
Plaud live tests skipped). The database tests include access by role and route
(`src/tests/sharing/route-access.integration.test.ts` plus the classification guard), sharing and
withdrawal including a withdrawal racing a move (`src/tests/sharing/org-scope.integration.test.ts`),
retention (`src/tests/retention/org-retention.integration.test.ts`), Organization exports end to
end (`src/tests/folder-exports/org-exports.integration.test.ts`) and `LISTEN/NOTIFY` delivery
(`src/tests/sharing/org-events.integration.test.ts`). The feature was merged without a browser check.

## Consequences & open follow-ups

Known gaps at merge (PR #53): an Organization export could still write a file just after a
withdrawal if a re-plan was already queued; the standalone recording page was owner-only, so links
to shared recordings opened the dashboard's Organization view. Server error text is English app-wide;
the client localizes the folder conflict (409) only.

**Later changes to these decisions:**

- **2026-09-28, shipped in PR #69 (2026-09-30):** while building Learn, the two views became one set
  of rows: sharing hands the recording to the Organization, the Organization's retention alone
  governs it while shared with no grace period after withdrawal, and Organization rows created under
  PR #53 were merged into the owner's ("the Organization's names win", migration
  `0066_merge_org_rows`). Re-transcription in the Organization view became the Organization
  account's alone (replacing "any member, the clicker pays"), and speakers on a shared recording
  became one shared set instead of the Organization view's own. See
  [2026-09-30-shared-recording-edited-by-organization](../2026-09-30-shared-recording-edited-by-organization.md) and [2026-09-30-learn](../2026-09-30-learn/README.md).
- **2026-10-14, PR #131:** identity-provider authorization added `org.curate`; a curator acts for the
  Organization under their own identity (record [2026-10-14-identity-provider-authorization](../2026-10-14-identity-provider-authorization.md)).
- **2026-10-16, implemented in PR #135:** editing the Organization tree is no longer open to everyone.
  Members create subfolders inside existing Organization folders and file items into them; creating
  top-level Organization folders, renaming, moving, reordering and deleting them (and changing a
  folder's mail address) is curator-only, enforced by the server (403) where it had been hidden in
  the UI only. The maintainer chose this over "curators only" and "any member": a new subfolder
  helps members share information together, while restructuring existing folders (moving, renaming,
  deleting) confuses everyone, so it is left to curators, who do it carefully.
- **2026-10-17:** Organization default providers: members use Organization providers for work no
  profile pins, and the Organization pays (record [2026-10-19-provider-defaults-and-no-fallback](../2026-10-19-provider-defaults-and-no-fallback.md)).
- **2026-10-21, PR #222:** curators manage existing Organization Almanac entries
  ([2026-10-21-curators-manage-organization-almanac](../2026-10-21-curators-manage-organization-almanac.md)).
- **2026-10-22, PR #221:** the owner edits a shared recording again, in the Organization scope
  ([2026-10-22-owner-edits-shared-recording](../2026-10-22-owner-edits-shared-recording.md)).

## Related work

- [2026-09-30-shared-recording-edited-by-organization](../2026-09-30-shared-recording-edited-by-organization.md): replaced the two-view model with one set of
  rows and changed the retention rule.
- [2026-09-30-learn](../2026-09-30-learn/README.md): the Learn work that forced that change and made speakers shared.
- [2026-10-07-backup-scope](../2026-10-07-backup-scope.md): splits backups and exports along the personal and Organization scopes
  defined here.
- [2026-10-22-owner-edits-shared-recording](../2026-10-22-owner-edits-shared-recording.md): the current writer rule for a shared recording.
- [2026-10-21-curators-manage-organization-almanac](../2026-10-21-curators-manage-organization-almanac.md): changed this record's rule that only the Organization account curates Organization people.
- [2026-10-19-processing-profiles-and-workflow](../2026-10-19-processing-profiles-and-workflow/README.md): carries the 2026-10-16 Organization folder permissions listed under Later changes.
- [2026-10-14-identity-provider-authorization](../2026-10-14-identity-provider-authorization.md): added `org.curate`, so curators act for the Organization under their own identity.
- [2026-10-19-provider-defaults-and-no-fallback](../2026-10-19-provider-defaults-and-no-fallback.md): made Organization providers members' defaults, so the Organization pays for unpinned work.

## Timeline

- **2026-09-22**: shared scope requested; design with 22 rules agreed in one session, revised after
  an adversarial review of the rules; all three phases implemented overnight.
- **2026-09-23**: PR #53 opened and merged, without a browser check.
- **2026-09-28**: one set of rows, Organization retention while shared, curator-only Organization
  re-transcription and shared speakers decided in the Learn work (merged with PR #69 on 2026-09-30).
- **2026-10-14**: curators through `org.curate` (PR #131).
- **2026-10-16**: Organization tree restructuring made curator-only (merged with PR #135 on 2026-10-17).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
