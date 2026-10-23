---
title: Self-host sign-in through one OpenID Connect provider, password login switched off
date: 2026-10-06
updated: 2026-10-22 22:30
status: accepted
kind: feature
issues: []
prs: [88]
areas: [src/lib/sso, src/lib/auth.ts, src/db/schema.ts, content/docs/self-hosting/sso.mdx, docker-compose.e2e.sso.yml, e2e/keycloak]
supersedes: []
superseded-by: []
relates: [2026-10-14-identity-provider-authorization, 2026-10-07-external-mcp-server]
---

# Self-host sign-in through one OpenID Connect provider, password login switched off

A self-hosted instance with `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` set hands
sign-in to one OpenID Connect provider (Keycloak in tests) through better-auth's `genericOAuth`
plugin, provider id `oidc`. Email/password sign-in, sign-up, password reset and email change are
switched off on the server, not just hidden. Anyone the provider authenticates gets an account just
in time, an existing account is linked only when the provider marks the email verified, name and
email follow the provider on every sign-in, and every sign-in records the person in the
Organization Almanac. Hosted mode ignores all of it.

## Why

An organization running Chatterbox for its staff wanted its existing identity provider to decide
who gets in, with no second set of passwords. The constraints that made it non-obvious:

- Instances switching to SSO already have password users with recordings, so linking had to be
  safe against account takeover, while self-host never verifies the email of a password account.
- Hosted mode has its own sign-up, billing and password-based admin re-auth, which SSO must not
  disturb.
- The Organization account signs in with a password today, and claim-based Organization
  permissions were explicitly left for a later session.
- Later features (the external MCP server, inbound mail) build on SSO as the proof of who a person
  is, so the choices here became their trust anchor.

## Options considered

Each fork was put to the maintainer as a question; the chosen answer is listed first.

### Library: better-auth `genericOAuth` (chosen) or Auth.js

- **better-auth `genericOAuth`:** discovery, PKCE and an RFC 9207 `iss` check, writing to the same
  session, user and account tables, so SSO users are ordinary users.
- **Auth.js (next-auth v5)**, which both reference examples used.
  - **Rejected because:** it is a second auth stack beside better-auth and needs a bridge to create
    better-auth sessions: two session systems and much more code.

### Modes: self-host only (chosen) or self-host and hosted

- **Rejected because:** hosted SSO would need its billing and trial sign-up and its password-based
  admin re-auth reworked. Hosted keeps email/password unchanged; the variables are inert there.

### Who gets an account: anyone the provider authenticates (chosen)

Declined alternatives: just-in-time creation only for tokens carrying a configured group or role, an
email-domain allowlist, or pre-existing accounts only.

- **Rejected because:** access control belongs in the identity provider (client assignment, realm
  users). Riffado would duplicate it. `DISABLE_REGISTRATION=true` later became the
  "pre-existing accounts only" switch for SSO (`disableSignUp`), so that option remains available
  per instance.

### Linking existing accounts: by verified email (chosen)

- **Link by email, ignoring verification.** Simpler, since Keycloak realms often do not verify
  emails.
  - **Rejected because:** an IdP user who can set any email can take over an existing account.
- **Never link.**
  - **Rejected because:** every existing user would lose their recordings to an unreachable
    password account.
- An unverified email creates a new account, or fails with `account_not_linked` when the address
  is taken ("create, don't link"). Rejecting unverified emails outright was declined because the
  provider did authenticate the person.

### Password shutdown and the Organization account: strict, no Organization login (chosen)

- **Break-glass flag** (for example `SSO_ALLOW_PASSWORD_LOGIN`) to re-enable passwords while the
  provider is down. **Password for the Organization account only.** **An IdP user whose email
  equals `ORG_ACCOUNT_EMAIL` signs in as the Organization account**, as a stopgap.
  - **Rejected because:** the maintainer wanted SSO strict for everyone, with Organization rights
    granted to chosen people by an IdP claim in a later session rather than through a stopgap. A
    matching-email login would also give the Organization's rights to whoever controls that address
    at the provider (inferred). With SSO on, the Organization account keeps owning the shared tree
    but has no interactive login, and an IdP user with its email is refused. Claim-based
    Organization rights arrived with
    [2026-10-14-identity-provider-authorization](2026-10-14-identity-provider-authorization.md).

### Sign out: Chatterbox session only (chosen) or also RP-initiated provider logout

- RP-initiated logout at the provider's `end_session_endpoint` was the recommended option, so that
  the next sign-in asks for credentials again.
  - **Rejected because:** the maintainer chose to end only the Chatterbox session. The
    maintainer's security concern is the other direction: when the identity provider signs a user
    out, Chatterbox must end its own session as soon as it learns of it. In this mode it learns
    through the fixed 24-hour session lifetime below; `AUTHZ_MODE=idp` later added re-verification
    that refuses a session once the provider stops renewing it
    ([2026-10-14-identity-provider-authorization](2026-10-14-identity-provider-authorization.md)).

### Deprovisioning: fixed 24-hour SSO sessions (chosen)

- **Default session lifetime** (7 days, refreshed by use).
  - **Rejected because:** a user disabled in Keycloak would keep working for up to a week.
- **Re-check the provider periodically** by refreshing the IdP token on session use.
  - **Rejected because:** most accurate but most code, and it requires storing the provider's
    tokens. `AUTHZ_MODE=idp` later added exactly this, as an opt-in mode.

### Existing sessions at the switch: revoke once (chosen) or let them expire

- **Rejected because:** letting password sessions run out would leave people inside without passing
  through the provider, so they would not be linked or recorded in the Almanac.

### One provider via discovery (chosen) or several

- **Rejected because:** indexed or JSON configuration with one button per provider adds config
  surface that a single organization rarely needs.

## Decision

**Chosen: better-auth `genericOAuth`, self-host only, one provider, just-in-time accounts linked by
verified email, password endpoints disabled server-side.** It reuses the existing session model,
leaves hosted untouched, and keeps the provider the single place that decides who is in. What would
reopen it: hosted customers asking for their own provider (per-tenant SSO), or a need to mirror
provider sign-out across applications.

## Key technical details

- Wiring: `src/lib/auth.ts` (`genericOAuth`, `disabledPaths`, `accountLinking.requireLocalEmailVerified: false`,
  `overrideUserInfo: true`, `disableSignUp: env.DISABLE_REGISTRATION`); hooks in
  `src/lib/sso/auth-hooks.ts`; Almanac upsert in `src/lib/sso/almanac.ts`; the one-time revocation
  in `src/lib/sso/startup.ts` under an advisory lock, marked in the `instance_state` table
  (migration 0090). The marker is cleared when SSO is off, so switching it off and on revokes again.
- `requireLocalEmailVerified: false` looks like a weakening. It is required: self-host never
  verifies password users' emails, so the default would refuse every link. The provider stays
  untrusted, so linking still needs `email_verified` from the provider.
- `mapSsoProfile` keeps the old email when the provider's new email belongs to another account.
- better-auth decodes the ID token without verifying its signature (acceptable for the code flow
  over TLS, per OpenID Connect Core). Hence `OIDC_ISSUER_URL` must be `https` unless the host is internal
  (loopback, private IP, single-label or `.local`/`.internal` names).
- Partial configuration (one of the three variables missing) stops the server.
- The provider's tokens are not stored in this mode. Personal API tokens are not sessions and keep
  working.
- Admitting a newcomer while `DISABLE_REGISTRATION=true`: unset it, let them sign in once, set it
  again (documented in `content/docs/self-hosting/sso.mdx`).

## Verification

- PR #88: 2,888 tests passed, including `src/tests/sso/sso-closed.integration.test.ts`
  (`DISABLE_REGISTRATION` under SSO), `src/tests/sso/sso-login.integration.test.ts` (fake IdP
  against Postgres) and `src/tests/sso/keycloak.integration.test.ts` (real Keycloak 26.4.0 via
  `docker-compose.e2e.sso.yml`).
- Browser check on the e2e stack with Keycloak: login button, landing in onboarding, the Almanac
  entry, error messages, password API answering 404, sign-out and silent re-sign-in.
- A security review found nothing at or above its reporting threshold. Two account pre-hijack paths
  below it were accepted as not applicable to the intended deployments: provider users who can set
  an unverified email, and password accounts squatted before the switch (registration was not open
  to untrusted people).

## Consequences & open follow-ups

- The external MCP server requires SSO and uses its realm as the only token issuer
  ([2026-10-07-external-mcp-server](2026-10-07-external-mcp-server.md)); inbound mail gives
  mailboxes only to SSO-linked accounts.
- The two accepted pre-hijack paths hold only while the provider does not let ordinary users change
  their email and registration was closed before the switch. A deployment where either is false
  needs a fresh look.
- A user disabled at the provider keeps access for up to `OIDC_SESSION_MAX_AGE` (24 hours by
  default) in the default `local` authorization mode.

## Related work

- [2026-10-14-identity-provider-authorization](2026-10-14-identity-provider-authorization.md): adds
  the deferred claim-based Organization rights, periodic revalidation and the issuer binding on top
  of this sign-in.
- [2026-10-07-external-mcp-server](2026-10-07-external-mcp-server.md): trusts this realm for MCP
  bearer tokens.

## Timeline

- **2026-10-06**: requirements settled with the maintainer in four question rounds; implemented,
  security-reviewed, PR #88 opened.
- **2026-10-06**: `DISABLE_REGISTRATION` made to close SSO sign-up as well; PR #88 merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
