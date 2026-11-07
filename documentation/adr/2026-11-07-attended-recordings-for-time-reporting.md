---
title: Attended recordings disclose only title, start and duration for time reporting
date: 2026-11-07
updated: 2026-11-07 19:22
status: accepted
kind: feature
issues: []
prs: [340]
areas: [src/lib/mcp/data/recordings.ts, src/lib/mcp/tools/recordings.ts, content/docs/self-hosting/mcp.mdx]
supersedes: [2026-10-07-external-mcp-server]
superseded-by: []
relates: [2026-10-22-assignee-task-list]
---

# Attended recordings disclose only title, start and duration for time reporting

Add `list_attended_recordings` under the existing recording permissions. It lists a person's own
recordings and those where a confirmed speaker matches their verified primary email, including
recordings they cannot read, only if those recordings started at or after their first single
sign-on. Earlier recordings of others never appear; own recordings are exempt from the cutoff.
Every result discloses exactly title, start in UTC and duration.

## Why

For reporting worked time, a person needs the meetings they attended, even when the recording is
private. The maintainer's reasoning is that if the owner named you as a speaker, you were there,
so the meeting is not secret from you. This permits a narrow disclosure without granting access
to the recording's content or changing any other tool's permissions.

### Previous state

The external MCP server required every tool to stay within what the caller could already see in
the app. Private recordings attended by another person were absent from that person's AI client,
so it could not account for their time.

## Options considered

### Separate attendance tool (chosen)

- **Pros:** a uniform three-field response for readable and unreadable recordings reveals no access
  distinction; no identifier can be passed to a content tool.
- **Cons:** attendance needs a confirmed speaker and a person with the correct primary email.

### Extend `list_recordings` (declined)

- **Pros:** reuses the existing client workflow and paging.
- **Cons:** rows contain an id, URL and other people's names; other tools accept the id.
- **Rejected because:** time reporting needs none of those extra disclosures.

### Keyset cursor (declined)

- **Pros:** allows paging through large ranges.
- **Cons:** the base64 cursor contains the recording id.
- **Rejected because:** it would disclose an identifier; clients instead narrow the date range.

### Match on a name (declined)

- **Pros:** works when a person has no email.
- **Cons:** names are not unique.
- **Rejected because:** two people with the same name would see each other's meetings.

### Match `person_emails` (declined)

- **Pros:** finds additional addresses learned from mail.
- **Cons:** these addresses are learned per scope, rather than being one address per person.
- **Rejected because:** attendance matches the person's single primary email, not their
  scope-specific additional addresses.

### New MCP permission (declined)

- **Pros:** gives realm administrators a separate switch for attendance disclosure.
- **Cons:** adds realm configuration for a narrow disclosure.
- **Rejected because:** the maintainer accepted this disclosure for everyone holding an existing
  recording permission.

### Require `confirmedByUserId` (declined)

- **Pros:** ties a speaker confirmation to a recorded confirming user.
- **Cons:** older confirmed rows have no confirming user id.
- **Rejected because:** those valid older confirmations must still count; confirmed status is the rule.

### Restrict Learn so only a curator fills an existing Organization person's email (declined)

- **Pros:** narrows who can place an address on an existing Organization person.
- **Cons:** changes Learn beyond this tool and gives a colleague a duplicate record to merge at
  first sign-in.
- **Rejected because:** it stops no curator from assigning a wrong address. The recording-start
  cutoff protects earlier history without changing Learn.

### Cut off by when the speaker was named (declined)

- **Pros:** could distinguish an older confirmation from a later naming.
- **Cons:** `transcript_speakers` holds no reliable naming time: `createdAt` can belong to an older
  suggestion, merges move `updatedAt`, and transcript rewrites insert new rows. A reliable column
  would require a migration.
- **Rejected because:** a meeting after the sign-in already implies a naming after it. Recording
  start time provides the required boundary without a new column.

## Decision

**Chosen: a separate attendance tool with required date bounds and a uniform three-field result.**
Its attendance predicate deliberately bypasses normal recording readability. Own recordings count
without speaker tags or a first-sign-in cutoff. Other recordings must start at or after the caller's
first single sign-on, even when an earlier meeting was correctly named or is named after sign-in.
They require a confirmed speaker on any transcript belonging to
the recording's owner, linked to an unmerged person owned by that owner or the Organization, with
`primaryEmailHash` matching the caller's current database email. Service callers and users whose
email is unverified are refused, including for own recordings.

Revisit through a superseding decision if attendance needs identifiers, content, other identity
sources or a separate permission; those changes widen the accepted disclosure boundary.

## Key technical details

- `src/lib/mcp/data/recordings.ts` holds the attendance condition and the shared date conditions;
  `src/lib/mcp/tools/recordings.ts` checks identity and explicitly constructs only the three fields.
- The tool reads `accounts.createdAt` beside the current email and verification flag, using the
  same link as `resolveCaller`: caller `userId`, `SSO_PROVIDER_ID` and caller `subject` as
  `accountId`. Only the speaker branch requires `chatterItems.occurredAt >= accounts.createdAt`;
  own recordings are exempt. A missing link disables the speaker branch silently, leaving own
  recordings. No field is added to `McpCaller`, and speaker creation/update times are not used.
- Load 201 rows newest first, return at most 200, and report `truncated` without a cursor. Only
  returned ids enter `context.touched`, within the access log's existing 200-id limit.
- Matching reads only `primaryEmailHash`, never display names, `person_emails` or
  `confirmedByUserId`. An address accepted in a Learn review can fill a person's empty primary
  email through `linkParticipantInTx`: the owner can do so for a private person, and a curator
  or a shared mail's owner can do so for an Organization person. Learn is unchanged.
- Existing `list_recordings`, transcript and summary access rules remain unchanged. Deleted
  recordings are excluded. Titles remain untrusted data, never model instructions.
- No migration, environment variable, dependency or permission is added.

## Verification

`src/tests/mcp/attended-recordings.integration.test.ts` covers private and Organization person
matches, exact three-field rows and two-field envelopes, unchanged content access, excluded
identities and statuses, transcript/recording/speaker linkage and ownership, date bounds,
200/201-row truncation, service and unverified refusals, and returned audit ids. New cutoff tests:

- `lists foreign attendance %s first sign-in only when at or after it`: before, exact and after
  boundaries; speaker timestamps do not set the cutoff.
- `excludes an earlier meeting even when its speaker tag is written after first sign-in`.
- `includes own recordings from before first sign-in`.
- `lists only own recordings when the linked SSO account is missing`.
- `does not take the first sign-in from another %s`: provider, subject and user mismatches.
- `keeps the first sign-in cutoff after a later identity-provider email change`.

`src/tests/mcp/attended-recordings-identity.integration.test.ts` exercises mail ingest and Learn
review: an existing login-address holder resolves at ingest, and a holder created after ingest
blocks a second primary email through `people_user_id_email_hash_unique`. Its new test,
`excludes inherited history assigned through shared mail Learn before first sign-in and lists
later attendance`, reproduces an address assigned to an existing Organization person before the
holder signs in: the same record is inherited and renamed, earlier recordings stay excluded,
and later attendance is listed.

The two attendance files passed 47 tests (44 attendance and 3 identity). Together with
`src/tests/mcp/recordings.integration.test.ts` they passed 71 tests across 3 files against
PostgreSQL. `src/tests/mcp/keycloak.integration.test.ts` and
`src/tests/mcp/authz.keycloak.integration.test.ts` passed 31 tests against a local Keycloak.
Biome checked 2,267 files, TypeScript and the generated ADR index check passed. An earlier broader
run with `src/tests/mcp/recordings.integration.test.ts`, `src/tests/mcp/tool-guard.test.ts` and
`src/tests/mcp/registry.test.ts` passed 151 tests across 4 files.

Removing the recording-start cutoff failed 3 tests: the before-sign-in boundary, late naming of an
earlier meeting, and inherited history. Moving it onto the whole condition failed 1 test,
`includes own recordings from before first sign-in`. Both mutations exited 1; the source was
restored byte for byte after each. Earlier verification independently removed each of the four
transcript/recording/speaker join conditions and made its regression test fail; the source was
restored after every mutation.

## Consequences & open follow-ups

- The match compares two addresses. The identity provider vouches for the account's address.
  People write the person's address, which the provider does not see. The remaining consequences
  follow from that distinction. A person without an email is not matched.
- A member cannot place their own current login address on another Organization person: mail
  ingest links the participant to their own person, and `people_user_id_email_hash_unique`
  refuses a second holder. The holder row is written at sign-in on a best-effort basis
  (`src/lib/sso/auth-hooks.ts`).
- A holder who inherits a record at first sign-in sees none of its earlier meetings, so a wrong
  address assignment before sign-in discloses no history. What remains is a wrong address placed
  on a person after its holder signed in: the holder sees recordings from their sign-in on.
  `people_user_id_email_hash_unique` refuses a signed-in colleague's own address on another
  Organization person, so this requires a private person, whose owner decides for their own
  recordings, or a curator clearing and moving addresses. The inherited record is still renamed;
  that is a data defect independent of this tool and outside this decision. Learn is unchanged.
- A colleague never sees meetings from before their first sign-in, even correctly named ones.
  Signing in partway through a reporting period leaves the earlier part out.
- A later address change at the identity provider does not move the cutoff. A removed and
  re-created single sign-on link does: that colleague loses earlier meetings of others.
- Curators can change an Organization person's primary email through `updatePerson` in
  `src/lib/knowledge/people.ts`, subject to the unique-holder constraint. A curator can also merge
  a person into their own, moving confirmed rows without an email change. The access log records
  the listing, its target recording ids and the caller.
- Any member can add an entry to a colleague's report by naming them on a recording, with a
  title of their choosing. The title reaches the colleague's AI client as data.
- An entry disappears without notice after a retention sweep and after re-transcription of
  changed audio, when the confirmation goes.
- The owner has no opt-out. Own recordings include files someone merely uploaded; ownership
  does not prove physical attendance.
- The tool reads `users.email`, `users.emailVerified` and the linked account creation time together.
  `users.email` refreshes only at
  web sign-in, so an MCP-only caller keeps an address the provider has since reassigned until
  their next sign-in.
- In `AUTHZ_MODE=local`, a provider that omits `email_verified` leaves the old verification value
  on an email change. `AUTHZ_MODE=idp` requires it to be true.
- The predicate and response are the same in both deployment modes; hosted currently leaves
  external MCP disabled. On shared self-host, a wrong match affects the address holder's view of
  the three fields immediately. Correcting the person's email or removing the confirmation stops
  later disclosure but cannot recall earlier responses. Application rollback needs no data recovery.

## Related work

- [Assignee task list](2026-10-22-assignee-task-list.md): reuses primary-email matching to connect
  a person in the Almanac to the caller's account.
- [External MCP server](2026-10-07-external-mcp-server.md): partially supersedes only the rule
  “An external role must never widen what a person sees in the app”, for this tool's title,
  start and duration disclosure. The rest of the earlier record remains in force, subject to its
  other documented partial supersessions.

## Timeline

- **2026-11-07**: maintainer accepted the attendance exception; implemented the tool, documented
  the disclosure boundary and ran focused checks.
