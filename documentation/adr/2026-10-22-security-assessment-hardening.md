---
title: Hosted providers require public pinned targets, OTP is throttled, admin elevation follows its session, and responses carry security headers
date: 2026-10-22
updated: 2026-10-23 01:20
status: accepted
kind: fix
issues: []
prs: [263]
areas: [src/lib/net, src/lib/ai, src/lib/transcription, src/lib/learn/chat-clients.ts, src/lib/summary/summary-model.ts, src/lib/topics/generate-topics.ts, src/lib/webhooks, src/lib/rate-limit.ts, src/lib/env.ts, src/lib/errors.ts, src/lib/hosted/admin, src/app/(hosted)/api/admin/reauth, src/app/api/plaud/auth, src/app/api/settings/ai, src/app/api/folders, src/lib/folder-exports, src/proxy.ts, next.config.ts, docker-compose.yml, .env.example, content/docs/self-hosting]
supersedes: []
superseded-by: []
relates: [2026-10-07-external-mcp-server, 2026-09-13-native-transcription-adapters, 2026-10-06-export-ownership-ledger]
---

# Hosted providers require public pinned targets, OTP is throttled, admin elevation follows its session, and responses carry security headers

An external automated penetration test of a production deployment prompted a code review of
outbound URLs, OTP requests, admin elevation and cross-user routes. Hosted AI providers now share
the webhook public-target policy at save time and use DNS-pinned connections on every request.
Plaud OTP requests have database-backed limits. Admin elevation belongs to one session, and
operators can select exactly which proxy header supplies client IPs.
Responses now carry same-origin framing protection, `nosniff` and a referrer policy; HTTPS
deployments also send HSTS using the runtime `APP_URL`.

## Why

A signed-in user can still abuse shared Plaud egress or make a hosted server fetch private network
services. Authentication alone does not protect those boundaries. Self-host operators deliberately
use Ollama, LM Studio and other private endpoints, so applying hosted restrictions to all installs
would break the local-AI path. Multiple app processes require database-backed throttling.

### Previous state

Provider URL validation rejected only loopback addresses and did not resolve DNS. Native
Speechmatics and ElevenLabs adapters accepted a credential's base URL directly. Plaud's OTP routes
required a session but had no request limits. Admin elevation signed only the user and time.
IP limits preferred Cloudflare headers, real-IP, then the first forwarded-for entry; a proxy that
overwrites only one of these could leave another under client control.

The folder synchronization route queued work before checking folder ownership. Its worker scoped
reads to the caller, preventing cross-user data access, but the route still admitted unauthorized
jobs. Export creation refused a foreign folder with 400 rather than the standard 404.

There were no global security headers despite the assessment claiming otherwise. Pages could be
framed cross-origin, and Next advertised its framework. Mail attachments already had their own
restrictive CSP; mail HTML was returned as JSON and sanitized into a sandboxed `srcdoc` frame.

## Options considered

### Option A: validate provider URLs only when saving (declined)

- **Pros:** simpler clients and one DNS lookup per settings edit.
- **Cons:** saved hostnames can change their DNS answers before use; existing credentials bypass
  new save-time checks.
- **Rejected because:** a valid public answer at save time does not constrain the socket used
  later. DNS rebinding leaves internal services reachable. Revisit only if an enforced outbound
  proxy provides this same boundary for every provider call.

### Option B: save-time validation plus request-time resolution and pinning (chosen)

- **Pros:** rejects private DNS answers on every call and closes the check-to-connect gap.
- **Cons:** hosted calls perform DNS resolution and establish a fresh connection; the transport
  must preserve multipart uploads, streaming responses, decompression and cancellation.

### Apply the same restrictions to self-host (declined)

- **Pros:** one policy in every deployment.
- **Rejected because:** private provider hosts and Docker service names are intentional self-host
  functionality. Operator-configured instance URLs remain trusted in either mode.

## Decision

**Chosen: Option B in hosted mode only.** Shared hostname, address classification and pinned lookup
code lives in `src/lib/net/public-target.ts`. Webhook policy, HTTPS requirement, messages and delivery
semantics stay the same. AI requests use `src/lib/ai/provider-fetch.ts`, including every OpenAI SDK
client, the models probe, and every native adapter accepting a credential base URL. Gemini's native
adapter uses a fixed vendor endpoint and never reads a credential base URL. Instance embedding,
Reacher, OIDC, Keycloak and Mynah endpoints are operator configuration and remain unguarded.

## Key technical details

### Security headers

- `next.config.ts` applies `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` and
  `Referrer-Policy: strict-origin-when-cross-origin` to `/:path*`, including API and static paths,
  and disables `X-Powered-By` with `poweredByHeader: false`.
- **SAMEORIGIN and `frame-ancestors 'self'` are chosen over DENY and `'none'`.** The help drawer
  frames same-origin help pages; formatted mail uses a sandboxed `srcdoc` frame. Extension pairing
  uses tabs, content scripts and HTTP APIs; OAuth uses top-level redirects; Google Picker loads
  Google's UI into the app. None requires another origin to frame the app, so no origin is added.
- `src/proxy.ts` adds runtime headers through one helper on every returned response: ordinary
  `NextResponse.next()`, analytics and admin request-header overrides, hostname-gate redirects and
  404s. It sets `Content-Security-Policy: frame-ancestors 'self'` only outside `/api/`. The proxy
  never supplies a CSP for API paths, so route policies cannot be replaced or merged. Attachments
  retain exactly `default-src 'none'; sandbox`; the mail HTML JSON boundary and the document's
  restrictive CSP stay intact.
- **HSTS is `max-age=31536000` only when runtime `env.APP_URL` starts with `https://`.** No
  `includeSubDomains` or `preload`. A generic image cannot decide this at build time, and plain-HTTP
  self-host installations must remain usable. Forwarded scheme headers do not control this choice.
- **The proxy matcher remains unchanged.** HSTS is a host-wide browser policy cached from any
  HTTPS response; reaching page loads is sufficient. It need not reach uploads, MCP, mail ingest
  or static assets outside the matcher. Framing protection matters for documents: pages receive
  `frame-ancestors 'self'`, and the static `X-Frame-Options: SAMEORIGIN` covers all responses.
  Running the proxy on excluded request bodies would reintroduce buffering and its 10 MB limit,
  without adding meaningful policy coverage.
- **A full script CSP is deferred.** Next's inline scripts need per-request nonces, forcing
  dynamic rendering of every page. This change adds only the framing policy, so browser/local AI
  scripts and Google Picker retain their existing loading behavior.

### Provider, authentication and ownership boundaries

- Provider saves and probes await `validateAiBaseUrl`. Hosted checks all DNS answers, rejecting
  private, link-local, metadata, loopback, IPv4-mapped private addresses and local hostname suffixes.
- Hosted provider HTTP uses Node HTTP/HTTPS with the shared pinned lookup and no socket reuse.
  Original hostname, Host header and TLS server name remain intact. Redirects are refused.
  Self-host delegates directly to native fetch with the original input and options.
- Hosted multipart bodies use `src/lib/ai/provider-multipart.ts` before constructing `Request`:
  Bun eagerly materializes `FormData` there. The encoder streams file bodies, escapes field and
  file names, normalizes text newlines and computes Content-Length without buffering the upload.
- Plaud send-code: **5 per user per 10 minutes**, plus **3 per trimmed, lower-cased target email
  per 10 minutes** across users. Verify: **10 per user per 10 minutes**. Email syntax is validated
  before Plaud. Bucket keys are HMACed by the existing store. Refusals use `RATE_LIMITED`, 429 and
  `Retry-After` through `AppError`/`apiHandler`. The connect UI already toasts the readable error.
- `RATE_LIMIT_CLIENT_IP_HEADER` is optional. With proxy trust enabled, rate limits read only that
  header; the admin allowlist also uses it. Selected XFF uses its **last** entry, including treating
  an empty final entry as missing. No fallback when set. Unset preserves each consumer's previous
  precedence; proxy trust remains off by default for rate limiting.
- The admin cookie signs user id, **session row id** and issued-at, parsed with one split. It never
  contains a session token. Another session of the same user requires reauth for pages and is
  refused for API reads and mutations. Old elevation cookies require one new password confirmation.
- Folder synchronization now awaits the exportable-folder ownership check before enqueueing.
  Export creation and listing both return 404 for another user's private folder. Erasure keeps
  its existing awaited access check before every side effect.

## Rejected

| Finding or proposed change | Rejected because | Revisit if |
| --- | --- | --- |
| Global `ServerResponse.prototype.writeHead` hook for runtime headers | A process-wide prototype patch depends on Bun's implicit-header behavior; a fault breaks every response in the app. It buys coverage of proxy-excluded routes and assets that HSTS and document framing protection do not need. | A required policy cannot be enforced at the framework boundary and the runtime provides a supported response hook. |
| AUTH-VULN-01: force Secure on every session cookie | Better Auth's `createCookieGetter` derives Secure and the `__Secure-` prefix from HTTPS `APP_URL`. Forcing Secure breaks sign-in on plain-HTTP self-host installations. | The supported deployment contract requires HTTPS everywhere. |
| AUTH-VULN-02: fail closed when the bucket store fails | Sign-in cannot read password hashes or persist sessions while its database is down, so there is no database-outage brute-force window. Failing closed would take every rate-limited route down with the bucket store. | Authentication and throttling use independent stores and the availability trade-off changes. |
| SSRF-VULN-01: restrict instance embeddings | `EMBEDDING_BASE_URL` is operator configuration, not user input. The operator already controls server egress. | Users can configure this endpoint. |
| SSRF-VULN-02: restrict Reacher | `REACHER_API_URL` is operator configuration, not user input. | Users can configure this endpoint. |
| SSRF-VULN-04: restrict OIDC discovery | `OIDC_ISSUER_URL` is trusted operator configuration for the deployment's identity provider. | Users can choose an issuer. |
| SSRF-VULN-06: restrict Keycloak | Its endpoint is operator configuration; the provider's delegated authorization boundary is separate. | Users can choose the administrative endpoint. |
| SSRF-VULN-05: replace webhook DNS pinning | Delivery already re-resolves and checks all answers using `resolveWebhookUrl`, pins the socket to those addresses, and does not follow redirects. This is the rebinding defense. | Another delivery path bypasses these checks. |
| AUTHZ-VULN-01: add a GET-by-id folder handler | The route has no GET handler; Next.js returns 405 without reading a folder. The existing folder list is scoped. Adding an endpoint would add functionality rather than fix a disclosure. | A GET-by-id endpoint is introduced intentionally. |
| AUTHZ-VULN-02 and AUTHZ-VULN-03: replace folder mutation guards | Rename, move and delete await ownership checks before writes; cross-user integration tests return 404 with unchanged rows. | A new mutation bypasses the shared guards. |
| AUTHZ-VULN-04 and AUTHZ-VULN-05: replace export ownership queries | Queries already filter folders by caller. Creation's error was normalized to 404, with no new access granted. | New providers bypass the shared ownership check. |
| AUTHZ-VULN-06: rely only on worker ownership checks | Rejected as sufficient route protection: a foreign folder could enqueue a job. Fixed by checking ownership before enqueueing; no cross-user data disclosure was found. | Every queue entry is authorized centrally before insertion. |
| AUTHZ-VULN-07: replace recording erasure authorization | The route awaits `requireRecordingView` before side effects. Tests cover every erase scope and assert no action or data change. | Another erase path bypasses that guard. |
| SSRF-VULN-03: classify Speechmatics as operator-only configuration | Rejected: this base URL is user-configured. Covered by the hosted provider guard on submission, polling, transcript fetch and deletion. | The adapter stops accepting credential URLs. |
| XSS and injection changes | No findings were reported; no targeted change was justified by this review. | Concrete evidence identifies an affected path. |

## Verification

- `src/tests/regressions/pentest-security-headers.test.ts`: **25 tests** call the proxy directly
  and invoke both mail handlers with mocked authorization/storage. They cover runtime HTTPS versus
  HTTP/unset `APP_URL`, forwarded-scheme independence, page-only framing CSP, every proxy return
  branch, hostname-gate redirects/404s under HTTP and HTTPS configuration, preserved analytics/admin
  request headers, static policies and disabled `X-Powered-By`, and unchanged mail JSON/CSP.
  The focused header, proxy-matcher and mail-document run passed **39 tests in 3 files** under
  Node **22.22.2**. The hook-only HTTP server and standalone Bun/browser harnesses were removed
  with the hook.

- `src/tests/regressions/pentest-cross-user-folders.integration.test.ts`: **14 tests** against
  disposable PostgreSQL databases, including the owner's positive path, foreign folder mutations,
  export reads/creation, synchronization with no queued job and six erasure scopes with no effect.
- `src/tests/regressions/pentest-plaud-otp-rate-limit.test.ts`: **9 tests**, including cross-user
  target normalization, window expiry, 429/Retry-After, malformed email and verify limits.
- All six new suites and the modified admin, URL-policy and export suites passed: **257 tests in
  14 files**, including three existing AI/summary suites after declaring their self-host deployment
  fixture.
- The named provider, webhook, admin, rate-limit, Plaud, transcription and folder suites passed
  under Node **22.22.2**: **914 passed, 41 skipped**, across **79 files**. Live Keycloak and Plaud
  checks remain opt-in and were unavailable; one optional compression case was also skipped.
- The full affected-test run passed under Node **22.22.2**: **4,439 passed, 87 skipped** across
  **406 files** after moving the runtime security headers into the proxy, with **zero failures**
  in **1,657.65 seconds**. Skips require live Keycloak/Plaud access,
  ffmpeg, or the optional mail-search benchmark flag.
- Bun **1.4.0** streamed **64, 256 and 512 MiB in each direction** through the real provider
  transport and a local HTTP server. Exact byte counts and the original Host header were asserted.
  Raw-stream peak RSS was approximately **108, 124 and 134 MiB**, respectively.
- The first **512 MiB multipart** trial reached **1,193,560 KiB RSS** with native Request/FormData
  serialization. After streaming the multipart encoder, **64, 256 and 512 MiB file uploads** peaked
  at **119,040, 141,204 and 133,908 KiB RSS**, respectively, while also downloading the same
  payload sizes. The file fixture was backed by a local sparse file, with 64 KiB response chunks.
  Policy resolution was replaced to admit loopback fixtures; the real pinned lookup and socket
  transport were exercised. Public-target rejection is covered separately by the Node suites.
- A local HTTPS fixture under Bun **1.4.0** also passed with a trusted test certificate, verifying
  the original Host header and TLS SNI hostname while connecting through the pinned lookup.

## Consequences & open follow-ups

- Cross-origin framing is now refused in both deployment modes. Same-origin help and mail remain
  supported. Operators need not add these headers at the reverse proxy; English and Czech proxy
  documentation says so. Existing installations require no configuration changes for the headers.
- HSTS is cached by browsers for one year on HTTPS deployments; rollback cannot immediately clear
  a policy already received. Plain-HTTP self-host installations receive no HSTS. A framing-policy
  regression affects embedded help/mail in either mode; correcting the policy restores those
  panes on reload. Future Next upgrades must retain proxy response and route-owned CSP coverage.

- Hosted credentials previously pointing to private services now fail; choose a public endpoint or
  self-host. No schema change is required. Public services that redirect must be configured using
  their final endpoint.
- **Upgrading an existing installation:** none required for self-host. Optionally forward and set
  `RATE_LIMIT_CLIENT_IP_HEADER` to the header the trusted proxy controls. The bundled Compose file
  passes it through along with the existing proxy-trust switch. Rollback leaves no schema changes;
  hosted administrators reauthenticate after the cookie format changes.
- A wrong hosted target classification affects provider work for users of that endpoint; selecting
  a valid public endpoint recovers immediately. Self-host provider routing stays unchanged.
  OTP throttling affects only the sender and target buckets until the ten-minute window resets.
  A wrong optional IP-header choice changes rate-limit identity and can refuse admin allowlist
  access; correcting or unsetting it restores prior behavior in both modes.

## Related work

- [External MCP server](2026-10-07-external-mcp-server.md): existing caller limits share the
  client-IP primitive; instance-controlled discovery remains outside the user-URL policy.
- [Native transcription adapters](2026-09-13-native-transcription-adapters.md): every native
  adapter that accepts a credential URL must use the same guarded transport as SDK clients.
- [Export ownership ledger](2026-10-06-export-ownership-ledger.md): worker scoping remains, with
  route authorization now preceding synchronization enqueueing.

## Timeline

- **2026-10-22**: review decisions accepted; hardening and regression coverage implemented in a
  feature worktree without committing or deploying.
