---
title: Export folders to Google Drive on self-host only, through a general Google connection with drive.file and the Picker
date: 2026-09-28
updated: 2026-10-22 16:00
status: accepted
kind: feature
issues: []
prs: [61]
areas: [src/lib/folder-exports, src/lib/integrations/google, src/app/api/integrations/google, src/db/schema.ts, content/docs/self-hosting/google-drive.mdx]
supersedes: []
superseded-by: []
relates: [2026-10-06-export-ownership-ledger, 2026-09-14-speaker-identity-without-biometrics, 2026-10-12-calendar-meet-speaker-candidates]
---

# Export folders to Google Drive on self-host only, through a general Google connection with drive.file and the Picker

Folder exports, until then filesystem-only, can target a Google Drive folder (PR #61). The projection
is the same: one folder per recording with its audio, transcripts and summaries, kept current as they
change. The feature exists only on self-hosted instances whose Google Cloud project uses an
**Internal** consent screen. Each user has one general Google connection (not a sign-in method),
picks the target folder in the Google Picker under the `drive.file` scope, and chooses per artifact
type whether transcripts and summaries become `.md` files, Google Docs or both. The export trashes
only folders it created itself, and overwrites a regenerated Doc even if someone edited it.

## Why

The maintainer asked for a Drive target next to the filesystem one, with an abstraction that later
fits OneDrive. The primary use is an Organization account exporting into a company shared drive, so
colleagues read transcripts where they already work.

The constraints that made it non-obvious:

- **Drive scopes.** The full `drive` scope is restricted and needs a paid annual security assessment
  (CASA). `drive.file` only sees files the app created and folders the user explicitly picked, so the
  server cannot browse a user's Drive and cannot see files a person drops into an exported folder.
- **Consent screen type is one choice per Google Cloud project.** Internal admits only the company
  Workspace; External admits personal accounts but brings verification and data-leaving-the-company
  questions.
- **Drive addresses files by id and allows duplicate names**, while the export engine plans logical
  paths.

### Previous state

Folder exports (PRs #48, #49, #60) wrote only to a filesystem mount. The planner, executor and
configuration queries joined `filesystem_export_settings` directly, and `createExportProvider()`
always returned the filesystem provider. No Google code existed and better-auth had no social
providers.

## Options considered

### Where it runs: self-host with an Internal consent screen (chosen)

- **Pros:** no Google verification, ever; refresh tokens do not expire; only company accounts can
  connect, so a Private folder of company recordings cannot be mapped to a personal Gmail.
- **Cons:** personal Google accounts cannot be used; hosted has no Drive export.

### Hosted, or an External consent screen with personal accounts (declined)

- **Pros:** personal accounts work; hosted users get the feature.
- **Cons:** hosted needs Google brand verification and a "Limited Use" section in its privacy policy;
  in "Testing" status refresh tokens expire after 7 days, silently breaking autonomous export; the
  later Calendar/Meet scopes are sensitive and need review or face a 100-user cap.
- **Rejected because:** an employee could export company recordings into a personal account, and
  hosted would need verification plus exfiltration controls that Internal makes unnecessary. The
  maintainer dropped personal accounts explicitly. Revisit if hosted wants Drive export: it needs
  verification, an External screen in production status and a domain allowlist.

### Connection: one general Google connection per user (chosen)

A provider-neutral `oauth_connections` row per user with an encrypted refresh token, reused later for
other Google scopes by incremental consent.

- **Pros:** one consent flow for Drive now and Calendar/Meet later; Google never becomes a way to
  sign in.
- **Cons:** its own OAuth flow, token refresh and revocation handling.

### Connection through better-auth `linkSocial` (declined)

- **Rejected because:** linking a social account also makes Google a sign-in method, which this
  feature must not introduce.

### A Drive-export-only connection (declined)

- **Rejected because:** the Calendar/Meet work would need a second connection and a second consent;
  the maintainer wanted one general integration.

### Folder choice: Google Picker under `drive.file` (chosen)

- **Pros:** non-sensitive scope; Google's own UI covers My Drive and shared drives; picking grants
  access to that folder, which is all the export needs.
- **Cons:** third-party script in the page; the server only re-checks the picked id.

### "Create a folder in My Drive" instead of picking one (declined)

- **Rejected because:** the maintainer rejected it outright without a stated reason. It cannot reach
  the primary target, an Organization shared drive chosen through a dedicated service mailbox
  (inferred).

### Full `drive` scope with a server-side folder browser (declined)

- **Rejected because:** the scope is restricted and requires the paid annual CASA assessment, the
  same finding that kept the speaker work on `drive.file`.

### Deletion: trash only folders the export created (chosen)

The maintainer's own proposal. A folder is trashed (never permanently deleted) only if the export
created it, it holds none of the export's files, and it is not the picked root. Each such folder
carries a Drive description saying it is managed by the app and that content added there may be
removed; the dialog repeats it; Drive's 30-day trash is the safety net.

### Never delete anything on Drive (declined)

The first analysis proposed this because `drive.file` cannot see files users add to a folder, so
"is it empty" cannot be answered.

- **Rejected because:** stale empty folders would pile up whenever a recording leaves a folder. The
  maintainer accepted the residual risk in exchange for the tracking, the warning and the trash.

### Formats chosen per artifact type when the export is defined (chosen)

`.md`, Google Doc (native Drive conversion of `text/markdown`), or both.

### Format chosen per artifact (declined)

- **Rejected because:** artifacts are exported asynchronously, so there is no moment at which a user
  could choose; the choice belongs to the export definition.

### A regenerated Doc overwrites edits (chosen) versus skip-and-flag (declined)

Updating the same file id keeps links, sharing and location, and loses manual edits and comment
anchors. Skipping a Doc modified after the last write and flagging it was offered.

- **Rejected because:** the maintainer chose overwrite; exports are generated copies and the dialog
  says so. Skipping would leave the export silently stale until someone resolves it (inferred).

### Docs templates (deferred to a phase 2)

Copy a template Doc, fill placeholders, insert the body through the Docs API.

- **Deferred because:** "Paste as Markdown" exists only in the editor UI, not in any API, so it
  needs an in-house Markdown-to-Docs converter and Docs API quota handling. Revisit if plain Docs
  look too bare in practice.

## Decision

Self-host only, Internal consent, one general Google connection, Picker plus `drive.file`, trash
only own empty folders, per-type formats, overwrite on regeneration. Every choice keeps the export
inside the company Workspace and avoids any Google review. A hosted Drive export would need its own
record: verification, External consent and a domain allowlist change most of these choices.

## Key technical details

- Provider-neutral engine: `src/lib/folder-exports/target.ts` loads any provider's settings for the
  planner, executor and configurations; `provider-factory.ts` builds the provider.
  `src/lib/folder-exports/drive-provider.ts` implements `ExportProvider` for Drive.
- `targetPath` of a Drive export is the picked folder id. Picking another folder is a new target and
  re-exports from scratch, as a new filesystem path does.
- `drive_export_nodes` holds only items the export created; every created item is tagged in
  `appProperties` with the export id. A retry after a crash finds the item by parent, name and tag
  instead of creating a duplicate, so the table is a cache that can be rebuilt from Drive. A plan
  checks the tree against one listing of tagged items.
- Materializations carry `format` (`file` or `google_doc`) in their unique key; "both" is two
  materializations. Docs have no byte size, so the artifact digest is stored in `appProperties` and
  compared instead.
- Counter-intuitive: under `drive.file` the export cannot see files a person puts into its folders,
  and trashing a folder trashes them. That is why only own folders are trashed and why each carries
  the warning.
- Failure handling: `invalid_grant` marks the connection `needs_reconnect` and Drive jobs stop
  retrying; reconnecting re-plans the paused exports. Problems only the user can fix go to the
  export's `last_error` and show in the dialog until the next successful plan.
- Security: the refresh token is encrypted at rest; access tokens are minted on demand and never
  stored; OAuth state and PKCE verifier travel in an encrypted, httpOnly, short-lived cookie bound to
  the session user. Optional `GOOGLE_WORKSPACE_DOMAINS` re-checks the ID token's `hd` claim.
- Availability: hidden when `IS_HOSTED` is set or the `GOOGLE_*` variables are missing
  (`src/lib/integrations/google/config.ts`). Drive HTTP is hand-written `fetch` with resumable
  uploads for audio, no Google SDK dependency.
- An Organization exporting to a shared drive should connect a dedicated service mailbox with the
  Content manager role, not a person's account, so the export survives someone leaving. Documented
  in `content/docs/self-hosting/google-drive.mdx`, not enforced.

## Verification

- `src/tests/folder-exports/drive-provider.test.ts` (in-memory Drive: trash cascade, parents, tags,
  Doc conversion) and `src/tests/folder-exports/drive-export.integration.test.ts` (planner, executor
  and node store against PostgreSQL and the fake Drive in `src/tests/integrations/google/fake-drive.ts`).
- `src/tests/integrations/google/oauth.test.ts`, `drive-client.test.ts` and
  `connection.integration.test.ts`: authorize URL, PKCE, forged or foreign state, domain and scope
  checks, refresh, `invalid_grant`, revoke on disconnect.
- At merge the full suite passed with PostgreSQL: 1839 passed, 12 skipped.
- Not run at merge: `src/tests/integrations/google/drive-live.integration.test.ts` against the real
  Drive API (needs a live token and folder), and a real connect plus export against a Google Cloud
  project.

## Consequences & open follow-ups

- The general connection was reused: Calendar and Meet consent go through the same
  `oauth_connections` row (`src/lib/integrations/google/calendar-events.ts`, `meet-*.ts`).
- Unverified at merge: whether Drive converts Markdown when an existing Doc is updated (creating a
  Doc from Markdown is documented). If it does not, regenerated Docs need a different update path.
- Deferred: Docs templates (phase 2), service-account authentication for shared drives, reading or
  importing from Drive, OneDrive (it fits `ExportProvider` without a node map, since Graph addresses
  by path).
- Drive rate limits: 429 and `rateLimitExceeded` are retryable through the queue's backoff; a first
  export of a large library creates many folders slowly.

## Related work

- [2026-10-06-export-ownership-ledger](2026-10-06-export-ownership-ledger.md): extends Drive deletion
  from own empty folders to own duplicate files, and makes the export move files instead of copying.
- [2026-09-14-speaker-identity-without-biometrics](2026-09-14-speaker-identity-without-biometrics.md):
  the earlier finding that the restricted Drive scopes need CASA, which kept both features on
  `drive.file` and the Picker.
- [2026-10-12-calendar-meet-speaker-candidates](2026-10-12-calendar-meet-speaker-candidates.md): reuses the general Google connection introduced here, with incremental scopes.

## Timeline

- **2026-09-23**: analysis, the maintainer's decisions (self-host only, Internal, general connection,
  Picker, trash own folders, per-type formats, overwrite), implementation; PR #61 opened.
- **2026-09-28**: PR #61 merged.
- **2026-10-06**: the ownership ledger changes what the Drive export may move and trash (PR #87).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
