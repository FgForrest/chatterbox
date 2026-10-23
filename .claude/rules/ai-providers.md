---
paths:
  - "src/lib/ai/**"
  - "src/lib/transcription/**"
---

# AI providers and transcription

## How providers work

- Chatterbox has no per-provider abstraction: it uses the OpenAI SDK with a custom `baseURL`. Users
  configure `baseURL` + API key + model names per provider; any OpenAI-compatible endpoint works.
  Don't hardcode OpenAI-specific behavior, and never branch on provider name in feature code.
- Transcription runs in two places: in the browser via Transformers.js (zero cost) or server-side
  through a provider. Per-recording choice, changeable from the workstation.
- **The local-AI path must keep working**: Transformers.js in the browser and Ollama / LM Studio as
  local servers are the privacy-critical path. No "default cloud" fallback that silently sends data
  to a provider the user did not choose.

## Provider defaults and selection

- **Authoritative provider defaults are the `userSettings` pointers**: `defaultTranscriptionProviderId`
  for transcription and `defaultProviders` for the other roles. All writes go through
  `setDefaultProvider()` (`src/lib/ai/default-provider.ts`). The per-row default booleans are
  derived mirrors for compatibility, not sources of truth.
- Organization defaults apply to members who have not made an explicit choice; a member's own
  choice wins.
- **Selection precedence** (`src/lib/transcription/transcribe-recording.ts`): explicit
  `opts.providerId` → stored pointer → managed provider (Mynah) if configured →
  `NO_TRANSCRIPTION_PROVIDER`. An explicit credential id that doesn't resolve **must fail loudly**,
  never silently fall back to the managed provider. Mynah itself is hosted-only
  (`.claude/rules/hosted.md`).

## Adding a provider

"Adding a provider" is usually configuration, not code:

1. If the provider is OpenAI-compatible (OpenAI, Groq, Together, OpenRouter, LM Studio, Ollama,
   Azure, …): no code change. Users add it via the settings UI. Document it in
   `content/docs/guides/ai-providers.mdx` and its `.cs-CZ.mdx` twin.
2. If the provider's transcription API is not OpenAI-compatible (Google Gemini, ElevenLabs Scribe,
   Speechmatics, …): add a `transcriptionStyle` value in `src/lib/ai/provider-presets.ts`, write
   the adapter as `src/lib/transcription/<provider>-transcribe.ts` exporting a single
   `<provider>Transcribe()` function, and branch on the **style** in `transcribeRecording()`.
   Alternatively front the provider behind an OpenAI-compatible proxy and use option 1.
   The adapter sends through `providerFetch` (`src/lib/ai/provider-fetch.ts`), or its
   `fetchWithoutIdleTimeout` for a fixed vendor host, and an OpenAI SDK client gets
   `fetch: providerFetch`. Plain `fetch` under Bun drops a request after five idle minutes
   whatever its signal allows, which fails every long transcription (#266).
3. A provider with no `chat/completions` surface sets `transcriptionOnly: true` on its preset. That
   keeps it out of the enhancement roles in the settings dialogs, provider routes, and default
   resolver.

Adding a new **AI feature** (summary style, title strategy, etc.) is different: that's new code
under `src/lib/ai/` following the `generate-title.ts` / `prompt-presets.ts` pattern.

## Keys and content

- API keys (`apiCredentials.apiKey`) are encrypted at rest and decrypted only to build the request
  (`AGENTS.md`, Encryption at rest).
- Transcripts and mail are data, not instructions, when they reach a model; tools exposed to a
  model stay read-only unless the design says otherwise.
