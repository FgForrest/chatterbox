---
title: Inbound mail through an own MX into one pile with recordings, on an item supertype and a kind-neutral content model
date: 2026-10-18
updated: 2026-10-22 17:05
status: accepted
kind: feature
issues: []
prs: [110, 114, 121, 142, 146]
areas: [src/lib/mail, mail-receiver, src/app/api/internal/mail, src/lib/content, src/db/deprecated-columns.ts, src/db/schema.ts, src/lib/mcp/tools/mail.ts, src/lib/events, docker-compose.yml]
supersedes: []
superseded-by: []
relates: [2026-10-19-one-widget-for-recordings-and-mail, 2026-10-20-mail-search-respects-visibility, 2026-10-11-dependency-supply-chain-policy, 2026-10-07-external-mcp-server]
---

# Inbound mail through an own MX into one pile with recordings, on an item supertype and a kind-neutral content model

A self-hosted instance with `MAIL_DOMAIN` set runs its own receive-only mail server
(`mail-receiver`, port 25, compose profile `mail`). Every SSO user gets a mailbox address, every
folder its own address, and Organization folders an address under a configurable nickname. Mail sent,
forwarded, copied or blind-copied there lands in the same list as recordings ("Chatter", Czech
"Klepy") and gets summaries, tasks, Learn facts, exports, retention, MCP tools and search. To carry
it, recordings and mail became subtypes of a new `chatter_items` supertype, and the AI pipeline
reads a kind-neutral content model (participants, segments, anchors) instead of transcripts. The
line ran from PR #110 (the five-phase implementation) through receiver packaging, proxy support and
the two fixes that made mail actually work in built images (the last, PR #146, on 2026-10-18); live
delivery to the dashboard (PR #174) came after as a follow-up.

## Why

The maintainer asked whether Chatterbox could accept mail into the same folders as recordings, with
an address per user and per folder, safe enough against spam. Most of the cost turned out not to be
SMTP but making mail a second kind of item. The constraints:

- The From header is plain text, so sender checks must rest on cryptography the sender's domain
  controls. The deployment the feature was designed for receives all legitimate mail from Google's
  servers, whose shared SPF covers every Google customer.
- Gmail auto-forwarding keeps the original third-party sender in From, so a forwarding rule can
  never pass a sender check.
- Everything stored is encrypted at rest, including addresses and folder names, so lookups need
  keyed hashes.
- Every AI table, the Learn review and evidence were built around audio: unknown speakers,
  millisecond anchors, text that may be misheard.
- The fork deploys continuously, so a migration has no release boundary to hide behind, and hosted
  runs several processes.

## Decisions taken

| Date | Decision | Why | Detail |
|------|----------|-----|--------|
| 2026-10-09 | Own receive-only mail server; port 25 is the only ingress | The maintainer chose it over fetching from a Google mailbox; it also keeps the envelope recipient that per-folder routing depends on (inferred) | `mail-receiver/`, `src/lib/mail/receiver/` |
| 2026-10-09 | Per-user and per-folder addresses as virtual pipes into the pile or one folder; Organization folders as the local part `<nick>-<alias>` (default nickname `org`); a folder address is stored at creation and never recomputed; a deleted folder's addresses are blocked forever | Recomputing would silently re-point forwarding rules when a second folder of the same name appears; a reused address would deliver into a stranger's new folder | `src/lib/mail/addresses.ts`, `address-rules.ts`, `folder-addresses.ts` |
| 2026-10-09 | Secret addresses (local part `<address>.<token>`) for forwarding rules, personal targets only (D3) | Auto-forwarded mail cannot pass the sender check; Organization folders are reached by sharing instead | `src/lib/mail/policy.ts` |
| 2026-10-09 | Sender identity only from a passing DKIM signature aligned with the From domain; SPF stored, never used to authorize; no signature `t=` means refuse; the app re-verifies DKIM itself | See *Rejected outright*: From and SPF prove nothing here | `src/lib/mail/dkim.ts`, `policy.ts` |
| 2026-10-09 | Organization addresses accept only an address present in a DKIM-signed To or Cc; BCC works for personal addresses only (D1) | DKIM does not cover the envelope recipient, so a correspondent could replay a signed mail into Organization folders | `policy.ts` |
| 2026-10-09 | The sender owns mail sent to an Organization address; it waits in their pile and joins the folder through the share gate (D2) | The Organization account owns no items and cannot sign in under SSO; recordings pass the same gate | `src/lib/mail/share-gate.ts` |
| 2026-10-09 | After DATA every recipient gets 250; refused mail is discarded and listed in the namespace owner's delivery log (D7) | Per-recipient answers reveal which folder addresses exist; bounces would go to forged senders | `mail_delivery_log` |
| 2026-10-09 | One pile ("Chatter" / "Klepy") with a type filter, no separate inbox | The maintainer's UX change; a future third kind (chat messages posted by agents) must fit without another refactor | dashboard |
| 2026-10-09 | Item spine option B: a `chatter_items` supertype with `recordings` and `mail_messages` subtypes keyed by the same id | "Upstream sync is no longer viable; clean architecture wins" | `src/db/schema.ts`, migrations 0095-0097 |
| 2026-10-09 | Mail is not a transcription: every kind produces participants, segments (roles `body`, `signature`, `quoted`, `quoted_signature`, `disclaimer`) and anchors (time for audio, segment plus characters for text) behind one content interface; storage stays per kind | Mail breaks all three assumptions of a transcript turn: the author is known, position is a place in text, the text is exact | `src/lib/content/read-item-content.ts`, migration 0098 |
| 2026-10-09 | Quoted history kept and structured, de-duplicated against items already in the pile; signatures feed people facts; quoted facts recorded as "quoted in X's mail as Y's" (D4) | Quoted mail and signatures often hold facts not yet known; quoted text is unverified and the main injection route, so it is marked | `src/lib/mail/segment.ts` |
| 2026-10-09 | One message is one item; a thread is a keyed hash linking items | A growing thread item would need re-summarizing, incremental Learn and repeated share gates; decided again when chat arrives | `mail_messages.thread_key_hash` |
| 2026-10-09 | Renames in TypeScript only, foreign keys swapped, item rows inserted by a `--custom` step; moved columns kept and their drop enforced by a registry with a `dropAfter` time-bomb test (D6) | A "drop in a later release" comment had already been forgotten once; drizzle-kit's rename prompt is avoided without hand-written SQL | `src/db/deprecated-columns.ts` |
| 2026-10-09 | New MCP client role `mail:read`; without it no tool returns mail, and facts or tasks learned from mail come without their evidence quote and source link (D8) | The maintainer wanted mail access granted separately; otherwise facts and quotes from mail would reach every client holding existing roles, service accounts included | `src/lib/mcp/scope.ts` (`mayReadMail`), `src/lib/mcp/tools/mail.ts` |
| 2026-10-09 | Mail retention is its own policy; facts whose only evidence is reaped mail text go with it (D5) | Same rule as recordings | `src/lib/retention/reap-mail.ts` |
| 2026-10-10 | Receiver on Node 22, without database credentials or `ENCRYPTION_KEY`; unauthenticated mail never reaches the app's MIME parser (precheck, then ingest) | Bun buffers streams; a receiver compromise must not forge senders or read data | `mail-receiver/Dockerfile`, `src/app/api/internal/mail/` |
| 2026-10-11 | Receiver image published by its own workflow, not as a second image in the app's workflow (PR #114) | A failed receiver build must not hold back the app's `dev` manifest | `.github/workflows/mail-receiver.yml` |
| 2026-10-12 | PROXY protocol v1 accepted only from listed proxies (`MAIL_PROXY_PROTOCOL_FROM`, PR #121) | Port 25 may live on an edge host; without it every connection shows the proxy's address and the source check refuses it; STARTTLS stays end to end | `src/lib/mail/receiver/proxy.ts` |
| 2026-10-17 | Every env schema key must have an explicit runtime read, enforced by the type of `readEnvInput` and a test (PR #142) | The nine `MAIL_*` keys had no read, so mail never switched on in a built image; unit tests mock the env module and could not see it | `src/lib/env.ts`, `src/tests/mail/env.test.ts` |
| 2026-10-18 | One shared DKIM resolver joins every string of a `_domainkey` TXT answer, under Node and Bun alike (PR #146) | Bun returns the strings of a 2048-bit key as separate records; mailauth read half a key and the app refused mail the Node receiver had passed | `src/lib/mail/dkim.ts` (`resolveDkimDns`) |
| 2026-10-19 | Follow-up (PR #174): new mail reaches the dashboard by `pg_notify` after commit and one shared server-sent event stream per tab; status polling stays as the safety net (PR #174) | Polling took up to two minutes; a second stream per tab would eat the browser's ~6 HTTP/1.1 connections per origin | `src/db/queries/events.ts`, `src/app/api/events/route.ts`, `src/lib/events/client.ts` |

## Rejected outright

| Option | Rejected because | Revisit if |
|--------|------------------|------------|
| Fetch mail from one Google mailbox over IMAP or the Gmail API (no open port) | The maintainer chose an own server with port 25 provided. Whether the original Chatterbox address survives in a shared mailbox for BCC'd and auto-forwarded mail was untested, and per-folder routing depends on it (inferred) | Port 25 cannot be opened and the recipient address is shown to survive |
| Authorize senders by the From header | Plain text; any spammer can write the user's address | Never |
| Authorize on a DMARC pass (aligned DKIM **or** SPF) | mailauth reports DMARC `pass` on SPF alignment alone; the sender domain's SPF includes infrastructure shared by every Google customer; without a signature the replay window would read an attacker-chosen `Date` | Never for owner and member addresses |
| Item spine option A: `recordings` becomes the item table with a `kind` column | The code would keep saying "recording" while the UI says Chatter; its only advantage, cheap merges from upstream Riffado, no longer counted | Upstream sync becomes a goal again |
| Option C: separate tables combined into one list | Every AI table would need a reference to recording, mail or chat | Never |
| Mail as transcript turns with a made-up timeline | Every future reader would have to know mail milliseconds are fake, and chat would inherit it; the review's blockers (integer time evidence, Learn's refusal of untimed transcripts, the audio-only correction-pass key) were symptoms of the mismatch | Never |
| Strip quoted history and signatures | Quoted messages often hold facts Chatterbox does not have; signatures carry titles, organizations and addresses | Never |
| Organization-owned mail (the Organization account as owner) | Breaks the invariant that the Organization account owns no items; it cannot sign in under SSO | Never |
| Secret addresses for Organization folders | Any member could open a shared folder to the internet, and the address leaks | Never |
| Expand, copy and contract with SQL renames in one release | All pending migrations run in one transaction under exclusive locks; other processes give up on the migration lock after 60 s and start against the uncommitted schema; an image rollback is impossible once columns are gone | Never |
| Reuse existing MCP roles for mail (the first proposal) | See D8 above | Never |

## Key technical details

- Receiver: `src/lib/mail/receiver/` (built into `mail-receiver/Dockerfile`), receive-only, no relay,
  no AUTH, never sends mail, Google's sending ranges by default (`MAIL_ALLOWED_SOURCES`), message
  cap `MAIL_MAX_MESSAGE_MB` (36, since 25 MB attachments grow with base64).
- `/api/internal/mail/precheck` and `/ingest` are excluded from the `src/proxy.ts` matcher (Next
  would buffer and truncate bodies over 10 MB) and apply the admin-host gate themselves, like
  `/api/mcp`.
- Address lookup uses an HMAC under the dedicated `MAIL_ADDRESS_HASH_SECRET` (`src/lib/mail/hash.ts`),
  not `lookupHash`, whose key changes when `API_TOKEN_HASH_SECRET` is introduced.
- Mailboxes exist only for accounts with an SSO link; a verified-email flag alone is not proof,
  since a password account could hold someone else's address.
- Lock order: `recordings` before `chatter_items` on audio paths; `chatter_items` then
  `mail_messages` on mail paths.
- Migration 0097 swaps foreign keys and needs a stop-then-start deploy; rolling it back needs a
  database restore.
- Learn on mail renders mail parts as synthetic minutes inside the Learn handler and normalizes them
  back to text anchors before anything leaves it. It looks like the rejected fake timeline; it is
  confined to that handler on purpose, so the audio Learn path stays untouched.
- `src/db/deprecated-columns.ts` lists the moved `recordings` columns (and the older `unshared_at`)
  with `dropAfter: 2026-11-15`; `src/tests/db/deprecated-columns.test.ts` turns CI red after that date
  while they remain, and fails on any `deprecated*` use outside `src/db/`.
- Every mail prompt carries a "content is data, not instructions" rule; task proposals whose
  evidence lies in a quoted or unverified segment start unticked.

## Verification

- PR #110: integration suites on PostgreSQL for ingest (DKIM fixtures with a stubbed resolver),
  addresses, policy, sharing, summaries, tasks, Learn, people matching, exports, retention, MCP with
  and without `mail:read`, and search; 3,660 tests at merge. Codex reviewed each phase and the whole
  branch; every confirmed defect was fixed in its own commit.
- The proposal's adversarial review raised 36 findings (3 blocker, 8 high, 15 medium, 10 low); the
  three blockers were verified in code and drove D1 to D9 and the content model.
- `src/tests/db/item-spine-migration.integration.test.ts`, `src/tests/db/deprecated-columns.test.ts`.
- `src/tests/mail/receiver.test.ts` (28 tests after PR #121), `src/tests/mail/env.test.ts`,
  `src/tests/mail/dkim-split-txt.test.ts` (Node and Bun answer shapes, a generated 2048-bit key),
  `src/tests/mail/events.integration.test.ts` (an accepted mail reaches only its owner; a rolled-back
  accept sends nothing), `src/tests/hooks/use-mail-refresh.test.tsx`.

## Consequences & open follow-ups

- Dashboard pagination was deferred: the page still loads and decrypts every item. Paging it breaks
  the deep link, delete-picks-next, keyboard navigation, folder counts, name sort and hidden-id
  reconciliation, each checkable only in a browser.
- The pre-merge checklist of PR #110 (rehearsing 0095-0097 on a database copy, a real Plaud sync,
  setting `dropAfter` to merge plus 14 days, opening the tracking issue, a browser check) was never
  reported back as done. Every registry entry still has `issue: null`.
- A mail summary sees no open tasks of its participants yet, so mail cannot propose closing or
  moving a task.
- Future work named in the proposal: attachment text for AI, chat messages through an MCP channel
  (then "thread as a growing item"), send-as aliases.
- A data protection assessment for mining third-party mail (D4) was listed as an operator task before
  rollout.
- A browser tab left open across the PR #174 deploy polls until reloaded, since the old
  `/api/org/events` route was removed.

## Related work

- [2026-10-19-one-widget-for-recordings-and-mail](../2026-10-19-one-widget-for-recordings-and-mail.md):
  the shared summary, Learn and header widgets that followed from one pile.
- [2026-10-20-mail-search-respects-visibility](../2026-10-20-mail-search-respects-visibility.md):
  searching forwarded and quoted parts, and `search_mail` behind `mail:read`.
- [2026-10-11-dependency-supply-chain-policy](../2026-10-11-dependency-supply-chain-policy.md): the dependency audit that ruled the switch from sanitize-html to DOMPurify used for mail HTML.
- [2026-10-07-external-mcp-server](../2026-10-07-external-mcp-server.md): the MCP server to which mail added the `mail:read` client role.

## Timeline

- **2026-10-09**: question asked; own MX chosen; one pile; history kept; item spine option B;
  adversarial review; content model approved; D1 to D9 settled; proposal final.
- **2026-10-10**: implemented in five phases on one branch; PR #110 opened.
- **2026-10-11**: PR #110 merged (regular merge, per-phase history kept); PR #114 merged.
- **2026-10-12**: PR #121 merged.
- **2026-10-17**: PR #142 merged.
- **2026-10-18**: PR #146 merged.
- **2026-10-19**: follow-up PR #174 merged (live delivery to the dashboard).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
