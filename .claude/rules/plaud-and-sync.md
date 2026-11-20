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
  Set `PLAUD_REFRESH_TOKEN` to run the live refresh and device-list check.
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

- **User and refresh tokens.** Email-code login returns a 30-day user token (UT) and a 30-day
  refresh token. The current web app sets `pld_ut` (24 hours) and `pld_urt` (30 days). Connector
  0.2.4+ forwards both. Connector 0.2.3 and manual paste supply only the UT. Older tokens remain
  valid until their JWT `exp`.
- **Renewal.** `POST /auth/refresh-user-token` takes the refresh token as Bearer and returns a new
  pair without extending the original session. Older refresh tokens still work after rotation.
  Plaud returns HTTP 401 when it rejects the refresh token. Treat rate limits, 5xx and network
  errors as transient. OTP and refresh response expiry fields are Unix seconds.
- **UT vs WT.** Chatterbox stores the UT in `plaudConnections.bearerToken`. `PlaudClient` uses it to
  mint a short-lived workspace token (WT) at `/user-app/auth/workspace/token/<id>`. WT JWTs carry
  workspace claims such as `ut_ref`, `wid`, or `wtype`; UTs do not. When Plaud rejects a WT, try
  re-minting it before renewing the UT.
- **Manual paste.** Copy `pld_ut` in DevTools → Application → Cookies on `web.plaud.ai`.
  Requests such as `/device/list` and `/file/simple/web` carry a WT. It may pass initial
  validation, then fail once it expires. The connect-token route rejects pasted WTs.
- **Regional servers.** `api.plaud.ai` is global; accounts may live on `api-euc1.plaud.ai` (EU) or
  `api-apse1.plaud.ai` (APAC). `/auth/otp-send-code` returns `status: -302` with `data.domains.api`
  when the account is on a different region. `plaudSendCode` handles the redirect.
- **Rate limiting.** `PlaudClient` has built-in retry with backoff on 429 and 5xx
  (`src/lib/plaud/client.ts`). Respect `Retry-After`.
- **User and refresh tokens are encrypted at rest** in `plaudConnections.bearerToken` and
  `plaudConnections.refreshToken`. Decrypt for requests and for reading legacy JWT expiry claims.
  Never include token data or ciphertext in logs.
