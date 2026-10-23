---
title: Claude and Claude Code reach MCP through the SSO realm, with a confidential client and a narrow public entrance
date: 2026-10-11
updated: 2026-10-22 22:30
status: accepted
kind: feature
issues: []
prs: [109]
areas: [src/lib/mcp/ingress.ts, src/lib/mcp/token.ts, src/lib/mcp/metadata.ts, src/lib/mcp/config.ts, src/lib/mcp/rate-limit.ts, content/docs/self-hosting/claude.mdx, e2e/keycloak/riffado-e2e-realm.json, docker-compose.e2e.sso-resource-indicators.yml]
supersedes: [2026-10-07-external-mcp-server]
superseded-by: []
relates: []
---

# Claude and Claude Code reach MCP through the SSO realm, with a confidential client and a narrow public entrance

People connect hosted Claude (web, Desktop, mobile, Cowork) and Claude Code to the external MCP
server and sign in on the organization's Keycloak page. Keycloak stays the authorization server and
Chatterbox stays a resource server. Hosted Claude uses a confidential Keycloak client whose secret
only the Claude organization's connector holds; Claude Code uses a public client accepted only on the
internal route. Because hosted Claude reaches connectors from Anthropic's cloud, an internal
Chatterbox gets a narrow public entrance (two exact paths), and listed clients can be required to
send a connector key.

## Why

The MCP server ([2026-10-07-external-mcp-server](2026-10-07-external-mcp-server.md)) worked for
clients inside the network, but Connect failed for Claude: it asked Keycloak for every scope the
realm advertised and got `invalid_scope`. Making it work meant exposing Organization recordings and
knowledge to requests from Anthropic's cloud, where three facts shape everything:

- Every hosted Claude user and Anthropic's API MCP connector egress from the same published address
  range, so an IP allowlist narrows traffic but never proves who calls.
- Keycloak 26.6 ignores the RFC 8707 `resource` parameter unless an experimental feature is on, so a
  token issued to a client is valid for Chatterbox whatever MCP server Claude was talking to.
- A Claude account's connector token is shared by its web, Desktop, mobile and Cowork apps; person
  (`sub`) plus application (`azp`) is the real granularity.

## Options considered

### Option A: Keycloak stays the authorization server (chosen)

Claude talks to Keycloak directly; Chatterbox verifies tokens as before and gains a public entrance
for the MCP path only. Roles are recomputed by Keycloak on every refresh.

### Option B: Chatterbox becomes the authorization server and brokers login to Keycloak (declined)

The maintainer's first idea: Chatterbox serves authorization-server metadata, `/authorize`,
`/token`, client registration and revocation, sends the browser through the existing Keycloak login
and mints its own tokens.

- **Pros:** Keycloak's endpoints never need to be reachable from Anthropic.
- **Cons:** a full OAuth server to secure (codes, PKCE, redirect validation, refresh rotation,
  metadata fetching), and Chatterbox would have to keep re-checking the person's Keycloak roles
  itself.
- **Rejected because:** its only advantage was keeping Keycloak private, and the organization's
  realm turned out to be public already. Revisit if a deployment's Keycloak must stay unreachable
  from the internet, or if MCP is ever wanted in hosted mode, which has no SSO realm to act as the
  authorization server.

### Variants that keep Keycloak private (declined)

- **A metadata shim:** Chatterbox serves the authorization-server metadata while Keycloak issues
  codes and tokens. **Rejected because:** Keycloak's authorization response carries its own `iss`,
  which MCP clients must match against the issuer in the metadata (RFC 9207), and RFC 8414 requires
  the issuer to equal the URL the metadata came from. The only facade known to work replaces the
  issuer entirely, which is Option B.
- **A second, internet-facing Keycloak brokering to the internal realm.** **Rejected because:** role
  and disable changes would reach the brokering realm only at the person's next interactive login,
  not on refresh, so rights would go stale for the life of a 30-day offline session. This was
  believed from how Keycloak brokering works, not verified.

### Reaching an internal Chatterbox without a public entrance (declined)

- **A desktop extension or local MCP server on an employee's machine.** **Rejected because:** Cowork
  sessions run in Anthropic's cloud, which does not run local MCP servers; an extension would also
  not serve the web or mobile apps and would depend on one machine being online. Whether a cloud
  session can call a desktop extension at all was believed, not verified.
- **A per-user outbound tunnel from a machine on the VPN.** **Rejected because:** it would publish
  Chatterbox under a hostname nobody controls, one per user, which is wider than one proxy
  restricted to two paths.
- **Anthropic's MCP tunnels.** **Rejected because:** they need the Enterprise plan (a research
  preview at the time), which the organization the connector was built for did not have. Revisit on
  an Enterprise plan.

### Option C: Enterprise Managed Auth (ID-JAG) (deferred)

- **Rejected because:** it depends on the Claude plan and on the identity provider; "later, if
  ever".

### How Claude identifies itself to Keycloak

- **Dynamic client registration.**
  - **Rejected because:** client sprawl, full-scope clients, and `MCP_ALLOWED_CLIENTS` cannot list
    clients that register themselves. Anonymous registration stays refused in the realm.
- **Claude's client metadata document (CIMD).**
  - **Rejected because:** Keycloak offers it only behind an experimental flag.
- **A public pre-registered client `claude`** (the first plan).
  - **Rejected because:** the adversarial review showed that a public client id is just a name. An
    attacker's MCP server can publish metadata naming the organization's realm and client `claude`;
    after an employee signs in on the genuine page, Claude sends the token to the attacker, who
    replays it to Chatterbox through Anthropic's API connector from the same address range. It would
    also admit every Claude account, free ones included.
- **Chosen:** a confidential client `claude`, its secret entered once by the Claude organization's
  Owner. Only that connector can exchange the login code, so `azp: claude` means "our Team's
  Claude". Personal Max users each get their own confidential client named after them, so `azp`
  still names the application owner. Claude Code cannot keep a secret on a laptop, so its public
  client `claude-code` is served only on the internal route.

### Rate limiting: identity-keyed only (chosen)

- **Keep the per-IP limit before the token check.**
  - **Rejected because:** every Claude user shares a few Anthropic addresses, so one user would
    throttle all.
- **Exempt Anthropic's range from the per-IP limit.**
  - **Rejected because:** client IP detection trusts forwarded headers that an internal client can
    spoof, under one global flag that also drives `/api/v1` and the auth limits. Volume limits
    belong at the proxy; the per-caller limit (`sub` plus client) and the search limit stay.

### Resource indicators: accept the URL audience "also" (chosen) or "only"

- **"Only"** (require `aud` to be the MCP URL once the Keycloak feature is on).
  - **Rejected because:** on Keycloak 26.6.4 the first token has the URL audience, but a refreshed
    one is back to the client audience. `MCP_RESOURCE_AUDIENCE=true` therefore accepts the URL
    audience in addition.

### Other rulings (maintainer)

Personal Claude accounts are acceptable when SSO admits the person; Claude Code is wanted; offline
sessions use Keycloak's default (30 days without use); no per-app role narrowing (both clients may
carry all MCP roles, the user's roles decide); a consent screen is UX only, not a control; MCP for
hosted mode is not wanted; the connector request header is used.

## Decision

**Chosen: Option A with a confidential hosted client, a public Claude Code client served only
internally, a path-restricted public entrance, optional connector keys and optional resource
audience.** Keeping Keycloak as the authorization server avoids building and securing an OAuth
server; the confidential client is what binds a token to the organization's own connector, since
Keycloak does not bind tokens to the MCP server's URL by default.

## Key technical details

- `src/lib/mcp/metadata.ts`: the 401 challenge and the protected-resource metadata name
  `scope="openid"`; `error="invalid_token"` only when a token was sent. Without the scope, Claude
  requests every realm scope and Keycloak refuses.
- `src/lib/mcp/token.ts`: `verifyMcpToken` returns `valid`, `other-audience` or `invalid`. A genuine
  realm token for another audience (a person without MCP roles gets no `aud`) answers 403 "This
  token carries no Riffado MCP role", because a 401 would loop Claude through sign-in.
- `src/lib/mcp/ingress.ts`: `MCP_PUBLIC_INGRESS_HEADER` (set by the public proxy, overwritten there
  and stripped internally) plus `MCP_PUBLIC_CLIENTS`; any other client's token arriving through the
  public entrance is refused. The proxy must pass exactly `/api/mcp` and
  `/.well-known/oauth-protected-resource/api/mcp`, never a prefix, because `/api/mcp/learn` must stay
  internal.
- `MCP_CONNECTOR_KEYS` (`client=key` pairs, keys of at least 32 characters) requires `X-API-Key` for
  a listed client on any entrance, compared in constant time.
- Refusals log `[mcp] refused (<reason>) a token of client <azp>`, since Claude does not show 403
  bodies; `mcpConfigWarnings` (`src/lib/mcp/config.ts`) warns at startup about an empty
  `MCP_ALLOWED_CLIENTS` and about public or keyed clients the allowlist does not list.
- Keycloak facts verified on 26.6.4: users need the `offline_access` realm role or Keycloak refuses
  offline tokens; a missing or wrong secret answers `401 unauthorized_client`; loopback redirects
  match any port; with resource indicators on, a foreign `resource` gets `invalid_target`, and a user
  without MCP roles gets a 500.
- Realm "Revoke Refresh Token" stays off: the realm is shared with many other applications and
  rotation races would sign people out.

## Verification

- PR #109: full `vitest run` with Postgres, 3,388 passed (nine integration files hit cleanup
  timeouts under load and passed when rerun alone: 48 tests).
- `src/tests/mcp/keycloak.integration.test.ts` replays Claude's sign-in (code plus PKCE S256,
  `openid offline_access`, `resource`, client secret, refresh): 15 of 15 on the plain realm, 14 plus
  1 skipped with resource indicators. It checks the exact `aud`, an offline refresh token, a code
  that cannot be redeemed without the secret, `invalid_target`, a removed role vanishing on refresh,
  403 for a person without roles, Claude Code on any loopback port served inside only, and the
  connector key.
- Unit tests: `src/tests/mcp/ingress.test.ts`, `metadata.test.ts`, `config.test.ts`,
  `rate-limit.test.ts`, `token.test.ts`.
- The e2e Keycloak moved from 26.4.0 to 26.6.4; the realm gained `claude` and `claude-code`.

## Consequences & open follow-ups

- Disabling a user or removing a role takes effect at the next token refresh, within one
  access-token lifetime (10 to 15 minutes). `tasks:write` is the only write while Cowork acts
  autonomously on untrusted transcript text; the maintainer chose no narrowing.
- Claude caches the tool list until reconnect; a removed tool answers "Unknown tool".
- Open at merge: whether Claude sends the request header on every call, and whether the Owner dialog
  offers request headers (a beta); Keycloak console paths in the docs unchecked against a live 26.6
  console.
- Rotating the hosted client's secret means re-adding the connector.

## Related work

- [2026-10-07-external-mcp-server](2026-10-07-external-mcp-server.md): the server this opens to
  Claude; its per-IP limit was removed here, so this record supersedes that rule.

## Timeline

- **2026-10-09**: brief, advisor pass, adversarial review and proposal; Option B dropped once the
  realm was found public; the hosted client made confidential; PR #109 opened.
- **2026-10-11**: PR #109 merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
