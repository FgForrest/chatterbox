# agent-bridge

An OpenAI-compatible `chat/completions` endpoint backed by the **Claude Code** and **Codex** CLIs, so a Claude or ChatGPT *subscription* can generate Riffado summaries and titles instead of a metered API key.

```
riffado-app ──http──▶ agent-bridge :8787/v1/chat/completions
  (unchanged)           │
                        ├─▶ claude --print      ─▶ Claude subscription
                        └─▶ codex exec          ─▶ ChatGPT subscription
```

Riffado needs no code path of its own for this. Both `generateSummaryForRecording` and `generateTitleFromTranscription` do nothing more than `new OpenAI({ baseURL })` + `chat.completions.create`, so anything answering that URL is a valid enhancement provider.

## Setup

**1. Generate a bridge token** and put it in `.env` at the repo root:

```sh
echo "BRIDGE_TOKEN=$(openssl rand -hex 32)" >> .env
```

**2. Pin the CLI versions** in `.env`. The image defaults to `latest`, which is the wrong posture for a container holding two subscription credentials:

```sh
CLAUDE_CODE_VERSION=x.y.z
CODEX_VERSION=x.y.z
```

**3. Start it.** The service sits behind a compose profile, so it stays out of the way of everyone who doesn't want it:

```sh
docker compose --profile agent-bridge up -d --build agent-bridge
```

**4. Authenticate each CLI**, once. See [Authentication](#authentication) below — this is the only fiddly step, because the container has no browser and publishes no port.

**5. Verify before wiring anything up:**

```sh
./agent-bridge/smoke.sh
```

This checks both CLIs run, both are authenticated *against a subscription*, `/health` answers, each backend completes a real round trip returning the JSON shape Riffado parses, and those round trips left no session files behind (see [Hardening](#hardening-no-tools-no-persistence)). It fails with the CLI's own error rather than a 502 three layers up.

**6. Add the provider in Riffado** — Settings → AI Providers → Add, pick **Claude Code** or **Codex**. Base URL and model prefill; paste `BRIDGE_TOKEN` into the API Key field and tick *Use for AI enhancements*.

> If your Riffado build predates those presets, add a **Custom** provider instead: Base URL `http://agent-bridge:8787/v1`, API Key `BRIDGE_TOKEN`, Default Model `claude-sonnet-5` or `gpt-5-codex`. Leave *Use for transcription* unticked — the bridge takes no audio.

## Building the image

**There is no prebuilt image, on purpose.** The image bundles both vendor CLIs, and they are licensed differently: `@openai/codex` is Apache-2.0, but `@anthropic-ai/claude-code` declares `SEE LICENSE IN README.md`, which points at [Anthropic's Commercial Terms](https://www.anthropic.com/legal/commercial-terms) — proprietary, granting no redistribution right. Publishing an image containing it would be republishing Anthropic's client. Building locally keeps each CLI on the machine that holds the subscription for it.

Pin both versions to what you actually run:

```sh
claude --version        # e.g. 2.1.270
codex --version         # e.g. codex-cli 0.153.3

docker build -t riffado-agent-bridge:local \
  --build-arg CLAUDE_CODE_VERSION=2.1.270 \
  --build-arg CODEX_VERSION=0.153.3 \
  ./agent-bridge
```

The `ARG` defaults are `latest`, which is the wrong posture for a container holding credentials for two paid subscriptions — the same "first adopter" position the Dependabot `cooldown` block and pnpm's `minimumReleaseAge` exist to avoid. Rebuild when you upgrade the CLIs, and run `smoke.sh` afterwards: a flag that moved between releases is a hard failure, not a warning.

The bridge's [hardening flags](#hardening-no-tools-no-persistence) were verified against Claude Code **2.1.270** and **2.1.281** and Codex **0.153.3** and **0.155.1**. Pin one of those; on anything newer, `smoke.sh` tells you whether the CLI still accepts them and still keeps sessions off disk.

### Running alongside an existing deployment

The compose service in this repo assumes you run Riffado from this checkout. If your deployment lives elsewhere — its own directory, pulling a published app image — the bridge must join **that** compose project, because the app reaches it at `http://agent-bridge:8787/v1`, a name that only resolves inside the same project's network.

Add a service to the deployment's compose (or its override file) referencing the tag you just built:

```yaml
  agent-bridge:
    image: riffado-agent-bridge:local
    container_name: riffado-agent-bridge
    restart: unless-stopped
    # One named variable, never `env_file: .env` -- that would hand this
    # container the app's ENCRYPTION_KEY, which decrypts every stored
    # provider credential.
    environment:
      BRIDGE_TOKEN: ${BRIDGE_TOKEN:?set BRIDGE_TOKEN in .env}
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}
      BRIDGE_MAX_CONCURRENCY: "1"
    volumes:
      - agent_creds:/home/node
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3

volumes:
  agent_creds:
    driver: local
```

Three things that are easy to get wrong here:

- **No `ports:`**, and no `profiles:` either — a profile means a plain `docker compose up -d` silently skips the service.
- **No `user:`**, even if your other services set one. The image runs as its own `node` user, which owns `/home/node`; forcing a different uid makes the directory the CLIs rewrite their tokens in read-only.
- Prove the wiring before going further:

  ```sh
  docker compose exec app node -e \
    "fetch('http://agent-bridge:8787/health').then(r=>r.json()).then(j=>console.log(j))"
  ```

Run `smoke.sh` **from the deployment directory**, not from this checkout — it shells out to `docker compose` in the current directory and reads `BRIDGE_TOKEN` from `./.env`:

```sh
cd /path/to/your/deployment
/path/to/riffado/agent-bridge/smoke.sh
```

## Authentication

Both flows below are **headless**: you authorize on whatever machine has a browser, and the credential lands in the `agent_creds` volume, where the CLIs refresh it in place. Neither needs a browser or an open port inside the container.

If the service is already running, use `docker compose exec agent-bridge <cmd>` — same volume, no second container, and the server keeps serving while you log in. The `docker compose run --rm` form below is for the case where it is not up; it mounts the same named volume, so either way the credential persists, and it implicitly enables the `agent-bridge` profile.

### Claude

Either put a long-lived token in `.env` — nothing to do inside the container, compose passes it through:

```sh
claude setup-token          # on any machine with Claude Code installed
# paste the result into .env as CLAUDE_CODE_OAUTH_TOKEN, then:
docker compose up -d agent-bridge
```

…or log in from inside the container. `claude auth login` prints a URL and accepts a pasted code, which is what makes it work without a browser:

```sh
docker compose run --rm agent-bridge claude auth login
docker compose run --rm agent-bridge claude auth status
```

### Codex

Codex needs a login; it has no env-var equivalent. Use **`--device-auth`**:

```sh
docker compose run --rm agent-bridge codex login --device-auth
```

It prints a verification URL and a one-time code — open the URL anywhere, enter the code, and it polls until you're done.

Plain `codex login` (no flag) is the wrong call here: it starts a loopback callback server *inside the container* and waits for a browser to redirect to it. There is no browser in the container and nothing published, so it can never complete. `--device-auth` is the flag that exists for exactly this situation.

Verify, and read the answer carefully:

```sh
docker compose run --rm agent-bridge codex login status
```

`Logged in using ChatGPT` is what you want. **`Logged in using an API key` means you are on metered billing**, not your subscription — `codex login --with-api-key` writes a perfectly valid `auth.json` too, so the file existing proves nothing. `smoke.sh` checks for this.

### Revoking

```sh
docker compose run --rm agent-bridge codex logout
docker compose run --rm agent-bridge claude auth logout
docker compose down agent-bridge

# To wipe both credentials entirely. The volume carries the compose
# project name as a prefix, so look it up rather than guessing:
docker volume ls --filter name=agent_creds
docker volume rm <the name it printed>
```

## Hardening: no tools, no persistence

Every prompt the bridge receives carries a user's transcript, and a transcript is untrusted input: a sentence spoken in a meeting or pasted into an upload can be written as an instruction to the agent. Both CLIs are coding agents, and by default they run with their full tool sets. A prompt injection could have the agent read the credentials in this container's volume and write them into the summary, which the requesting user then reads. Codex's `--sandbox read-only` blocks writes, not reads.

By default both CLIs also save every session to disk, in the credentials volume: the full prompt, so the decrypted transcript, outside Riffado's retention settings and never pruned. Both also have a cross-session memory (Claude Code's auto-memory is on by default; Codex's memories feature is off by default in the versions below). One bridge serves every user of a Riffado instance, from the same working directory, so a memory written during one user's summary would be loaded into the next user's.

The bridge only turns a prompt into text, so it runs both CLIs with no tools and nothing saved. These flags are built into `lib.mjs` (`buildArgs`), not left to `*_EXTRA_ARGS`.

**Claude Code**

| Flag | Effect |
|---|---|
| `--tools ""` | Empties the built-in tool set. `--allowedTools` would only pre-approve tools; this removes them. |
| `--strict-mcp-config` | Loads no MCP server (none is passed with `--mcp-config`). Needed on top of `--tools ""`, which leaves MCP tools in place. A Learn request passes exactly one, Riffado's (see [Learn](#learn-riffados-knowledge-tools)). |
| `--setting-sources ""` | Reads no user, project or local settings file. A user `advisorModel` setting keeps a server-side advisor that forwards the whole conversation to another model; neither `--disallowedTools` nor `--settings` removes it. OAuth still works. |
| `--no-session-persistence` | No session transcript under `~/.claude/projects/`. |
| `--settings '{"autoMemoryEnabled":false,"disableClaudeAiConnectors":true}'` | No auto-memory (a `MEMORY.md` per working directory, loaded into every session), and no claude.ai connectors, the subscription account's own MCP servers. |

**Codex**

| Flag | Effect |
|---|---|
| `--ephemeral` | No rollout under `~/.codex/sessions/`, no thread history. |
| `--ignore-user-config` | Skips `~/.codex/config.toml`, so nothing in the volume can add an MCP server or re-enable a feature below. Auth still comes from `CODEX_HOME`. |
| `--disable shell_tool` | No shell commands. |
| `--disable view_image` | No reading local files into the conversation. |
| `--disable apps`, `--disable plugins` | No ChatGPT connectors, no plugin-provided tools or MCP servers. |
| `--disable multi_agent`, `browser_use`, `computer_use`, `image_generation` | No sub-agents, browser or desktop control, image generation. |
| `--disable memories`, `--disable goals` | No cross-session memories or goals. |
| `-c web_search="disabled"` | No web search, which would otherwise be a way out for anything the model read. |
| `-c history.persistence="none"` | No `~/.codex/history.jsonl`. `exec` did not write it in testing either. |

`--sandbox read-only` stays. Codex still offers `apply_patch`, which no flag in these versions removes, and the sandbox is what refuses its writes (`patch rejected: writing is blocked by read-only sandbox`). What Codex still sends the model is `apply_patch` inside its code-mode `exec` wrapper (a JavaScript isolate with no file system or network access), plus `wait` and `request_user_input`. Codex still creates `state_*.sqlite`, `logs_*.sqlite`, `goals_*.sqlite`, `memories_*.sqlite` and `queue_*.sqlite` on every run; none of them held prompt text in testing.

**What this does not cover.** An injected instruction can still shape the reply itself: a transcript can talk the model into a misleading summary. What it can no longer do is reach anything outside the prompt.

**How it was verified.** On all four versions named under [Building the image](#building-the-image), each flag is in the CLI's `--help`, each Codex feature name in `codex features list`, and each settings or config key in the CLI's own settings schema or config validation. Each CLI was then run with the exact argv `buildArgs` produces against a local stand-in for the vendor API (no model, no subscription), in a throwaway home with an MCP server configured, and the requests it sent and the files it left were inspected:

- Before: Claude Code offered 20 to 21 built-in tools (`Bash`, `Read`, `WebFetch`, `Write`, ...) plus the configured MCP server's, put an auto-memory section in its system prompt, and left the prompt in `projects/<cwd>/<session>.jsonl`. Codex offered `exec_command`, `write_stdin`, `view_image`, `apply_patch`, goal tools and MCP resource tools, and left the prompt in `sessions/`, `thread_history_*.sqlite` and `state_*.sqlite`.
- After: Claude Code offered no tools and no auto-memory, and no file held the prompt. Codex offered only what is listed above, and no file held the prompt.

The stand-in logs in with an API key, so what only loads for a subscription login (claude.ai connectors, ChatGPT apps, hosted tools) could not be observed; those are switched off by the flags above but were not seen being switched off.

**Upgrading the CLIs.** A flag the installed version does not know fails every request, and Codex's `--disable` refuses a feature name it does not recognise (`Unknown feature flag: ...`). That is deliberate: a renamed feature fails loudly instead of quietly handing the shell back. Run `smoke.sh` after every CLI upgrade.

### Purging session data from before this fix (optional)

**Nothing needs to be deleted.** The hardening stops new session data from being written; what earlier bridges left in the credentials volume simply stays there. Leaving it alone is a perfectly valid choice, and the bridge never deletes anything itself.

If you do want it gone, read this first:

- **Only purge a dedicated volume.** The commands below delete directories under `/home/node/.claude` and `/home/node/.codex`. That is safe only when `/home/node` is the bridge's own Docker volume (`agent_creds` in the stock `docker-compose.yml`). If your setup bind-mounts a personal home directory, or your own `~/.claude` / `~/.codex`, into the container, **do not run them**: they would delete your own coding sessions, history and memories along with the bridge's. Step 2 checks this.
- **Back up first.** Step 3 writes the whole volume to a tarball you can restore.

The commands remove session transcripts, thread history and memories, and keep the login credentials (`.claude/.credentials.json`, `.codex/auth.json`) and configuration (`.claude.json`, `settings.json`, `config.toml`, `models_cache.json`). Run them from the directory whose compose project owns the bridge.

```sh
# 1. Stop the bridge, so no CLI has these files open.
docker compose stop agent-bridge

# 2. Check what /home/node is. Continue only if it prints
#    "volume <project>_agent_creds -> /home/node" and no "bind" line.
docker inspect "$(docker compose ps -a -q agent-bridge)" \
  --format '{{range .Mounts}}{{.Type}} {{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}} -> {{.Destination}}{{"\n"}}{{end}}'

# 3. Back the volume up (mounted read-only). Use the volume name step 2
#    printed; with the stock compose file it is <project>_agent_creds.
docker run --rm -v riffado_agent_creds:/v:ro -v "$PWD":/backup alpine \
  tar czf /backup/agent-creds-$(date +%F).tgz -C /v .

# 4. Look.
docker compose run --rm --no-deps agent-bridge \
  sh -c 'ls -la /home/node/.claude /home/node/.codex'

# 5. Delete.
docker compose run --rm --no-deps agent-bridge sh -c '
  cd /home/node/.claude &&
    rm -rf projects file-history tasks plans agent-memory session-env \
           shell-snapshots paste-cache debug history.jsonl
  cd /home/node/.codex &&
    rm -rf sessions session_index.jsonl history.jsonl memories \
           shell_snapshots generated_images \
           thread_history_*.sqlite* state_*.sqlite* memories_*.sqlite* \
           goals_*.sqlite* queue_*.sqlite* logs_*.sqlite*
'

# 6. Start it again and confirm both logins survived.
docker compose up -d agent-bridge
docker compose exec agent-bridge claude auth status
docker compose exec agent-bridge codex login status
```

To undo, stop the bridge and restore the tarball into the volume:
`docker run --rm -v riffado_agent_creds:/v -v "$PWD":/backup alpine tar xzf /backup/agent-creds-<date>.tgz -C /v`.

What those are:

- **`.claude/projects/`** holds one JSONL transcript per session, under `projects/-work/` for this bridge, and the auto-memory under `projects/-work/memory/`. It is where the transcripts were found in testing. `file-history`, `tasks`, `plans`, `agent-memory`, `session-env`, `shell-snapshots`, `paste-cache`, `debug` and `history.jsonl` hold state from the tools the bridge used to allow; none of them is needed to log in.
- **`.codex/sessions/`**, **`thread_history_*.sqlite*`** and **`state_*.sqlite*`** held the prompt in testing (the thread history, and the `title`, `first_user_message` and `preview` columns of the state database's `threads` table). `memories/` and `memories_*.sqlite*` hold memories, `goals_*` and `queue_*` goal and queued-message state, `logs_*` per-session logs. Codex recreates the SQLite files it needs on its next run.

Files an agent may have written into `/work` are in the container's own filesystem, not the volume; recreating the container (which a rebuild does) discards them.

## Learn: Riffado's knowledge tools

Riffado's Learn reads a transcript and proposes speaker names, corrections and facts. Through the bridge it can let the CLI look things up in Riffado's knowledge base itself, over MCP, with read-only tools. A request asks for that with two fields beyond the OpenAI shape:

- `response_format: {"type": "json_schema", "json_schema": {"schema": {...}}}`: the answer's JSON Schema. Claude gets `--json-schema` and the bridge returns its `structured_output`; Codex gets `--output-schema` (a `0600` file).
- `riffado_mcp: {"token": "<run token>", "tools": ["find_entities", ...]}`: the run's token and the tool names. **The URL is never the request's:** it is `BRIDGE_LEARN_MCP_URL`, and without it the bridge refuses such a request (400).

| | Claude Code | Codex |
|---|---|---|
| Tools | `--tools` and `--allowedTools` list exactly `mcp__riffado__<tool>`; nothing built in | the one server via `-c mcp_servers.riffado.url=…`; the shell and every other feature stay disabled |
| Server | `--strict-mcp-config --mcp-config <0600 file>` with one HTTP server | `--ignore-user-config` keeps any other out |
| Token | `Authorization: Bearer ${RIFFADO_MCP_TOKEN}` in the file, expanded by the CLI from its environment | `-c mcp_servers.riffado.bearer_token_env_var="RIFFADO_MCP_TOKEN"` |

The token is in the child's environment only: never in argv or a file, redacted from error text, never logged. It names one Learn run, expires, and works only while that run is running. The temp files go when the request ends. Verified with Claude Code 2.1.284 and Codex 0.155.1 (Spike 0.1, and a round trip through this bridge to a probe MCP server).

The bridge must reach Riffado at that URL: on the compose network, `BRIDGE_LEARN_MCP_URL=http://app:3000/api/mcp/learn`. Set `LEARN_MCP_URL` to the same value on the app, which is what tells Riffado to use it.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `BRIDGE_TOKEN` | *(required)* | Bearer token. The bridge refuses to start without it. |
| `BRIDGE_LEARN_MCP_URL` | — | The one URL of Riffado's knowledge tools a Learn request may use, e.g. `http://app:3000/api/mcp/learn`. Unset, requests cannot use tools. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | From `claude setup-token`. Optional if you logged in interactively. |
| `BRIDGE_MAX_CONCURRENCY` | `1` | Each request spawns a model session drawing on the same rolling window as your interactive coding. |
| `BRIDGE_TIMEOUT_MS` | `300000` | Per request. The child is SIGKILLed on expiry. |
| `BRIDGE_MAX_BODY_BYTES` | `20000000` | Transcripts are large; this is the ceiling. |
| `CLAUDE_EXTRA_ARGS` / `CODEX_EXTRA_ARGS` | — | Extra flags, space-separated, applied verbatim after the bridge's own. |
| `CLAUDE_BIN` / `CODEX_BIN` | `claude` / `codex` | Override to test a different build. |

### The extra-args escape hatch

The flags the bridge is unsafe without are built in (see [Hardening](#hardening-no-tools-no-persistence)). `CLAUDE_EXTRA_ARGS` / `CODEX_EXTRA_ARGS` are for anything else, adopted with an env change instead of an image rebuild. A flag the installed binary doesn't recognise is a **hard failure** on every request, not a warning, so confirm it against your installed version first:

```sh
docker compose exec agent-bridge claude --help
# then, in .env:
CLAUDE_EXTRA_ARGS=--effort low
```

They are appended after the built-in flags, so they can override them. Do not use them to hand tools or session persistence back. Codex settings belong here too, as `-c key=value`: the bridge runs Codex with `--ignore-user-config`, so a `config.toml` in the volume is not read.

Underneath the flags, the CLIs run as a non-root user with `/work`, an empty directory, as their working directory.

## Model routing

One sidecar serves both CLIs; the `model` field picks the backend.

| Model id | Backend |
|---|---|
| `claude…` (e.g. `claude-sonnet-5`, `claude-haiku-4-5-20251001`) | Claude Code CLI |
| `codex…`, `gpt-5…` | Codex CLI |
| exactly `claude` or `codex` | that CLI, with **no `--model`** — the account's own default |
| anything else | **400** |

The 400 is deliberate. Riffado falls back to `gpt-4o-mini` when a credential has no Default Model, and silently routing that to Codex would be a confusing way to find out the field was left blank.

### Pin a cheap model; the default is the expensive one

Setting the Default Model to exactly **`claude`** or **`codex`** makes the bridge omit `--model`, so each CLI resolves whatever your plan grants. Convenient, but **that resolves to the account's most capable model** — on a ChatGPT plan, `gpt-6-astra`, "our most capable model for complex, demanding work". Summarizing a transcript into three JSON fields does not need that, and it draws on the same rolling window as your interactive coding.

The `Codex` preset therefore ships `gpt-5.6-luna`, the model the catalog calls "fast and affordable". To see what your own account offers:

```sh
docker compose exec -T agent-bridge node -e '
const j = JSON.parse(require("fs").readFileSync("/home/node/.codex/models_cache.json","utf8"));
for (const m of (j.models || j)) {
  if (m.visibility === "list") console.log(m.slug, "--", m.description);
}
'
```

That cache is written after login and reflects your plan. If a pinned slug is not in it, the run fails with the backend's own message (`The '<slug>' model is not supported when using Codex with a ChatGPT account.`) — loud, which is what you want; the alternative is failing expensively.

Slugs are gated by tier, and the failure is not graceful: `gpt-5-codex` is refused outright on a ChatGPT account —

```
The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.
```

— while the same CLI, given no `--model`, resolved `gpt-6-astra` on the same account.

Anything other than a bare id passes through to the CLI unchanged, so the usable set tracks whatever the installed CLI supports rather than a list this bridge has to keep current.

## Things worth knowing

**These are coding agents, not completion endpoints.** Claude Code carries a system prompt tuned for tool use. Riffado's summary prompt demands bare JSON, and an agent sometimes prefaces it with a sentence. The bridge compensates: `extractJson` pulls a JSON payload out of a fenced block or surrounding prose, which Riffado's own fence-stripping (anchored to the very start and end of the string) cannot do. Anything not recognisably JSON passes through untouched, so plain-text callers like title generation are unaffected.

**`temperature` and `max_tokens` are dropped.** Riffado sends them; neither CLI exposes them. Summaries come out at whatever the agent's own defaults are.

**Rate limits are shared with your interactive coding.** A sync that pulls in a dozen recordings with auto-summarize on will draw from the same window as your terminal. `BRIDGE_MAX_CONCURRENCY=1` is the default for that reason. Consider pointing title generation at a cheaper model than summaries.

**Multi-pass summarization needs `BRIDGE_MAX_CONCURRENCY` raised to match.** Riffado's multi-pass setting (Settings -> Summary) runs N summary passes *in parallel* and merges them. The bridge queues at `BRIDGE_MAX_CONCURRENCY`, so leaving it at `1` turns those passes back into a serial run: the feature still works and the result is identical, but a 3-pass summary takes about four times as long as a single one instead of about the same. Set it to at least the pass count:

```yaml
      BRIDGE_MAX_CONCURRENCY: "3"
```

That is a real trade, not a free win -- N concurrent agent sessions draw on the same rolling window as your own terminal, which is exactly why the default is `1`. Turning multi-pass on for auto-summary as well (off by default) multiplies this by every recording a sync brings in.

**One summary at a time, whatever the queue length.** Summaries run on Riffado's durable job worker, and the summary handler declares a concurrency of `1` (`src/lib/summary/summary-job-handler.ts`). So a sync that queues a dozen auto-summaries still sends the bridge one job's worth of passes at a time: set `BRIDGE_MAX_CONCURRENCY` to the pass count, not to the pass count times the backlog. Raising the handler's concurrency would not make the backlog finish sooner either -- two jobs sharing the same bridge limit just queue inside it, while looking from the outside like two jobs that have stalled.

**Multi-pass merges are capped by the agent, not by Riffado.** Riffado asks for a higher `max_tokens` on the merge than on a pass, because the merged output is the union of every pass and so is longer than any one of them. The bridge drops `max_tokens` (see above), so on this provider the merge is bounded by the agent's own default instead. If merged summaries come back visibly cut off, that is the reason -- not the merge prompt.

**Usage numbers are zeros.** The CLIs bill against a subscription and don't report usable per-request counts. The `usage` block keeps the response shape valid; it is not a measurement.

**Terms.** Both subscriptions are licensed for the individual subscriber's use, and neither vendor documents the headless token as a backend integration path. Summarizing your own recordings on your own box is personal use, but there's no SLA on the token flow and either vendor can change it. Keeping one API-key provider configured as a fallback is cheap insurance.

**The credentials volume is sensitive.** `agent_creds` holds `~/.claude` and `~/.codex` — live OAuth tokens for two paid accounts, which the CLIs rotate in place. Treat it like `ENCRYPTION_KEY`. It is why this is a separate container rather than code inside the app image.

**The bridge publishes no port.** It is reachable only from other services on the compose network. Do not add a `ports:` mapping; the bearer token is the only thing between a caller and your subscription.

## Troubleshooting

Errors surface in Riffado as a failed summary. `docker compose logs -f agent-bridge` shows the bridge side; the message in the 502 is the CLI's own stderr tail.

| Symptom | Cause |
|---|---|
| `connect ECONNREFUSED agent-bridge:8787` | Container isn't up. The profile means `docker compose up -d` alone skips it — pass `--profile agent-bridge`. |
| `401 missing or invalid bearer token` | `BRIDGE_TOKEN` in `.env` and the API Key on the provider have drifted. The bridge compares them exactly. |
| `400 unknown model "gpt-4o-mini"` | The provider's Default Model is blank, so Riffado substituted its own fallback. Set it. |
| `502 … exited with code 1: … unknown/unexpected argument` | A flag in `CLAUDE_EXTRA_ARGS` / `CODEX_EXTRA_ARGS`, or one of the built-in [hardening flags](#hardening-no-tools-no-persistence), isn't in the installed version. Check with `docker compose exec agent-bridge claude --help`; pin a version the hardening was verified against. |
| `502 … Unknown feature flag: <name>` | The installed Codex no longer knows a feature the bridge disables. Pin a verified version, then check `codex features list` for what the feature became before changing `lib.mjs`. |
| `smoke.sh`: `the round trips wrote session files` | The running image predates the hardening, or a flag stopped working in the installed CLI. Rebuild the image. Files written before that stay where they are; removing them is optional (see [Purging](#purging-session-data-from-before-this-fix-optional)). |
| `502 … exited with code 1` mentioning login, credits, or a plan | Authentication or rate limit. Re-run the status commands under [Authentication](#authentication). |
| `502 … produced output that is not the expected JSON envelope` | The Claude CLI's `--output-format json` envelope changed shape. Pin the version and check `parseClaudeEnvelope` in `lib.mjs`. |
| `504 … exceeded BRIDGE_TIMEOUT_MS` | A long transcript against a slow model. Raise `BRIDGE_TIMEOUT_MS`. |
| Summary contains the agent's prose, `keyPoints` empty | The reply wasn't recognisably JSON, so `extractJson` passed it through untouched and Riffado stored the whole thing. Usually a model that ignores the format instruction — try a stronger one. |
| Everything is slow when several recordings sync at once | Working as designed: `BRIDGE_MAX_CONCURRENCY=1` queues them so they don't burn the rolling window in parallel. |

## Not verified in this repo's CI

CI has no Claude or Codex subscription, so nothing here exercises a real CLI. `src/tests/ai/agent-bridge.test.ts` covers the pure request/response logic — auth, model routing, message flattening, JSON extraction, and the hardening flags in the argv — by importing the module's helpers. Whether the installed CLI accepts that argv and keeps sessions off disk is what `smoke.sh` is for; run it after any CLI upgrade.

**Nor does CI build this Dockerfile.** That gap has already cost something: the `COPY` line named only `server.mjs` while the program also needs `lib.mjs`, so the published instructions produced an image that died at startup with `ERR_MODULE_NOT_FOUND` — and every test still passed, because they import `lib.mjs` straight from the source tree. A job that builds the image and starts the server far enough to bind a port would catch that class of defect without needing a subscription.
