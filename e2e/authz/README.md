# Local sign-in and authorization testing

From the repository root, using Docker Compose:

```bash
docker compose -f docker-compose.local-authz.yml up -d --build --wait
```

Application: http://localhost:3310. Keycloak: http://localhost:8181.
The Keycloak admin console uses `admin` / `admin`; the application realm is
`chatterbox-local`. Use `localhost`, not `127.0.0.1`: redirect URIs and the issuer
use these exact addresses. Ports 3310 and 8181 must be available.
The initial build downloads dependencies and builds the application, which takes
several minutes. No host Node, Bun, or manual `.env` configuration is required.

| Application account | Password | Capabilities |
| --- | --- | --- |
| `john` (John Miller) | `john-password` | `use`, `access.manage` |
| `joe` (Joe Bennett) | `joe-password` | `use` |
| `jack` (Jack Wilson) | `jack-password` | `use`, `org.curate` |
| `emma` (Emma Davis) | `emma-password` | None; application sign-in is rejected |

This stack has its own PostgreSQL, storage, and Keycloak. The import creates
clients, groups, mappings, test users, and public test client secrets.
At startup the application applies existing database migrations and creates the
Organization account. Published ports bind to loopback only. The stack does not
connect to a corporate identity provider.

## Login button

The local stack defaults to the translated “Sign in with Keycloak” label.
Set `OIDC_PROVIDER_NAME` in `.env` to customize the provider name. The surrounding
text follows the application's language.

After updating the application code or configuration:

```bash
docker compose -f docker-compose.local-authz.yml up -d --build --wait app
```

The accounts above apply to a fresh import. An existing realm keeps its users
and passwords until the stack is reset (see below).

## What to verify

Use separate browser profiles for the administrator and the user being tested.

1. `joe` can use the application but cannot manage access.
2. `john` can open Settings → Access. This account is not automatically a curator.
3. Upload a recording as a user and share it with Organization. A curator can
   edit supported shared content, but cannot edit other users’ private recordings.
   Audio and AI providers are not preconfigured; configure them in the application
   to test generation.
4. Remove `org.curate` from the curator. Their next curator write is denied.
5. Remove `use` from a user. Their session and API keys are refused.
6. An administrator cannot remove their own `use` or `access.manage` capability.
7. After five minutes, changing access requires administrator reauthentication.

For this stack, authorization is reverified on use after 60 seconds and the
administrator authentication freshness limit is 300 seconds. Simulate an IdP outage:

```bash
docker compose -f docker-compose.local-authz.yml stop keycloak
# Protected requests return 503 once their authorization snapshot expires.
docker compose -f docker-compose.local-authz.yml start keycloak
```

New users created in this realm join the default `Users` group granting `use`.
MCP is enabled. The bot secret is `chatterbox-bot-local-secret`, with only the
scopes in the imported realm. Human MCP callers must first sign in through
the web application. Cloud clients cannot reach localhost; this setup does not
verify identity brokering or real external AI client connections.

## Personal API keys and the recorder

Personal keys belong to an application user. Create a key under Settings → API
Keys; its full value is returned only at creation. The server stores an HMAC hash.
Clients send it as `Authorization: Bearer <key>` to supported API endpoints.
Keys have their own scopes and optional expiration and can be revoked individually.

Pair the browser extension under Settings → Meeting Recorder. Pairing issues a
separate key with only `recordings:write`; a normal read-only key cannot upload
recordings. Logging out of the web application does not revoke these keys.

Every authenticated key request also checks its holder’s application access.
The read-only verifier refreshes stale authorization independently of web sign-in
(60 seconds in this stack; the application default is 30 minutes).
Removing `use` through application access management invalidates the holder’s
cached access immediately. Changes made directly in Keycloak are detected on
reverification. Revoked access returns 403; unavailable verification after the
snapshot expires returns 503. The recorder retains pending recordings for retry.

## Restart, logs, and reset

```bash
docker compose -f docker-compose.local-authz.yml logs -f app keycloak
docker compose -f docker-compose.local-authz.yml down
```

`down` preserves data. On the next `up`, Keycloak does not reimport an existing
realm: removed permissions and changed passwords remain unchanged.

A full reset **deletes the test database, recordings, and test realm changes**:

```bash
docker compose -f docker-compose.local-authz.yml down -v
docker compose -f docker-compose.local-authz.yml up -d --build --wait
```

`docker-compose.e2e.sso.yml` remains the fixture for the original SSO tests in
local authorization mode. This standalone stack enables `AUTHZ_MODE=idp` and
uses a separate Compose project and volumes.

## Static realm import

`keycloak/chatterbox-local-realm.json` is a complete Keycloak import, mounted
read-only into `/opt/keycloak/data/import`. No realm setup script or corporate
identity provider is required. All passwords, client secrets and application
keys in this stack are public, disposable test values. Never reuse them outside
this isolated local stack.

The example people and role assignments are fixed for reproducible tests.
Changing this JSON does not update an existing realm: Keycloak imports it only
when the realm is absent. Use the explicit reset above only for disposable data.

## Automated authorization tests

The integration tests import `src/tests/identity/fixtures/realm.json` into
separate temporary realms, create scenario-specific test users, and remove the
realms afterwards. The fixture enables password grants only for test clients.
Use a disposable local Keycloak and a disposable PostgreSQL instance; never
point these tests at a shared identity provider.

Set `KEYCLOAK_TEST_ISSUER` to a local Keycloak issuer URL and
`TEST_DATABASE_URL` to the local PostgreSQL admin URL, then run `pnpm test`.
`KEYCLOAK_TEST_ADMIN_PASSWORD` defaults to the public local password `admin`.
The example Compose uses a public hostname for browser sign-in; tests should
use a Keycloak configured with the same issuer address they reach from the host.
