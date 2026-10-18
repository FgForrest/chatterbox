import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TOKEN = "bridge-test-token";
const RUN_TOKEN = "lr1.run.signature";

function unusedPort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
        const probe = createNetServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            if (!address || typeof address === "string") {
                reject(new Error("could not reserve a test port"));
                return;
            }
            const { port } = address;
            probe.close((error) => {
                if (error) reject(error);
                else resolvePort(port);
            });
        });
    });
}

function waitForOutput(read: () => string, needle: string): Promise<void> {
    return new Promise((resolveWait, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
            if (read().includes(needle)) {
                clearInterval(timer);
                resolveWait();
            } else if (Date.now() - startedAt > 5_000) {
                clearInterval(timer);
                reject(new Error(`timed out waiting for ${needle}`));
            }
        }, 10);
    });
}

describe("agent-bridge server CLI failures", () => {
    let directory = "";
    let server: ChildProcessWithoutNullStreams;
    let baseUrl = "";
    let stdout = "";
    let stderr = "";

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "agent-bridge-server-test-"));
        const fakeCodex = join(directory, "fake-codex.mjs");
        await writeFile(
            fakeCodex,
            `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
    if (prompt.includes("RATE_CASE")) {
        console.log(JSON.stringify({
            type: "turn.failed",
            error: { message: "You've hit your usage limit. Retry after 9 seconds." },
        }));
    } else if (prompt.includes("STDERR_CASE")) {
        console.error("ERROR: " + JSON.stringify({
            type: "error",
            status: 403,
            error: { message: "account access was denied" },
        }));
    } else {
        console.log(JSON.stringify({
            type: "error",
            message: JSON.stringify({
                type: "error",
                status: 400,
                error: {
                    type: "invalid_request_error",
                    message: "The 'gpt-6.1-sol' model is not supported. Token " + process.env.RIFFADO_MCP_TOKEN,
                },
            }),
        }));
    }
    process.exitCode = 1;
});
`,
            { mode: 0o700 },
        );
        await chmod(fakeCodex, 0o700);

        const port = await unusedPort();
        baseUrl = `http://127.0.0.1:${port}`;
        server = spawn(process.execPath, [resolve("agent-bridge/server.mjs")], {
            cwd: directory,
            env: {
                ...process.env,
                BRIDGE_TOKEN: TOKEN,
                BRIDGE_LEARN_MCP_URL: "http://app.test/api/mcp/learn",
                BRIDGE_WORKDIR: directory,
                CODEX_BIN: fakeCodex,
                PORT: String(port),
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
        server.stdout.setEncoding("utf8");
        server.stderr.setEncoding("utf8");
        server.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        server.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        await waitForOutput(() => stdout, "listening on");
    });

    afterAll(async () => {
        if (server && server.exitCode === null) {
            server.kill("SIGTERM");
            await new Promise<void>((resolveExit) => {
                server.once("exit", () => resolveExit());
            });
        }
        if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("returns and logs Codex's own redacted invalid-request error", async () => {
        const prompt = "Transcript: private board meeting";
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-6.1-sol",
                messages: [{ role: "user", content: prompt }],
                riffado_mcp: {
                    token: RUN_TOKEN,
                    tools: ["find_entities"],
                },
            }),
        });
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error.message).toContain(
            "The 'gpt-6.1-sol' model is not supported.",
        );
        expect(body.error.message).toContain("[redacted]");
        expect(body.error.message).not.toContain(RUN_TOKEN);
        expect(body.error.message).not.toContain("private board meeting");
        expect(stderr).toContain("The 'gpt-6.1-sol' model is not supported.");
        expect(stderr).not.toContain(RUN_TOKEN);
        expect(stderr).not.toContain("private board meeting");
    });

    it("returns 429 and Retry-After for a CLI usage limit", async () => {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-6.1-sol",
                messages: [{ role: "user", content: "RATE_CASE" }],
            }),
        });
        const body = await response.json();

        expect(response.status).toBe(429);
        expect(response.headers.get("Retry-After")).toBe("9");
        expect(body.error.message).toContain("usage limit");
    });

    it("uses a structured error from stderr when stdout has none", async () => {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-6.1-sol",
                messages: [{ role: "user", content: "STDERR_CASE" }],
            }),
        });
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.error.message).toContain("account access was denied");
    });
});
