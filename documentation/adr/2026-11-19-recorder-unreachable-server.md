---
title: The recorder preserves encrypted buffers when its server is unreachable
date: 2026-11-19
updated: 2026-11-19 14:53
status: accepted
kind: fix
issues: [420]
prs: []
areas: [extensions/recorder, src/app/api/v1/recorder, src/app/api/v1/recording-sessions]
supersedes: []
superseded-by: []
relates: [2026-10-21-meeting-recorder-extension]
---

# The recorder preserves encrypted buffers when its server is unreachable

The extension treats a failed HTTP request as the paired application's answer only when its JSON
body contains string `error` and `code` fields. Transport failures and foreign responses leave
capture, encrypted upload buffers and cached agendas recoverable.

## Why

A disconnected VPN can make a private recorder server silently drop connections. Proxies and
captive portals can also return their own HTTP pages. A recorder needs to preserve audio and the
last agenda while the user restores connectivity. It also needs to honor authorization failures
the application actually returns.

### Previous state

The extension applied the same HTTP status rules to responses from the application and other
servers. A proxy's 403 could block audio uploads. A proxy's 404 could clear a remembered folder.
Transport failures could also block startup recovery or replace a cached agenda with an error.

## Options considered

### Use the application error envelope and config endpoint

Existing servers already supply the envelope and the recorder config endpoint. The extension can
expose genuine authorization and quota errors immediately and schedule a config probe only while
there is an action or surface waiting. A reverse proxy response still leaves the cause ambiguous,
so the notice shows the observed HTTP status and the network or VPN troubleshooting steps.

### Classify by HTTP status and wait for the browser's online event

This would avoid a periodic probe. It was rejected because a proxy can reuse the application's
statuses, and a VPN can reconnect without changing the browser's online state.

## Decision

Use the envelope as the error contract and a Chrome alarm for automatic recovery. The browser also
probes on an explicit retry or an online event. Starting capture still requires a server-issued
recording key. This keeps the original encryption protocol and key ownership rules.

## Key technical details

- `extensions/recorder/lib/api.js` keeps `status` for application errors and records the HTTP
  status of a foreign answer separately. A caller abort stays a cancellation.
- `extensions/recorder/service-worker.js` tracks reachability per pairing in session storage. It
  uses a 30-second alarm and the released `GET /api/v1/recorder/config` route to resume work after
  a connection returns. Encrypted audio remains buffered until the server confirms completion.
- The panel renders its last loaded agenda read-only while offline. Background match and Calendar
  requests use their caches until recovery.

## Verification

- `src/tests/regressions/420-recorder-unreachable-server.test.js` covers 21 request and worker cases,
  including a silent timeout, proxy errors, interrupted capture, startup recovery and cache routing.
- `src/tests/recorder/error-envelope.test.ts` pins 401 and 429 replies for recorder config and session
  creation, plus a direct 404 error response. Panel and folder tests cover cache retention.
- Headless Chromium reached a local API stub, displayed the 30-second timeout and an HTML 403,
  then uploaded a buffered encrypted chunk and showed completion. Recovery passed through both
  **Retry now** and the scheduled alarm with the worker debugger detached.

## Consequences & open follow-ups

Self-hosted and hosted servers use the same extension behavior. The change uses the existing
permission and recorder endpoints, and it needs no schema or deployment changes.

## Related work

- [Meeting Recorder](2026-10-21-meeting-recorder-extension/README.md) establishes the server-issued
  key and encrypted browser buffer.

## Timeline

- **2026-11-19** — Decided and implemented connection recovery for issue #420.
