---
title: Transcription providers that are not OpenAI-compatible get a native adapter chosen by transcriptionStyle, not a proxy
date: 2026-09-13
updated: 2026-10-22 20:45
status: accepted
kind: feature
issues: []
prs: [24]
areas: [src/lib/ai/provider-presets.ts, src/lib/transcription, AGENTS.md, content/docs/guides/ai-providers.mdx]
supersedes: []
superseded-by: []
relates: [2026-10-02-almanac-guided-transcript-correction, 2026-10-22-security-assessment-hardening]
---

# Transcription providers that are not OpenAI-compatible get a native adapter chosen by transcriptionStyle, not a proxy

ElevenLabs Scribe and Speechmatics transcribe through APIs that look nothing like OpenAI's
`/audio/transcriptions`. Instead of putting an OpenAI-compatible proxy in front of them, each got a
small adapter module (`src/lib/transcription/<provider>-transcribe.ts`) selected by a
`transcriptionStyle` value on its provider preset, following the Gemini adapter that upstream had
already shipped. The same change rewrote the `AGENTS.md` extension point, which until then told
contributors to front such providers with an OpenAI-compatible shim.

## Why

- **Scribe could not be added as a "Custom" provider.** Its endpoint is `/v1/speech-to-text`, auth
  is an `xi-api-key` header, and the multipart fields are `model_id` and `language_code`, so the
  Whisper path failed on it.
- **The written convention contradicted the code.** `AGENTS.md` said a provider with non-standard
  auth gets an adapter that fronts it behind an OpenAI-compatible surface, while
  `gemini-transcribe.ts` (upstream riffado/riffado#176) was already a native adapter dispatched by
  style.
- **The Whisper path degrades audio.** To stay under OpenAI's 25 MiB request limit, oversized
  recordings are re-encoded to mono Opus before upload. Anything routed through that path, including
  a proxy, inherits the re-encode.
- **Self-host must stay one `docker compose up`.**

## Options considered

### Option A: a LiteLLM proxy as an extra compose service (declined)

LiteLLM translates OpenAI-style calls to ElevenLabs, so the app would treat Scribe as an
OpenAI-compatible provider with no code change.

- **Pros:** no application code; the same proxy could front further providers.
- **Cons:** one more container every self-hoster who wants Scribe has to run and configure; audio
  still goes through the Whisper path and its 25 MiB re-encode; provider-specific request flags and
  response detail (diarization, word timings) have to survive translation into the OpenAI shape
  (inferred).
- **Rejected because:** the re-encode costs accuracy on long recordings for no reason, since Scribe
  accepts multi-gigabyte uploads, and the proxy adds a service to the deployment surface. Revisit if
  the number of non-compatible providers grows to where per-provider adapters cost more to maintain
  than one proxy (inferred).

### Option B: a native adapter per provider, selected by `transcriptionStyle` (chosen)

About 150 lines across four files for Scribe: a style value on the preset, one adapter module
exporting one function, and one branch on the style in `transcribe-recording.ts`.

- **Pros:** audio is uploaded as stored; provider features (diarization flags, word timings,
  vocabulary hints, residency hosts) are reachable directly; no new service.
- **Cons:** every such provider is code to write, test and keep current with the vendor's API.

## Decision

**Chosen: Option B.** It keeps the recording's audio quality and the single-service deployment, and
it matches the Gemini precedent so `transcribeRecording` dispatches on style only. Speechmatics
(PR #24) followed the same day on the same pattern. A user can still front an unsupported provider
with their own proxy and add it as an OpenAI-compatible endpoint; `AGENTS.md` keeps that as the
alternative.

## Key technical details

- **Styles** live on the presets in `src/lib/ai/provider-presets.ts` (`whisper`, `chat`, `gemini`,
  `elevenlabs`, `speechmatics`). `src/lib/transcription/transcribe-recording.ts` branches on the
  style, never on a provider name.
- **Native adapters skip the 25 MiB mono Opus re-encode**; the reason is documented in
  `content/docs/guides/ai-providers.mdx`.
- **Diarization is a model-id suffix** (`scribe_v2+diarize`, `enhanced+diarize`), because both
  vendors make it a request flag rather than a model. The suffix is also what `mayBeDiarized`
  looks for when deciding to render a dialog, so the display rule cannot drift from the request
  rule. Vendor speaker labels are rewritten to `speaker_N`.
- **`transcriptionOnly` on a preset** keeps Scribe, Speechmatics and Gemini out of summarization
  and out of the enhancement default. Before it, a user whose only provider was one of them got an
  opaque 401 from `api.openai.com` whenever a summary ran.
- **Speechmatics is a job API** (submit, poll, fetch) hidden behind one awaited call. The poll loop
  is bounded by `WHISPER_REQUEST_TIMEOUT_MS`, the budget the Whisper path already holds a request
  open for; a 429 or 5xx while polling is transient. The vendor-side job is deleted afterwards,
  best effort, so the audio does not sit on its servers.
- **Timings are kept.** Both adapters return word or turn timings as turns, because the speaker
  knowledge base attaches identities to spans of audio. A transcript without timed turns cannot be
  used by Learn, so a new adapter that drops timings silently disables Learn for its users.
- **Vocabulary hints** use each vendor's native field: Scribe v2 `keyterms`, Speechmatics
  `additional_vocab` (not on `melia-1`).

## Verification

- `src/tests/transcription/elevenlabs-transcribe.test.ts`, `elevenlabs-routing.test.ts`,
  `speechmatics-transcribe.test.ts`, `speechmatics-routing.test.ts` (a Speechmatics credential never
  reaches the OpenAI SDK), `gemini-transcribe.test.ts`, and `src/tests/provider-presets.test.ts`.
- Scribe: 981 tests passing at merge. Speechmatics: 22 new tests, 1301 passing.
- Neither adapter was smoke-tested against the live API when merged: the Scribe key test was
  pending, and the Speechmatics wire format was checked against the vendor's docs and its official
  JS SDK source.

## Consequences & open follow-ups

- Each further non-compatible provider is an adapter plus a style value; the steps are in
  `AGENTS.md` under "Adding an AI provider".
- A vendor API change breaks only its adapter, but nothing in CI calls the real APIs, so it shows
  up as failed transcriptions in use.

## Related work

- [Security assessment hardening](2026-10-22-security-assessment-hardening.md): hosted native adapters now share the public-target transport with SDK clients.

- [2026-10-02-almanac-guided-transcript-correction](2026-10-02-almanac-guided-transcript-correction.md):
  sends Almanac terms through the native vocabulary fields these adapters expose.

## Timeline

- **2026-09-13**: LiteLLM proxy and native adapter compared for Scribe; native chosen. Scribe adapter
  and the `transcriptionOnly` guard committed to `main` without a PR; `AGENTS.md` extension point
  corrected. Speechmatics merged (PR #24). Scribe word timings and Speechmatics turn timings kept as
  turns.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
