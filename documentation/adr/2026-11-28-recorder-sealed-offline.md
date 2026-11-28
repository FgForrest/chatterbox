---
title: The recorder starts offline by sealing audio to a per-user server key
date: 2026-11-28
updated: 2026-11-28 20:13
status: accepted
kind: feature
issues: [463]
prs: []
areas: [extensions/recorder, src/app/api/v1/recorder/config, src/app/api/v1/recording-sessions, src/lib/recording-sessions, src/db/schema.ts]
supersedes: [2026-11-19-recorder-unreachable-server, 2026-11-20-recorder-meeting-card-is-a-notice, 2026-10-21-meeting-recorder-extension]
superseded-by: []
relates: []
---

# The recorder starts offline by sealing audio to a per-user server key

After pairing with a supporting Chatterbox server and caching the account's public key, the
recorder can start and stop while that server is unreachable. The usual Start control works
through the outage. The browser seals audio from the first chunk and holds it until the server
confirms completion or the user discards it.

## Why

A VPN or server outage can prevent Start while the meeting itself is available. The recording
has to survive both that outage and a browser restart without storing readable audio or the
material to decrypt it in the browser profile.

### Previous state

Protocol 1 creates a server session first and uses its per-recording key to encrypt the buffer.
It can continue a capture and defer upload if the server disappears mid-meeting. Without that
initial answer the recorder cannot start, so the meeting card shows the participant notice and
connection guidance.

## Options considered

### Seal to the account's server key

The cached public key lets each capture use one encryption key from its first chunk through
upload. The server and extension both need protocol 2, and offline Start requires successful
configuration at least once.

### Store plaintext in the browser's private file system (OPFS)

This works with released servers by encrypting the buffered prefix on upload.

**Rejected because** a copied profile exposes the audio and the plaintext buffer conflicts with
the recorder's encryption-at-rest requirement.

### Store an encryption key in the browser profile

This also avoids a server change and encrypts audio before it reaches OPFS.

**Rejected because** the same profile contains both the ciphertext and the means to decrypt it.

### Hold the first chunks in memory while deciding which key to use

Trying protocol 1 first could preserve the existing online flow and use sealing after a timeout.

**Rejected because** review found that a capture-host crash loses the start of the recording,
and a timed-out protocol 1 create can still commit a session. The timeout cannot tell the client
whether a fallback would leave an open session or collide with the committed capture ID.

### Add an explicit offline Start button

A separate button would let users choose a path in advance.

**Rejected because** the maintainer overruled a second start control and required the usual Start
to handle outages automatically.

## Decision

Use per-user sealing for every capture on a capable pairing, online or offline. The maintainer
chose automatic offline operation, local retention until confirmed upload or explicit Discard,
and keeping refused audio in the browser with Retry and Discard. Release protocol 2 on the server
and in the extension together. Both self-hosted and hosted servers use it with their existing
recording permissions, limits and entitlement checks. The schema additions require no new
environment variable or Compose setting.

## Key technical details

- **Protocol at Start.** Choose once, before any protocol-specific work, and keep the choice
  through permission prompts, capture, upload and recovery. Config advertises
  `features.offlineRecording: 1` and a validated public key cached for the server origin and
  account. A reachable server that stops advertising the feature selects protocol 1 for new
  captures. A `404` or `405` from sealed create means waiting for a fresh config answer. Existing
  sealed audio keeps its protocol and key. Protocol 1 captures can still buffer and stop during
  an outage.
- **Sealing and session creation.** Start keeps the consent, microphone and source checks and
  uses local folder and agenda snapshots. The host persists the public sealing descriptor before
  writing audio and uses P-256 ECDH and HKDF-SHA256 to derive the AES-256-GCM key. The extension
  can call `/api/v1/recording-sessions/sealed` in parallel with capture and retry idempotently with
  the same descriptor and capture ID. The server resolves the key ID within the authenticated
  user and checks recorder credential ownership on session operations. The client attaches or
  uploads only after create or recovery echoes protocol 2 and the same key ID. Reconnection
  uploads the buffered chunks in order. Complete replays the stored stop time and upload boundary.
- **Server and browser retention.** The sweeper can clear an open server session after 24 hours
  of inactivity. The sealed path replaces it and replays from the browser, deriving the original
  capture key again after expiry as long as the user's recipient key is available. A retired
  recipient key still decrypts existing buffers. Protocol 1 keeps its 30-day key lifetime from
  the last accepted chunk, or from creation before any chunk is accepted. The browser has no
  automatic expiry, even after refusal or a pairing change. A buffer can upload only to its
  original server origin and account. A gap in a migrated buffer requires explicit confirmation
  before saving just the playable prefix.
- **Discard.** Before Complete is dispatched, sealed Discard removes audio locally, fences new
  chunk uploads and aborts any in-flight PUT. A metadata-only tombstone can resolve an ambiguous
  create and cancel the current session, including a replacement, without sending audio or folder,
  agenda or room metadata. Each cleanup attempt has a 3-second network budget and keeps its progress
  for retry. Rollback parks cleanup. A permanent `403 RECORDER_KEY_MISMATCH` retires the tombstone.
  If Complete may already have been dispatched, preserve audio while cancellation is unconfirmed
  and report if the server already saved the recording.
- **Limits.** The host stops at the cached session byte limit (500 MiB by default) or 10,000
  chunks. The server still enforces the 8 MiB chunk cap and its storage quota. The browser requests
  persistent storage and warns when estimated free space falls below about one hour of audio.
  An OPFS write failure interrupts the capture and keeps the verified prefix.

## Verification

`src/tests/recorder/offline-recording-worker.test.js` covers protocol selection, rollback, durable
Stop and Discard races. `src/tests/recording-sessions/sealed-vectors.test.ts` checks browser and
server key derivation and chunk authentication. Chrome for Testing exercised offline Start and
Stop, reconnect during capture and worker restart against a stub that independently decrypted the
upload. The final review fixes passed 274 focused tests and 3,298 scoped tests on Node 22, with
1,302 skips in the scoped run. `src/tests/recording-sessions/sealed-and-leases.integration.test.ts`
covers sealed create replay, recovery after key expiry and Discard against PostgreSQL, and the
Keycloak recorder suite covers sealed create under withdrawn access.

## Consequences & open follow-ups

- Finalized recordings follow ordinary backup and restore. Application archives exclude offline
  recipient keys and browser buffers. A restore from an older backup that lacks the original
  recipient key refuses the pending sealed audio, which stays in the browser.
- #422 still tracks the sweeper claim race, the Complete route's gap between changing session
  state and enqueueing finalization, credential rebind for already-attached sessions, and the
  agenda draft and link races during Stop or agenda switching.
- Verify real Teams and Webex invite-to-in-call URL fixtures for the companion room detection
  before accepting alternate URL forms.
- Check the English and Czech privacy notices, in-extension consent and Store data-use copy
  together at release for sealed buffering, local retention and server-side decryption. The
  privacy notices also disclose that Discard can send a cancellation request without audio.
  [English privacy notice](../../extensions/recorder/PRIVACY.md), [Czech privacy notice](../../extensions/recorder/PRIVACY.cs.md), [Store submission text](../../extensions/recorder/store/STORE_SUBMISSION.md)

## Related work

- The server-issued key requirement at Start and the server-first Discard rule are superseded
  for sealed captures. The application error envelope and reconnect rules still govern outage
  detection. [Recorder outage recovery](2026-11-19-recorder-unreachable-server.md)
- The outage-only connection guidance is superseded for capable pairings. The card can direct the
  user to offline Start while retaining the participant notice. [Meeting card notice](2026-11-20-recorder-meeting-card-is-a-notice.md)
- Offline Start triggers the original key-pair revisit and changes the release order for this
  feature. Lazy per-user keys live in the shared database under the existing `ENCRYPTION_KEY`,
  so there is no operator PEM provisioning or secret distribution to hosted processes. Rotation
  can issue a new key ID while keeping retired keys usable, and owner-scoped lookup blocks
  cross-account replay. Losing the original private key can still strand pending audio.
  [Meeting Recorder extension](2026-10-21-meeting-recorder-extension/README.md)

## Timeline

- **2026-11-28** The maintainer approved automatic offline capture with per-user sealing. Plan
  review moved the protocol choice to Start so every chunk is sealed as it is written.
