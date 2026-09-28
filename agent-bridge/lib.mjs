/**
 * Pure request/response logic for the agent-bridge sidecar.
 *
 * Split from `server.mjs` so it can be imported and tested without
 * binding a port, spawning a CLI, or needing a subscription -- see
 * `src/tests/ai/agent-bridge.test.ts`. Nothing here touches I/O.
 */

export class BridgeError extends Error {
    constructor(status, message) {
        super(message);
        this.name = "BridgeError";
        this.status = status;
    }
}

/** Split a space-separated env var into argv entries. */
export function splitArgs(value) {
    return (value || "").trim().split(/\s+/).filter(Boolean);
}

/**
 * Model ids reach two places that care about their shape: the CLI's argv,
 * and the request log. Anything outside this set is rejected before
 * either -- a real model id has never needed whitespace, a control
 * character, or a shell metacharacter, and allowing one would let a
 * caller forge log lines (CodeQL: js/log-injection) or pad argv.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:+/-]{1,128}$/;

/**
 * Strip anything that could break out of a single log line.
 *
 * Redundant with `MODEL_ID_PATTERN` for values that reached here through
 * `resolveBackend`, and deliberately so: it is the sanitizer on the path
 * from request body to log sink, and it keeps that guarantee local to
 * the log statement rather than resting on a validation three calls
 * away.
 */
export function sanitizeForLog(value, maxLength = 128) {
    return (
        String(value)
            // CR and LF are spelled out rather than folded into the
            // range below because they are the whole point -- they are
            // what ends a log line -- and because a character-class
            // range is opaque to static analysis (CodeQL alert 15 on
            // PR #12 kept firing until these were explicit).
            .replace(/\n/g, "")
            .replace(/\r/g, "")
            // Remaining C0 controls, DEL, and the C1 range. Written as
            // escapes so the intent survives a copy/paste that would
            // otherwise embed raw control bytes.
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
            .slice(0, maxLength)
    );
}

/**
 * One sidecar serves both CLIs, so the `model` field is what picks the
 * backend. Returns "claude", "codex", or null.
 *
 * An unrecognised id is a hard error upstream rather than a guess:
 * Riffado falls back to `gpt-4o-mini` when a credential has no
 * `defaultModel` (`generate-summary.ts`), and silently routing that to
 * Codex would be a confusing way to discover the model field was left
 * blank.
 */
export function resolveBackend(model) {
    if (typeof model !== "string") return null;
    const id = model.trim();
    if (!MODEL_ID_PATTERN.test(id)) return null;
    if (id.startsWith("claude")) return "claude";
    if (id.startsWith("codex") || id.startsWith("gpt-5")) return "codex";
    return null;
}

/** OpenAI message content is a string or an array of typed parts. */
export function contentToText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part) => {
            if (typeof part === "string") return part;
            return typeof part?.text === "string" ? part.text : "";
        })
        .filter(Boolean)
        .join("\n");
}

/**
 * Flatten `messages` into the single prompt a CLI turn accepts.
 *
 * System content is prepended as plain text rather than passed through a
 * `--append-system-prompt`-style flag: it behaves identically for both
 * backends and keeps one more per-CLI flag off the critical path.
 *
 * Riffado only ever sends one system + one user message, which is why
 * that case emits the user text verbatim -- adding a "user:" label would
 * put a token in front of the transcript that the prompt never asked for.
 */
export function buildPrompt(messages) {
    if (!Array.isArray(messages)) return "";

    const system = messages
        .filter((m) => m?.role === "system")
        .map((m) => contentToText(m.content))
        .filter(Boolean)
        .join("\n\n");

    const rest = messages.filter((m) => m?.role && m.role !== "system");

    const body =
        rest.length === 1 && rest[0].role === "user"
            ? contentToText(rest[0].content)
            : rest
                  .map((m) => `${m.role}: ${contentToText(m.content)}`)
                  .filter((line) => !line.endsWith(": "))
                  .join("\n\n");

    if (!body) return system;
    return system ? `${system}\n\n${body}` : body;
}

function isJson(value) {
    try {
        JSON.parse(value);
        return true;
    } catch {
        return false;
    }
}

/**
 * Pull a JSON payload out of an agent's reply.
 *
 * Both CLIs front a coding agent, not a completions endpoint, so a reply
 * sometimes arrives wrapped in prose ("Here's the summary:") or a fenced
 * block. Riffado strips fences only at the very start and end of the
 * string (`generate-summary.ts`), so a leading sentence defeats it and
 * the entire reply -- preamble included -- gets stored as the summary
 * with empty keyPoints and actionItems.
 *
 * Strictly a narrowing step. Anything not recognisably JSON comes back
 * untouched, which is what keeps plain-text callers working:
 * `generateTitleFromTranscription` wants a bare title, not JSON.
 */
export function extractJson(text) {
    if (typeof text !== "string") return text;
    const trimmed = text.trim();
    if (!trimmed) return text;

    // Already bare JSON.
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && isJson(fenced[1].trim())) return fenced[1].trim();

    // Prose around a bare object, no fence.
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last > first) {
        const candidate = trimmed.slice(first, last + 1);
        if (isJson(candidate)) return candidate;
    }

    return text;
}

/**
 * Claude Code flags that leave the agent with text in and text out, and
 * nothing on disk afterwards.
 *
 * The prompt is a user's transcript, so it is untrusted: a sentence
 * spoken in a meeting or in an uploaded recording can be an instruction.
 * With tools available, that instruction could have the agent read the
 * credentials volume and write what it found into the summary, which the
 * requesting user then reads. The bridge turns a prompt into text and
 * needs no tool for it.
 *
 * Verified against Claude Code 2.1.270 and 2.1.281 -- see the README.
 */
const CLAUDE_LOCKDOWN_ARGS = [
    // Empties the built-in tool set. `--allowedTools` only pre-approves
    // tools; this is the flag that removes them. The option is variadic,
    // so the element after "" has to be a flag -- anything else would be
    // read as a tool name.
    "--tools",
    "",
    // `--tools` covers built-in tools only: an MCP server in the volume's
    // user config was still offered to the model with it set. With no
    // `--mcp-config` next to it, this loads no MCP server at all.
    "--strict-mcp-config",
    // Otherwise every request leaves its full transcript under
    // `projects/`, in the credentials volume, outside Riffado's
    // retention settings.
    "--no-session-persistence",
    // Auto-memory keeps a MEMORY.md per working directory and loads it
    // into every session. Every request runs in the same /work, so that
    // file would carry one user's transcript into another user's
    // completion. claude.ai connectors are the subscription account's
    // own MCP servers (Drive, Gmail, ...), fetched from the account
    // rather than a config file; this is the setting documented to keep
    // them from loading.
    "--settings",
    JSON.stringify({ autoMemoryEnabled: false, disableClaudeAiConnectors: true }),
];

/**
 * Codex flags with the same aim as CLAUDE_LOCKDOWN_ARGS.
 *
 * Codex has no single "no tools" switch, so each tool that can reach
 * outside the prompt is turned off by its feature flag. `--disable`
 * rejects a name the installed version does not know, which is on
 * purpose: a renamed feature fails the request loudly instead of quietly
 * handing the shell back. `-c features.<name>=false` would accept the
 * unknown name and do nothing.
 *
 * Verified against Codex 0.153.3 and 0.155.1 -- see the README.
 */
const CODEX_LOCKDOWN_ARGS = [
    // No rollout under `sessions/`, no thread history. Without it every
    // request leaves its transcript in the credentials volume.
    "--ephemeral",
    // Skip `$CODEX_HOME/config.toml`, so nothing in the volume can add an
    // MCP server or turn a feature below back on. Auth still comes from
    // CODEX_HOME. `-c mcp_servers={}` does not do this: the override is
    // merged into the table rather than replacing it.
    "--ignore-user-config",
    // Shell commands. `--sandbox read-only` still lets them read any
    // file, credentials included.
    "--disable",
    "shell_tool",
    // Reads a local file into the conversation.
    "--disable",
    "view_image",
    // The ChatGPT account's connectors, and plugins that bring their own
    // tools and MCP servers.
    "--disable",
    "apps",
    "--disable",
    "plugins",
    // Sub-agents, browser and desktop control, image generation: nothing
    // a summary needs, and each one reaches further than the prompt.
    "--disable",
    "multi_agent",
    "--disable",
    "browser_use",
    "--disable",
    "computer_use",
    "--disable",
    "image_generation",
    // State that outlives the request: cross-session memories and goals.
    "--disable",
    "memories",
    "--disable",
    "goals",
    // A search query is a way out for anything the model has read.
    "-c",
    'web_search="disabled"',
    // `~/.codex/history.jsonl`. `exec` did not write it in testing; this
    // keeps that true if it ever starts to.
    "-c",
    'history.persistence="none"',
];

/**
 * Build the argv for a backend. The prompt is NOT included: it goes in on
 * stdin, because Linux caps a single argv element at MAX_ARG_STRLEN
 * (128 KiB) and rejects anything longer with E2BIG. Riffado buckets
 * transcripts at 50k+ chars as "very_long", so a long meeting crosses
 * that line and would fail to spawn at all. It also keeps the transcript
 * out of `ps` output.
 *
 * Both backends run without tools and without session persistence (see
 * CLAUDE_LOCKDOWN_ARGS and CODEX_LOCKDOWN_ARGS). `extraArgs` come after
 * those flags, so an operator can still override them -- and should not.
 */
export function buildArgs(backend, model, extraArgs = [], codexOutPath = "") {
    // A bare backend id -- "claude", "codex" -- means "whatever this
    // account would pick", and omits --model entirely. That is not a
    // nicety: vendor slugs are gated by plan, and `gpt-5-codex` is
    // refused outright on a ChatGPT subscription ("not supported when
    // using Codex with a ChatGPT account"), which is how this surfaced on
    // the first real deployment. Omitting the flag lets the CLI resolve
    // whatever the plan actually grants.
    const modelArgs = model === backend ? [] : ["--model", model];

    if (backend === "claude") {
        // `--print`, never `--bare`: --bare disables OAuth and demands
        // ANTHROPIC_API_KEY, which is the one thing this bridge exists to
        // avoid.
        return [
            "--print",
            "--output-format",
            "json",
            ...CLAUDE_LOCKDOWN_ARGS,
            ...modelArgs,
            ...extraArgs,
        ];
    }
    if (backend === "codex") {
        // `--output-last-message` writes just the final assistant message
        // to a file. Parsing `--json` JSONL instead would mean depending
        // on event shapes that move between releases; a file with one
        // string in it does not.
        //
        // `--sandbox read-only` stays even with the shell gone: Codex
        // still offers `apply_patch`, which no flag in these versions
        // removes, and the sandbox is what refuses its writes.
        return [
            "exec",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            ...CODEX_LOCKDOWN_ARGS,
            "--output-last-message",
            codexOutPath,
            ...modelArgs,
            ...extraArgs,
            "-",
        ];
    }
    throw new BridgeError(400, `unknown backend "${backend}"`);
}

/**
 * Build the operator-facing tail of a failed CLI's stderr.
 *
 * Codex echoes the prompt to stderr before failing, so a naive tail puts
 * the user's transcript into the HTTP error body and from there into
 * Riffado's logs. Observed on the first real deployment: a 502 for an
 * unsupported model led with the last line of the summary prompt.
 *
 * Any line appearing verbatim in the prompt is dropped. Diagnostics the
 * CLI generates itself -- warnings, API errors -- are not substrings of
 * the prompt, so they survive, which is what makes the error useful.
 */
export function diagnosticTail(stderr, prompt = "", maxLines = 5, maxChars = 600) {
    return String(stderr)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !prompt.includes(line))
        .slice(-maxLines)
        .join("; ")
        .slice(0, maxChars);
}

/** Shape a successful reply as an OpenAI chat completion. */
export function chatCompletion(model, content, id, createdMs = Date.now()) {
    return {
        id: `chatcmpl-${id}`,
        object: "chat.completion",
        created: Math.floor(createdMs / 1000),
        model,
        choices: [
            {
                index: 0,
                message: { role: "assistant", content: extractJson(content) },
                finish_reason: "stop",
            },
        ],
        // The CLIs bill against a subscription, not per token, and report
        // no usable per-request counts. Zeros keep the response shape
        // valid for clients that read it; they are not a measurement.
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}

/** Parse the `--output-format json` envelope from the Claude CLI. */
export function parseClaudeEnvelope(stdout, bin = "claude") {
    let envelope;
    try {
        envelope = JSON.parse(stdout);
    } catch {
        throw new BridgeError(
            502,
            `${bin} produced output that is not the expected JSON envelope`,
        );
    }

    if (envelope.is_error) {
        throw new BridgeError(
            502,
            `${bin} reported an error (subtype: ${envelope.subtype ?? "unknown"})`,
        );
    }

    const text = typeof envelope.result === "string" ? envelope.result : "";
    if (!text.trim()) {
        throw new BridgeError(502, `${bin} returned an empty result`);
    }
    return text;
}
