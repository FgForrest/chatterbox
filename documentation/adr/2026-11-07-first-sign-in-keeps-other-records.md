---
title: A first single sign-on no longer takes over a record whose name does not fit
date: 2026-11-07
updated: 2026-11-07 21:55
status: accepted
kind: fix
issues: []
prs: [341]
areas: [src/lib/sso/almanac.ts, src/lib/sso/auth-hooks.ts, src/lib/knowledge/duplicate-score.ts, content/docs/self-hosting/sso.mdx]
supersedes: []
superseded-by: []
relates: [2026-10-06-oidc-single-sign-on, 2026-11-07-attended-recordings-for-time-reporting]
---

# A first single sign-on no longer takes over a record whose name does not fit

At a person's first single sign-on, an Organization person who holds their address but has a name
that does not fit theirs keeps the name and loses the address, and the signed-in person gets a new
record. Afterwards their record follows the provider, as before.

## Why

Members can put an address on an Organization person before its holder ever signs in: Learn on a
shared mail fills an empty primary email. The address is the only link between a person and an
account, and people write it, so it can be wrong while the account's own address is verified.

### Previous state

Every sign-in found the person by address and gave them the provider's name. With a wrong address,
the first sign-in renamed someone else's record to the holder. The old name vanished from recordings
and summaries, the old person's tasks became the holder's because task assignment reads the primary
email, and the attended recordings tool listed that person's later meetings to the holder.

## Options considered

### Compare the names at the first sign-in and split on a mismatch (chosen)

- **Pros:** fixes the name, the tasks and the attended list together, with no schema change.
- **Cons:** names are weak evidence. A nickname the scorer does not know splits a correct record.

### Only stop the rename (declined)

- **Pros:** cannot harm a correct record.
- **Rejected because:** the holder keeps the other person's tasks and attended meetings, now under a
  name that is not theirs, and nothing shows that the address is wrong.

### A column linking a person to its user (declined)

- **Pros:** a sign-in would know the record is its own, so a later address change at the provider
  could be checked too, and first sign-in would need no timestamp.
- **Rejected because:** it needs a migration and a backfill SQL cannot do, because the address hash
  is an HMAC computed in the app. Worth revisiting if a takeover through an address change appears.

## Decision

**Compare and split, and when in doubt, split.** A wrong split costs a curator merge. A wrong
takeover hands someone's tasks over with no sign that it happened.

## Key technical details

- `recordSsoUserInAlmanac` in `src/lib/sso/almanac.ts` applies this to the Organization's Almanac
  only: in a person's own Almanac nobody else writes.
- `personNamesFit` in `src/lib/knowledge/duplicate-score.ts` needs all words of one name in the
  other, given nicknames and initials and without academic titles. It deliberately does not fold
  surname forms, because that also folded Ivana to Ivan. At least one whole word must be shared, so
  bare initials or a name with no words left fit nothing.
- These are not someone else's record: one the holder created, and one named by the address itself.
- A provider that gives no name proves nothing: the record stays and nothing is renamed. Splitting
  here would duplicate every known person on a deployment whose provider sends no `name` claim.
- `lastSsoLoginAt` null means a first sign-in. `afterSsoSession` must stamp it after recording the
  person, and does not stamp a first sign-in that failed to record anyone, so the next one repeats
  the check.

## Verification

`src/tests/sso/sso-login.integration.test.ts` goes through the real login hook with a fake identity
provider, on PostgreSQL. `src/tests/knowledge/duplicate-score.test.ts` holds the name table. Each of
15 mutations of the new conditions failed a test, including the order of the stamp. Two Codex review
rounds and the PR review bot found holes in earlier versions of the name rule, all with
reproductions; what they left open is listed below.

## Consequences & open follow-ups

- Records already renamed this way are not repaired: the old name is gone.
- A later address change at the provider can land on another person's record and rename it, because
  only the first sign-in is checked.
- Two people named `Jan Dvořák` and `Jan Karel Dvořák` count as one.
- A provider name that is blank keeps the record linked. A member who can blank their name at the
  provider, and whose address someone already put on another person, keeps that person's tasks,
  though not the name.
- A first sign-in that failed to record the person leaves that user's mail addresses inactive until
  their next sign-in.
- A user with a null stamp who signed in long ago, before the column and with no session left for
  its backfill, whose record a colleague created and whose provider name has since changed
  completely, looks like a first sign-in. Their record splits.

## Related work

- [2026-10-06-oidc-single-sign-on](2026-10-06-oidc-single-sign-on.md): introduced recording every
  sign-in in the Almanac, which still holds.
- [2026-11-07-attended-recordings-for-time-reporting](2026-11-07-attended-recordings-for-time-reporting.md):
  matches a caller to a person by the same address, and exposed this defect.

## Timeline

- **2026-11-07**: found while reviewing the attended recordings tool, fixed in PR #341
