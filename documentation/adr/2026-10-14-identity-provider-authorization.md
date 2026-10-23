---
title: Opt-in identity-provider authorization with access managed under the administrator's own sign-in
date: 2026-10-14
updated: 2026-10-22 22:30
status: accepted
kind: feature
issues: []
prs: [131]
areas: [src/lib/authz, src/lib/access, src/lib/identity/providers/keycloak, src/lib/sso/auth-hooks.ts, src/lib/mcp/token.ts, src/components/settings-sections/access-section.tsx, content/docs/self-hosting/sso.mdx, docker-compose.local-authz.yml, e2e/authz]
supersedes: [2026-09-23-shared-organization-scope, 2026-10-07-external-mcp-server]
superseded-by: []
relates: [2026-10-06-oidc-single-sign-on, 2026-10-21-curators-manage-organization-almanac, 2026-10-19-processing-profiles-and-workflow]
---

# Opt-in identity-provider authorization with access managed under the administrator's own sign-in

`AUTHZ_MODE=idp` (opt-in; `local` stays the default) makes the identity provider the source of three
capabilities, granted as client roles of the sign-in client through one group each: `use` (sign in,
API keys, the meeting recorder, MCP), `org.curate` (curate Organization content under one's own
identity) and `access.manage` (change others' capabilities in **Settings → Access**). Only Keycloak
is supported. Administrators change access with their own provider credentials; a read-only
verifier client re-checks key holders. Provider tokens are kept encrypted per session, sessions
re-verify their capabilities periodically, and every change is audited. The PR came from an
external contributor; the decisions recorded here are the ones taken while it was reviewed and
fixed before merge.

## Why

Single sign-on ([2026-10-06-oidc-single-sign-on](2026-10-06-oidc-single-sign-on.md)) let in anyone
the provider authenticated and left the Organization account without an interactive login, with
"Organization permissions from an IdP claim" deferred to a later session. Without this, nobody could
curate the Organization on an SSO instance, and a person disabled at the provider kept access for
the whole fixed session.

The constraints: self-host must keep working unchanged in `local` mode; a provider change (group
membership, a session ended at Keycloak) cannot be rolled back with a database transaction; hosted
runs several processes; MCP bearer tokens come from callers, unlike tokens the server fetched itself.

## Options considered

The capability model, the Keycloak adapter and delegated management were the contributor's design.
The forks below were decided by the maintainer during the review rounds (PR #131 threads and summary
comments).

### Who may change access: the administrator's own sign-in (chosen) or a privileged service credential

- **Chosen:** changes go through the administrator's own provider token, which must be younger
  than `AUTHZ_ADMIN_MAX_AUTH_AGE` (8 hours by default; re-sign-in with `prompt=login`, `max_age=0`).
  The verifier client that re-checks API-key holders is read-only.
- **Service credential with write or logout rights.**
  - **Rejected because:** it would be a permanent privileged credential sitting on the server.

### Ending provider sessions that failed to end: manual retry (chosen) or automatic retry

- Taking `use` away records the new access state and deletes the person's Chatterbox sessions
  before Keycloak is asked to end its own, so sessions, API keys and MCP are cut either way. Only
  Keycloak's own sessions can stay `pending` or `failed`.
- **Automatic background retry.**
  - **Rejected because:** ending them needs an administrator's own token, which no background job
    holds; the verifier is read-only on purpose (see above).
- A follow-up issue for visibility was proposed; the maintainer chose to fold it into the PR
  instead ("Visibility is a good thing"): `GET /api/access/pending-revocations` and a box at the top
  of Settings → Access naming those people.

### Issuer binding: in both modes (chosen) or only under `AUTHZ_MODE=idp`

- Each SSO account is bound to the issuer that vouched for it.
- **Bind only in `idp` mode, or ship an operator rebind path** (reviewer's suggestion).
  - **Rejected because:** the binding stops another realm's subject from taking over an account,
    and that risk is the same in `local` mode. Upgrading refuses nobody (existing accounts bind on
    their next sign-in); only a later move of the realm's address does, and the documented recovery
    is one SQL statement (see Key technical details).

### Web sign-in client in `MCP_ALLOWED_CLIENTS`: refused at startup in both modes (chosen) or only in `idp` mode

- **Rejected because:** the MCP caller resolution refuses tokens issued to the web sign-in client in
  either mode, so a startup error only surfaces what would otherwise be silent 403s. The PR title
  carries `!` and the description a migration note (remove it from the list).

### MCP token signed by an unknown key: 401 (chosen) or 503 like web sign-in

- The SSO token verifier treats an unknown `kid` as "provider unavailable" (503) because it only
  sees tokens the server fetched from the realm's token endpoint, where an unknown key can only mean
  rotation.
- **Answer 503 for MCP too** (reviewer's request).
  - **Rejected because:** an MCP bearer comes from the caller. A 503 would report an outage for every
    forged token and every token from another realm, and it would drop the 401 challenge that sends
    an MCP client back through OAuth discovery. Rotation is still picked up: jose refetches the key
    set on an unknown `kid` unless it fetched in the last 30 seconds.

### Local writes after the provider change: on the global connection (chosen) or inside the lock transaction

- **Rejected because:** the provider's change cannot be rolled back. If the access-state record,
  the session deletion or the snapshot invalidation ran inside the advisory-lock transaction, a
  later failure would roll them back and leave a person who lost `use` at the provider with live
  Chatterbox sessions.

## Decision

**Chosen: `AUTHZ_MODE=idp` as an opt-in mode with delegated access management, plus the five review
rulings above.** Each ruling keeps an access withdrawal effective even when a later step fails, and
keeps the provider's privileged rights out of the server's own credentials. Revisit the manual
revocation retry only if a privileged background credential becomes acceptable; revisit the
both-modes issuer binding if self-hosters routinely move realms.

## Key technical details

- Capability model and checks: `src/lib/authz/policy.ts`, `src/lib/authz/model.ts`; session
  re-verification: `src/lib/authz/session-access.ts` (`AUTHZ_VERIFICATION_MAX_AGE`, 30 minutes by
  default); access changes, audit and pending revocations: `src/lib/access/service.ts`
  (`changeAccess`, `revokeSessions`, `pendingRevocations`); provider adapter:
  `src/lib/identity/providers/keycloak/`.
- While the provider cannot be reached, requests are refused (503), never served with old
  capabilities.
- `access_change_log` gets a `pending` row before the provider is asked, settled afterwards. A row
  left `pending` marks a change whose outcome was lost (a crash): check the person at the provider.
  Tokens are never recorded.
- A session renewal holds one connection (`accessStateVersion` takes the transaction executor), and
  parallel requests of one session join one in-flight renewal. The refresh call stays under the row
  lock on purpose: with refresh-token rotation, a second refresh with the same token fails as
  `invalid_grant` and would end the session.
- Lock waits in `changeAccess` give up after 10 seconds (`lock_timeout`, answered 409).
- Curator checks that may call the provider run before a recording's row lock, never inside it.
- Issuer recovery after moving the same realm to a new address:
  `UPDATE accounts SET issuer = NULL WHERE provider_id = 'oidc';` Each account binds again on its
  next sign-in. Moving people to a different realm deliberately means deleting their `oidc` account
  links instead.
- Changes that also hit `local` mode: MCP tokens must carry `typ: Bearer`; `tasks:write` brings
  `tasks:read`; service clients are listed in `MCP_SERVICE_CLIENTS` (an unlinked token is still
  taken as a service by `client_id` while that list is empty, with a deprecation warning).
- Compose passes `AUTHZ_MODE: ${AUTHZ_MODE:-}`, so an empty value must mean `local`; the env schema
  preprocesses blank values to unset.

## Verification

- PR #131: full suite 3,865 passed, 97 skipped; 66 Keycloak integration tests passed separately
  (67 after the pending-revocation commit, against Keycloak 26.7.2).
- Review fixes added `src/tests/sso/tokens.test.ts` (19 cases: wrong `iss`/`aud`/`azp`/`typ`,
  `alg: none`, HS256, foreign signature, expiry, missing `sub`, mismatched subjects, no `use`),
  `src/tests/authz/session-renewal.test.ts`, `src/tests/mcp/caller-idp.test.ts`,
  `src/tests/access/settings-nav.test.ts` and `src/tests/authz/env.test.ts` (blank `AUTHZ_MODE`
  parses as local).
- `src/tests/mcp/token.test.ts` covers key rotation: a rotated key is refused during the 30-second
  cooldown and accepted after the refetch.
- The first review round found 1 blocker, 1 critical and 7 majors; the third round approved with no
  findings.

## Consequences & open follow-ups

- Curators edit supported Organization content under their own identity; see
  [2026-10-21-curators-manage-organization-almanac](2026-10-21-curators-manage-organization-almanac.md).
- A person disabled at the provider loses access within `AUTHZ_VERIFICATION_MAX_AGE`; an access
  token an AI client already holds stays valid until it expires, though `use` is re-checked on every
  MCP call.
- The full local compose startup of the example realm (`docker-compose.local-authz.yml`) was left
  to confirm on the contributor's machine, and live identity brokering and external Claude
  connections were left as deployment checks (PR #131 description).

## Related work

- [2026-10-06-oidc-single-sign-on](2026-10-06-oidc-single-sign-on.md): the sign-in this mode sits
  on; it deferred the claim-based Organization rights delivered here.
- [2026-10-21-curators-manage-organization-almanac](2026-10-21-curators-manage-organization-almanac.md):
  builds on `org.curate`.
- [2026-09-23-shared-organization-scope](2026-09-23-shared-organization-scope/README.md): the Organization account model that `org.curate` extends; supersedes its rule that curation goes only through the Organization account's login.
- [2026-10-19-processing-profiles-and-workflow](2026-10-19-processing-profiles-and-workflow/README.md): the roles that manage Organization providers and profiles in the processing work.
- [2026-10-07-external-mcp-server](2026-10-07-external-mcp-server.md): the MCP token checks this record refined, superseding them in that part.

## Timeline

- **2026-10-06**: claim-based Organization permissions deferred to a later session while SSO was
  designed.
- **2026-10-14**: PR #131 opened by an external contributor; first review (1 blocker, 1 critical,
  7 majors); fixes pushed, PR retitled `feat(auth)!:`.
- **2026-10-14**: second review approved; the 401 and global-connection rulings recorded with a
  key-rotation test; the pending-revocation marker folded in; PR #131 merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
