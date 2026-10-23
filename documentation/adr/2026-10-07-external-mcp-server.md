---
title: External MCP server in the app, gated by Keycloak client roles from the SSO realm
date: 2026-10-07
updated: 2026-10-23 06:45
status: superseded
kind: feature
issues: []
prs: [98]
areas: [src/app/api/mcp/route.ts, src/lib/mcp, src/app/.well-known/oauth-protected-resource, content/docs/self-hosting/mcp.mdx, e2e/keycloak/riffado-e2e-realm.json]
supersedes: []
superseded-by: [2026-10-11-claude-connector-through-sso-realm, 2026-10-14-identity-provider-authorization]
relates: [2026-10-06-oidc-single-sign-on, 2026-10-20-mail-search-respects-visibility, 2026-10-18-inbound-mail, 2026-10-22-assignee-task-list]
---

# External MCP server in the app, gated by Keycloak client roles from the SSO realm

`/api/mcp` is a stateless Streamable HTTP MCP server inside the Next.js app (the official MCP TypeScript SDK
plus `jose`), off unless `MCP_AUDIENCE` is set and single sign-on is configured. A caller presents a
Keycloak access token from the SSO realm; the client roles in `resource_access[MCP_AUDIENCE].roles`
(`knowledge:read`, `transcripts:read`, `summaries:read`, `tasks:read`, `tasks:write`) choose which
tools are listed and callable. Roles only narrow what Chatterbox already shows the caller. Reads
cover the Almanac, transcripts, summaries and tasks; the only write is a task's status or assignee
through the existing `updateTask` rules.

**Superseded in part:** the per-IP limit before token validation was removed
([Claude connector](2026-10-11-claude-connector-through-sso-realm.md)), and the token rules (unknown
key id, allowed clients, MCP token type, service clients) changed with
[identity-provider authorization](2026-10-14-identity-provider-authorization.md). The rest still
holds.

## Why

The maintainer wanted outside consumers (people's AI clients, company automations) to use the
Organization's knowledge base, mishearings, aliases, transcripts, summaries and tasks, with access
per area decided in Keycloak and a tool list that follows the caller's claims. The existing
`/api/mcp/learn` server could not be reused: it is machine-to-machine with tokens Chatterbox mints
itself for one Learn run. The constraints:

- Recording titles, transcripts, summaries and task text are encrypted at rest, so there is no SQL
  text search.
- Transcript text is untrusted input to the consumer's model, so writes had to stay small,
  reversible, versioned and audited.
- An external role must never widen what a person sees in the app.

## Options considered

### Consumers: user-delegated tokens and service accounts (chosen)

- **People's AI clients only** (a token's `sub` maps to a user). **Service accounts only**
  (client credentials, Organization data only).
- **Both** was chosen: user tokens see own plus Organization data, service-account tokens act as the
  Organization account and see shared data only. More surface to test and audit, accepted.
- Later the maintainer ruled "only users who already have accounts". Dropping service callers was
  offered and declined: the rule means no auto-provisioning (a Keycloak user who never signed in to
  Chatterbox gets 403 "Sign in to Riffado once first"), and service accounts stay. Mapping a service
  account to a dedicated user account was also declined.

### Access: read plus task status and assignee writes (chosen)

- **Read-only v1** was recommended: with no write tools, a prompt injection in a recording cannot
  change data.
- **Write per area** (aliases, mishearings, facts, tasks).
  - **Rejected because:** largest surface, and knowledge edits would need Learn-style review or
    audit.
- The chosen middle keeps text, due dates, new tasks and `proposed` tasks UI-only; review stays
  human.

### How Keycloak expresses areas: client roles only (chosen)

- **OAuth scopes** in the `scope` claim.
  - **Rejected because:** a scope only shows what the client asked for, not that the user is
    allowed; it needs role mapping on top.
- **Roles and scopes both required by Chatterbox.**
  - **Rejected because:** two things to configure per area and two code paths. Per-connection
    narrowing stays possible in Keycloak (optional client scopes, Full scope allowed off) without
    code.
- **Custom claim or a configurable claim path.**
  - **Rejected because:** non-standard and set up per realm.
- Role names use the colon form (`tasks:write`) at the maintainer's request. Aliases and
  mishearings belong to `knowledge:read` rather than separate roles.

### Build: SDK route in the app (chosen)

- **Generalize the hand-rolled Learn handler.**
  - **Rejected because:** protocol compliance (version negotiation, metadata, output schemas) for
    third-party clients would be maintained by hand.
- **Separate service calling `/api/v1`.**
  - **Rejected because:** `/api/v1` would have to grow to every area, permission logic would be
    duplicated, and there would be a second auth hop.

### Search over encrypted data: filters plus bounded decrypt-scan (chosen)

- **Blind word index** (HMAC'd stems per recording).
  - **Rejected because:** it needs a migration and a backfill, and it leaks word frequency.
- **Semantic vectors** (pgvector).
  - **Rejected because:** embeddings of private text sit at rest, it depends on an embedding service
    being configured, and it is the most work.
- **Filters only.**
  - **Rejected because:** too weak for an AI client.

### References: names accepted wherever ids are (chosen)

- The maintainer asked that tools take a string as well as an id. Text resolves through Almanac
  matching (names, aliases, heard-as, stems) or, for recordings, the title. A clear match is used and
  echoed as `resolved`; ambiguity returns up to five candidates. Exact listing by type
  (`list_knowledge`) and a search tool per area were added on the same request.

### Issuer: always the SSO realm (chosen) or a separate `MCP_ISSUER_URL`

- **Keep `MCP_ISSUER_URL` and compare discovered issuers at runtime**, or **keep it with a docs
  warning**.
  - **Rejected because:** a second realm could mint a `sub` equal to a real user's and read that
    user's private data. One realm by construction removes the gap and a variable.

### Token exchange: standard (V2) only (chosen)

- **Legacy (V1) impersonation.**
  - **Rejected because:** a client could mint a token for any user without that user's token. The
    token would carry the victim's `sub`, so it would read the victim's private data and turn a
    service secret into an every-user key, with no login, MFA or consent, indistinguishable from a
    login except by `azp`.

### Client allowlist: optional `MCP_ALLOWED_CLIENTS` (chosen)

- **Required** (MCP refuses to start without a list). **Dropped** (rely on Keycloak alone).
  - **Rejected because:** the optional `azp` allowlist is cheap and the one Chatterbox-side control
    against a Keycloak misconfiguration; making it required forces every consumer to be registered
    twice.

## Decision

**Chosen: an SDK route in the app, Keycloak client roles in colon form from the SSO realm, user and
service callers, bounded decrypt-scan search, task status and assignee as the only write.** It
reuses the app's own access rules and Drizzle queries, so a role can only narrow existing
visibility. Revisit the search choice if transcripts stop being encrypted at rest or a blind index
becomes acceptable; revisit the single realm only if MCP must serve users who never sign in to the
app.

## Key technical details

- Entry points: `src/app/api/mcp/route.ts`; token checks `src/lib/mcp/token.ts` (`verifyMcpToken`:
  exact `iss` from discovery, `aud` containing `MCP_AUDIENCE`, RS256/PS256/ES256 only, `typ` must be
  `Bearer`); caller resolution `src/lib/mcp/caller.ts`; row scope `src/lib/mcp/scope.ts`; tool
  registry `src/lib/mcp/registry.ts` and `src/lib/mcp/tools/`; bounded scan `src/lib/mcp/scan.ts`;
  RFC 9728 metadata under `src/app/.well-known/oauth-protected-resource/`.
- The issuer comes from discovery, not the env URL, because Keycloak's frontend issuer can differ
  from the internal URL.
- Roles are enforced twice: `tools/list` filters, and `tools/call` answers "Unknown tool" for an
  unlisted one. Row filtering lives in the data functions, not the MCP layer.
- Cross-area fields: fact evidence (recording, quote, `startMs`) only with `transcripts:read`;
  summary action items only with `tasks:read`.
- Scan caps per call: 200 recordings for transcripts, 500 for summaries, 2,000 tasks, a 10-second
  deadline with `complete: false` and a `continue_before` cursor; 10 scans a minute per caller.
- `/api/mcp` skips `src/proxy.ts`, so its body is read only after the token passed; the route applies
  the admin-host gate itself.
- Every tool call writes one `mcp_access_log` row (ids only, no arguments or content), pruned by the
  hourly housekeeping job after `MCP_AUDIT_RETENTION_DAYS` (90). Migration 0094.
- A service-account client imported from JSON must list the `service_account` scope explicitly, or
  its tokens carry no `client_id`.

## Verification

- PR #98: full suite against Postgres 16, 3,275 passed before `main` was merged in.
- `src/tests/mcp/keycloak.integration.test.ts` (Keycloak 26.4): 7 tests covering audience and roles,
  a tool list narrowed to the tester client's roles, a user's own recordings, the service account's
  Organization-only view, a client outside `MCP_ALLOWED_CLIENTS`, and a tampered signature.
- `src/tests/mcp/registry.test.ts` fails if a tool lacks a role or a row filter; scope, token,
  resolve and scan behavior in the other files under `src/tests/mcp/`.

## Consequences & open follow-ups

- [Assignee task list](2026-10-22-assignee-task-list.md): The task-write restriction is partly replaced: text, due dates, own-task creation, notes, follows and merges now use the existing task permissions; proposal review remains app-only.
- The per-IP limit before token validation (120 a minute) was removed for Claude, whose users share
  a few Anthropic addresses; see
  [2026-10-11-claude-connector-through-sso-realm](2026-10-11-claude-connector-through-sso-realm.md).
- Later rules on top of this surface: a `mail:read` role and mail tools (inbound mail), MCP token
  type, `MCP_SERVICE_CLIENTS` and the refused web sign-in client
  ([2026-10-14-identity-provider-authorization](2026-10-14-identity-provider-authorization.md)), and
  mail search ([2026-10-20-mail-search-respects-visibility](2026-10-20-mail-search-respects-visibility.md)).
- Open at merge: Keycloak's V2 token exchange issues no refresh tokens unless switched on per
  client; which public MCP clients accept a pre-registered client id (answered for Claude by the
  connector work).
- Accepted trust assumption: realm administrators holding Keycloak's `impersonation` role can act as
  any user; Chatterbox cannot defend against that.

## Related work

- [2026-10-06-oidc-single-sign-on](2026-10-06-oidc-single-sign-on.md): the realm and the linked
  accounts this server trusts.
- [2026-10-11-claude-connector-through-sso-realm](2026-10-11-claude-connector-through-sso-realm.md):
  opens this server to hosted Claude and Claude Code, and supersedes its per-IP limit.
- [2026-10-20-mail-search-respects-visibility](2026-10-20-mail-search-respects-visibility.md):
  extends the bounded scan to mail.
- [2026-10-18-inbound-mail](2026-10-18-inbound-mail/README.md): mail tools and the `mail:read` role added to this server.
- [2026-10-14-identity-provider-authorization](2026-10-14-identity-provider-authorization.md): later changed MCP token rules (unknown key id, allowed clients); supersedes them.

## Timeline

- **2026-10-07**: design settled with the maintainer (consumers, writes, roles, build, search,
  callers, allowlist, single realm); implemented from a 22-task plan; PR #98 opened and merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
