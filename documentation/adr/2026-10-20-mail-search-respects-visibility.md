---
title: Mail search reads forwarded and quoted parts but never more than the caller may already see
date: 2026-10-20
updated: 2026-10-22 16:00
status: accepted
kind: feature
issues: []
prs: [185, 186, 191, 197]
areas: [src/lib/mail/searchable-parts.ts, src/lib/mcp/data/mail.ts, src/lib/mcp/tools/mail.ts, src/lib/mcp/scan.ts, src/lib/search/item-search.ts, src/lib/mail/internal-address.ts]
supersedes: []
superseded-by: []
relates: [2026-10-18-inbound-mail, 2026-10-07-external-mcp-server]
---

# Mail search reads forwarded and quoted parts but never more than the caller may already see

Both the app search (the Chatter list and the command palette) and a new MCP tool `search_mail`
(role `mail:read`) search a mail's body and quoted parts, never signatures, disclaimers or
attachments. `search_mail` finds only mail that `list_mail` shows the caller and matches only text
that `get_mail` returns to that caller, after masking. A quoted part whose original is already in
the pile is skipped only when that original is itself a candidate of the same search. Chatterbox's
own inbound addresses are never offered, linked or stored as a person's address.

## Why

Mail reaches Chatterbox mostly by forwarding, and the segmenter stores the forwarded message as a
`quoted` part; only the forwarder's own line is `body`. The app search read body segments alone, so
it missed most mail content. On the MCP side a model could only page `list_mail` (50 at a time, no
filter) and open mail one by one, which burns the rate limit and fills its context, while
recordings, summaries and tasks each had a bounded search. The maintainer was building Claude
skills that use mail as meeting context.

The constraint that made it non-obvious: quoted parts point into their owner's pile, mail is
encrypted (no SQL text search), and a colleague's shared reply may quote a mail that is still
private. A naive search either leaks the private original or misses text the colleague can read.

## Options considered

### What the MCP tool may scan: exactly what `list_mail` and `get_mail` give the caller (chosen)

The maintainer's ruling: "We need to respect private / organizational visibility on MCP call!"

- The scan runs under `mcpItemCondition`: a user's own mail plus Organization-shared mail; a service
  caller gets shared mail only. Filters (dates, folder, person, entity) are ANDed to it and can only
  narrow. A colleague's private folder answers "No such folder".
- Snippets come from the same decrypted, masked content `get_mail` returns; the summary only with
  `summaries:read`, `entity` only with `knowledge:read`.
- No alternative scope was proposed; the ruling fixed the boundary.

### Quoted parts of a known original

- **Keep reading body segments only** (the previous app search). Misses most forwarded content.
  - **Rejected because:** the forwarded text is usually the substance.
- **Search every quoted part.**
  - **Rejected because:** one thread would return every reply that quotes the same original.
- **Skip a known quote when its original is visible to the viewer** (PR #185). For a colleague whose
  original is still private, the quote is searched, since the colleague reads it in that mail
  anyway, and the original's id never appears in a result.
  - **Superseded by the next rule because:** a reply filed in a folder, inside a date range or
    matching a person was found by neither the reply (quote skipped) nor the original (outside the
    filter). The app search's Organization view had the same bug.
- **Skip a known quote only when its original is a candidate of the same search** (scope and
  filters, not the continuation cursor), PR #191. Chosen: the original is skipped only when it will
  be found on its own.

### The person filter: includes authors of forwarded and quoted parts (chosen)

- **Senders and recipients only.**
  - **Rejected because:** the maintainer asked for forwards to count; with mail arriving mostly by
    forwarding, the quoted author is often the person sought (inferred).

### A secret address linked to a person: fix the root (chosen) or patch the search

- After PR #191, a participant could be linked to a person through Chatterbox's own secret address
  (a forward to the owner's secret address carrying the owner's name, confirmed in Learn review).
  The search then had to reconcile an SQL person match with a masking check, and quoted text only
  in that mail went unfound.
- **Patch the person filter in the search.**
  - **Rejected because:** the maintainer ruled that an internal address should never be offered as
    someone else's address. Such an address routes mail into a pile; it is nobody's correspondence
    address, and once stored on a person, ingest linked every later mail with it to that person.
    PR #197 prevents it everywhere (Learn proposals, review confirmation, ingest, SSO Almanac sync,
    person promotion, the person editor) and ships a cleanup script.

## Decision

**Chosen: one shared selection helper for body and quoted parts, a known quote skipped only when its
original is a candidate of the same search, MCP search bounded by exactly what the caller can list
and read, and internal addresses kept off people.** It closes the content gap without letting search
become a way around visibility. A future change that widens what `get_mail` returns widens search
with it, and nothing else should.

## Key technical details

- `searchableMailParts` (`src/lib/mail/searchable-parts.ts`) is the one rule for which parts are
  searched, shared by `src/lib/search/item-search.ts` and `src/lib/mcp/data/mail.ts`. One
  owner-scoped query per batch finds which known originals qualify.
- Limits per `search_mail` call: 500 mails, 10 seconds or 50 matches, within the shared budget of
  10 searches a minute. `boundedScan` (`src/lib/mcp/scan.ts`) gained `stopBeforeBatch`, because
  loading a mail batch already decrypts it, so the limit is checked before the next batch loads.
- Every part is masked before matching, the caller's own mail included, so a query cannot confirm a
  secret address. The app search masks a colleague's mail only; the viewer's own is not masked.
- Mail participants are stored under `participantAddressHash`, which is not `lookupHash`; the person
  filter decrypts and rehashes the person's addresses.
- `isInternalMailAddress` (`src/lib/mail/internal-address.ts`) matches the exact `MAIL_DOMAIN`;
  without `MAIL_DOMAIN` nothing is internal.
- Snippets cut at whitespace and merge windows that touch (all MCP searches and the app search).
- After upgrading to PR #197, `unlink-internal-addresses.js` (dry run by default, `--apply`) removes
  links and person emails created earlier.

## Verification

- `src/tests/mail/searchable-parts.test.ts`; `src/tests/search/item-search.integration.test.ts` (a
  Czech Gmail forward, the known-quote rule for owner and colleague, a private original's id never
  shown, a deleted original no longer hiding the quote).
- `src/tests/mcp/mail.integration.test.ts`: a colleague's private mail never read, service callers
  see shared mail only, a parity check that every snippet is text `get_mail` returns, masking for
  owners, the 50-match and 500-mail limits with a gap-free continuation, the 10-second deadline, the
  eleventh search in a minute, 403 without `mail:read`.
- Measurement in PR #186 (opt-in): 2,000 seeded mails with 1,000 long threads, 6,000 quoted parts and
  15 million characters; one full 500-mail call with summaries took 1.8 s.
- `src/tests/mail/internal-addresses.test.ts`, `internal-addresses.integration.test.ts`,
  `unlink-internal-addresses.integration.test.ts`, `src/tests/learn/mail-candidates.test.ts`.
- Whole suite at PR #197: 6,243 passed, 99 skipped.

## Consequences & open follow-ups

- Stored mail is not re-parsed with the new signature rules from PR #191 (`MAIL_PARSER_VERSION` 2):
  a re-parse writes a new content revision, which supersedes Learn runs and may trigger AI work
  again, so a backfill was left as a separate decision. `mail-segmentation-diff.js` measures what it
  would change.
- `backfill-mail-language.js` fills the stored language of older mail once after upgrade (optional;
  search detects each part's language anyway).

## Related work

- [2026-10-18-inbound-mail](2026-10-18-inbound-mail/README.md): the segments, `knownItemId`
  de-duplication, secret addresses and the `mail:read` role this search builds on.
- [2026-10-07-external-mcp-server](2026-10-07-external-mcp-server.md): the bounded decrypt-scan and
  row-scoping rules `search_mail` extends.

## Timeline

- **2026-10-19**: limits, the person filter and the app-search fix decided; visibility ruling;
  PRs #185 and #186 merged.
- **2026-10-20**: live test findings fixed in PR #191 (known-quote rule narrowed to candidates);
  internal-address ruling, PR #197 merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
