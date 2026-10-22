---
title: Claude Code and Codex subscriptions serve summaries through a locked-down, locally built sidecar
date: 2026-09-28
updated: 2026-10-22 16:00
status: accepted
kind: infrastructure
issues: []
prs: [11, 12, 13, 63, 78, 116, 151, 158, 231]
areas: [agent-bridge, src/lib/ai/provider-presets.ts, docker-compose.yml, scripts/build-agent-bridge.sh]
supersedes: []
superseded-by: []
relates: [2026-09-30-learn, 2026-10-05-ai-cost-per-provider-card]
---

# Claude Code and Codex subscriptions serve summaries through a locked-down, locally built sidecar

`agent-bridge/` is an opt-in sidecar that answers OpenAI-style `POST /v1/chat/completions` by
running the Claude Code CLI (`claude --print`) or the Codex CLI (`codex exec`), so summaries,
titles and later Learn runs are paid from a Claude or ChatGPT subscription instead of a metered API
key. The app needs no new code path: it already talks to any OpenAI-compatible `baseURL`. Around
that core sit several decisions that each rejected a real alternative: the CLIs live in their own
container, no prebuilt image is published, the two presets are enhancement-only, every request runs
with tools and session persistence switched off, purging old CLI data is optional, every `gpt-` id
routes to Codex, and the bridge prices Codex turns itself.

## Why

- **Cost model.** Summaries and titles against a metered key cost money per recording; the
  maintainer wanted them paid from existing Claude and ChatGPT subscriptions instead.
- **The CLIs are coding agents.** By default they run shell commands, read files, browse, load MCP
  servers and keep sessions and memories on disk. Every bridge request carries a user's decrypted
  transcript, which is untrusted input: a sentence spoken in a meeting can be phrased as an
  instruction. One bridge serves every user of an instance.
- **Credentials refresh in place.** Both CLIs rewrite their OAuth tokens on disk, so the store must
  be writable and persistent.
- **Self-host stays one `docker compose up`**, and the bridge must be invisible to anyone who does
  not opt in.

## Options considered

### Option A: an OpenAI-compatible sidecar in front of the CLIs, built by the user (chosen)

A zero-dependency Node service (`agent-bridge/server.mjs`, `lib.mjs`) behind the compose profile
`agent-bridge`, with no published port, a required `BRIDGE_TOKEN`, a credentials volume, and the
prompt passed on stdin.

- **Pros:** the subscription tokens never enter the app container; the app is unchanged; the two
  CLIs are the entire trusted surface of the container that holds the credentials.
- **Cons:** an extra container to build, authenticate and keep in step with two CLI release
  cadences; no SLA on the headless token flow.

### Option B: install the CLIs in the app image (declined)

- **Pros:** no second container, no bridge token.
- **Rejected because:** it hands the Next.js process live tokens for two paid subscriptions, a
  bigger blast radius than the provider keys it holds today (those are at least encrypted with
  `ENCRYPTION_KEY`), and ties two CLI release cadences to the app's Dockerfile.

### Option C: the vendors' agent SDKs instead of spawning the CLIs (declined)

- **Pros:** the Claude SDK's JSON-schema output would have solved reply-shape problems more cleanly
  than the bridge's own JSON extraction.
- **Rejected because:** the credential container is the worst place in the stack to add two
  dependency trees, given the release-age and `--ignore-scripts` posture already in force. Learn
  later got schema enforcement through the CLIs' own flags instead (`--json-schema`,
  `--output-schema`).

### Option D: publish a prebuilt bridge image (declined)

- **Pros:** self-hosters would pull instead of build.
- **Rejected because:** `@anthropic-ai/claude-code` declares `SEE LICENSE IN README.md`, which points
  at Anthropic's Commercial Terms and grants no redistribution right (`@openai/codex` is
  Apache-2.0). Publishing an image containing it would republish Anthropic's client. Users build
  their own (`scripts/build-agent-bridge.sh`, README "Building the image"). Revisit if the licence
  changes.

## Decision

**Chosen: Option A**, plus these rulings that shaped it over the following weeks:

- **Enhancement-only presets (PR #11).** Neither CLI accepts audio, so `enhancementOnly` mirrors
  the existing `transcriptionOnly`, and the three write paths that can aim transcription at a
  credential reject these presets. Without it both would appear as transcription options and fail
  at runtime.
- **Lockdown flags are baked into the argv (PR #63), reversing PR #12.** PR #12 left hardening to
  `CLAUDE_EXTRA_ARGS`/`CODEX_EXTRA_ARGS` because a flag the installed CLI does not recognise is a
  hard startup failure, so baking one in lets a CLI upgrade take the bridge down. PR #63 decided
  that failing closed is the right trade: with default tools, a prompt injection could make an
  agent read its own credential file (Codex's read-only sandbox blocks writes, not reads) and echo it
  into the summary; with session persistence on, decrypted transcripts piled up in the volume outside
  retention, and Claude's auto-memory from one user's summary loaded into the next user's.
- **Purging pre-PR #63 session data is optional.** The maintainer uses the same CLI accounts for his
  own coding and preferred keeping everything to risking those sessions. The README purge refuses a
  bind-mounted home and backs the volume up first.
- **Every valid `gpt-` id routes to Codex (PR #151).** Routing only `codex…`, `gpt-5…` and exact
  price-table ids refused newer model generations with the bridge's own 400. If the account lacks a
  model, Codex now refuses it with its own message, which PR #158 passes through with a fitting
  status (400 not retried, 429 with `Retry-After`).
- **The bridge prices Codex turns (PR #78, PR #231).** Claude's JSON result carries a cost, which
  the bridge forwards; Codex reports tokens only, so the bridge applies published API rates from
  `CODEX_MODELS` in `agent-bridge/lib.mjs`. A model missing there reports tokens without a cost; no
  price is guessed. These are API-equivalent estimates, not a share of the subscription fee.

What would change the core choice: either vendor documenting a supported headless integration with
its own isolation, or the licence of the Claude CLI allowing redistribution.

## Key technical details

- **Presets** `Claude Code` and `Codex` share the base URL `http://agent-bridge:8787/v1` and are told
  apart by model id (`src/lib/ai/provider-presets.ts`). The API key field holds `BRIDGE_TOKEN`, not
  a vendor key. They are hidden on hosted through `LOCAL_PRESET_NAMES`; that is cosmetic, the
  service name simply does not resolve there.
- **Prompt on stdin, never argv:** Linux caps one argv element at 128 KiB (`E2BIG`), which a long
  meeting transcript crosses.
- **`--print`, never `--bare`:** `--bare` disables OAuth and requires an API key, the one thing the
  bridge exists to avoid. A test asserts it never appears.
- **Lockdown argv** (`buildArgs` in `agent-bridge/lib.mjs`): Claude `--tools ""`,
  `--strict-mcp-config`, `--setting-sources ""`, `--no-session-persistence`, and `--settings` with
  auto-memory and claude.ai connectors off; Codex `--ephemeral`, `--ignore-user-config`, ten
  `--disable <feature>` (shell, image viewing, apps, plugins, sub-agents, browser, computer use,
  image generation, memories, goals), web search and history persistence off, `--sandbox read-only`.
  `--disable` is used rather than `-c features.<name>=false` because it rejects an unknown feature
  name, while the `-c` form accepts one and does nothing.
- **Learn's narrow exception:** a Learn request may enable exactly the app's read-only knowledge
  tools over MCP; the URL comes only from the bridge's own `BRIDGE_LEARN_MCP_URL`, and the token
  lives in the child's environment only, redacted from errors and never logged.
- **Pin a cheap model.** A bare `claude` or `codex` id lets the CLI pick, and Codex then resolves to
  the plan's most capable model, which spends the rolling quota on every recording. The presets pin
  a fast model instead.
- **Logs carry sizes and durations only.** Error tails drop any stderr line that appears verbatim in
  the prompt, because Codex echoes the prompt on failure.
- **`*_EXTRA_ARGS` are appended after the lockdown flags** and can undo it; the README says not to.

## Verification

- `src/tests/ai/agent-bridge.test.ts` (24 tests in PR #12, 42 after PR #63, 80 after PR #231),
  `src/tests/ai/agent-bridge-server.test.ts` (the server end to end with a fake CLI),
  `src/tests/ai/provider-capability-routes.test.ts` (with `isEnhancementOnlyProvider` stubbed to
  `false`, 4 tests go red), `src/tests/learn/run-bridge.test.ts`.
- PR #12 against a stub CLI: 200,031 bytes delivered on stdin, past the argv limit; two 1 s requests
  at concurrency 1 took 2190 ms, so the gate serializes.
- PR #63 against a local mock of both vendor APIs, four CLI versions: Claude offered 20 to 21
  built-in tools plus a configured MCP tool before, none after; Codex offered shell, stdin, image and
  patch tools before, only `apply_patch` (refused by the read-only sandbox) plus `wait` and
  `request_user_input` after; before, the prompt text was found in session files, afterwards in none.
- `agent-bridge/smoke.sh` checks both CLIs, a real round trip, that no session data was written,
  and that Codex is logged in with ChatGPT rather than an API key (a metered setup passed the first
  version silently, fixed in PR #13).

## Consequences & open follow-ups

- **A bridge fix reaches a deployment only after a rebuild**, because there is no published image.
  PRs that touch `agent-bridge/` say so in their description.
- **Flag drift fails closed for flags, open for config keys.** An unknown Claude flag or Codex
  `--disable` name fails every request; an unknown Codex `-c` key is silently ignored, so a renamed
  `web_search` or `history.persistence` key would stop doing anything. `smoke.sh` checks acceptance
  and persistence, not the tool list.
- **A new Codex model needs two things in the image:** a CLI new enough to list the slug (an older
  CLI answers "not supported when using Codex with a ChatGPT account", which reads like plan gating),
  and a rate in `CODEX_MODELS`, or its turns stay unpriced. The app never reprices recorded requests.
- **A newer Codex CLI can change tool approval.** One release refused MCP tools without
  `readOnlyHint` in `exec`, which broke Learn's lookups; `src/lib/learn/mcp-tools.ts` now annotates
  them. Re-test Learn's MCP path, not only a plain completion, after a Codex bump.
- **Residual risk:** an injected instruction can still steer the summary text; Codex's `apply_patch`
  cannot be removed in the tested versions and relies on the read-only sandbox.
- **CI does not build the bridge Dockerfile.** A `COPY` line that omitted `lib.mjs` shipped with
  every test green, because the tests import the source tree.
- **Terms:** both subscriptions are licensed for the individual subscriber, and neither vendor
  documents the headless token as a backend path. Keeping one API-key provider as a fallback is the
  documented insurance.

## Related work

- [2026-09-30-learn](2026-09-30-learn/README.md): Learn runs through the bridge with the app's
  knowledge tools over MCP and answers in a JSON Schema.
- [2026-10-05-ai-cost-per-provider-card](2026-10-05-ai-cost-per-provider-card.md): a card's own
  price is the fallback when the bridge reports tokens without a cost.

## Timeline

- **2026-09-13**: enhancement-only presets (PR #11) and the bridge sidecar (PR #12); auth flow that
  can complete and a smoke test that rejects API-key logins (PR #13); first live deployment
  corrections; decision not to publish an image.
- **2026-09-28**: CLIs run without tools or session persistence (PR #63); purge made optional.
- **2026-09-29**: Learn's knowledge tools over MCP and JSON Schema answers through the bridge.
- **2026-10-01**: bridge forwards Claude's cost and prices Codex turns (PR #78).
- **2026-10-12**: build script for the bridge image (PR #116).
- **2026-10-18**: every `gpt-` id routes to Codex (PR #151); CLI errors reported with a fitting
  status (PR #158).
- **2026-10-22**: newest Codex model priced (PR #231).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
