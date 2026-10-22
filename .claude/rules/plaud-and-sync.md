---
paths:
  - "src/lib/plaud/**"
  - "src/lib/sync/**"
  - "src/app/api/plaud/**"
  - "src/app/api/dev/plaud/**"
  - "src/components/plaud-connect-tabs.tsx"
---

# Plaud API and sync

## Before shipping

- **Test sync against a real Plaud account** before shipping anything touching `src/lib/sync/` or
  `src/lib/plaud/`. Sync regressions destroy user trust fastest. The live client test is opt-in:
  `PLAUD_BEARER_TOKEN=... pnpm vitest run src/tests/plaud.integration.test.ts`.
- Dev diagnostics endpoint: `/api/dev/plaud/info` (dev-only, hidden in production) probes the
  stored Plaud connection and reports device and recording counts. Useful for "is the connection
  actually working" without digging into the DB.
- Sync is pull-based (Plaud has no push); the sync worker (`src/lib/sync/sync-recordings.ts`) stays
  idempotent and paginated.
- Client components that fetch from our own API use existing `/api/...` routes; no duplicate
  client-side Plaud API calls.

## Plaud API gotchas

Non-obvious facts about Plaud's server. Issue numbers below refer to upstream
`riffado/riffado`, not this repository.

- **No refresh tokens.** The OTP login flow returns only `access_token`, a long-lived JWT (~300 day
  expiry observed). Do not re-add refresh-token plumbing; it was removed upstream (commit `0d31b39b`,
  migration `0014_drop_plaud_refresh_token.sql`). When access tokens expire, users re-auth via the
  reconnect UI.
- **Two token types: UT vs WT.** Plaud issues a long-lived **user token (UT, ~300 days)** and
  short-lived **workspace tokens (WT, ~24h)**. The UT is what Chatterbox stores in
  `plaudConnections.bearerToken`; `PlaudClient` mints a fresh WT from it per request
  (`/user-app/auth/workspace/token/<id>`, `src/lib/plaud/workspace.ts`). Tell them apart by JWT
  claims: a WT carries `ut_ref`/`wid`/`wtype` (and a ~24h lifetime); a UT does not. This holds for
  SSO (Google/Apple) accounts too, verified via HAR (riffado/riffado#203).
- **Gotcha:** web.plaud.ai puts the WT on the data requests users inspect (`/device/list`,
  `/file/simple/web`) and the UT in `localStorage.pld_tokenstr` plus identity endpoints
  (`/user/me`, `/team-app/workspaces/list`), so paste-flow users grab the WT by mistake. A pasted WT
  validates against `/device/list` (connect *looks* fine) but cannot mint a fresh WT, so the
  connection dies within a day. `isPlaudWorkspaceToken()` (`src/lib/plaud/auth.ts`) guards the
  connect-token and verify routes against this. Paste instructions recommend the connector first,
  then `pld_tokenstr` if the user insists on manual paste; never point users at `/device/list` or
  `/file/simple/web`.
- **Regional servers.** `api.plaud.ai` is global; accounts may live on `api-euc1.plaud.ai` (EU) or
  `api-apse1.plaud.ai` (APAC). `/auth/otp-send-code` returns `status: -302` with `data.domains.api`
  when the account is on a different region. `plaudSendCode` handles the redirect.
- **Rate limiting.** `PlaudClient` has built-in retry with backoff on 429 and 5xx
  (`src/lib/plaud/client.ts`). Respect `Retry-After`.
- **Bearer tokens are encrypted at rest** in `plaudConnections.bearerToken` (`AGENTS.md`,
  Encryption at rest). Decrypt only when constructing the HTTP request.
