import type { IncomingMessage, RequestOptions } from "node:http";
import type { LookupFunction } from "node:net";
import { PassThrough, Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import { OpenAI } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookup, transport } = vi.hoisted(() => ({
    lookup: vi.fn(),
    transport: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:http", () => ({ request: transport }));
vi.mock("node:https", () => ({ request: transport }));
vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: true } }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

import { providerFetch } from "@/lib/ai/provider-fetch";
import { validateAiBaseUrl } from "@/lib/ai/validate-base-url";
import { env } from "@/lib/env";

let status: number;
let responseBody: Buffer;
let responseHeaders: string[];
let sent: Buffer[];

beforeEach(() => {
    env.IS_HOSTED = true;
    lookup.mockReset().mockResolvedValue([
        { address: "8.8.8.8", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
    ]);
    sent = [];
    status = 200;
    responseBody = Buffer.from('{"ok":true}');
    responseHeaders = ["Content-Type", "application/json"];
    transport
        .mockReset()
        .mockImplementation(
            (
                options: RequestOptions,
                receive: (response: IncomingMessage) => void,
            ) => {
                const outgoing = new Writable({
                    write(chunk: Buffer, _encoding, callback) {
                        sent.push(Buffer.from(chunk));
                        callback();
                    },
                    final(callback) {
                        const incoming = Object.assign(new PassThrough(), {
                            statusCode: status,
                            statusMessage: "OK",
                            rawHeaders: responseHeaders,
                        });
                        receive(incoming as unknown as IncomingMessage);
                        incoming.end(responseBody);
                        callback();
                    },
                });
                options.signal?.addEventListener(
                    "abort",
                    () => outgoing.destroy(new Error("aborted")),
                    { once: true },
                );
                return outgoing;
            },
        );
});
afterEach(() => vi.unstubAllGlobals());

describe("hosted provider fetch", () => {
    it("rechecks DNS at request time after a successful save", async () => {
        await expect(
            validateAiBaseUrl("https://api.example.com/v1", { isHosted: true }),
        ).resolves.toEqual({ ok: true });
        lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
        await expect(
            providerFetch("https://api.example.com/v1/models"),
        ).rejects.toMatchObject({ code: "INVALID_INPUT", statusCode: 400 });
        expect(transport).not.toHaveBeenCalled();
    });

    it.each([
        "http://10.0.0.1/v1/models",
        "http://[fd00:ec2::254]/v2/jobs",
        "http://api.internal/models",
        "file:///etc/passwd",
        "https://user:secret@api.example.com/v1",
    ])("blocks %s before HTTP", async (url) => {
        await expect(providerFetch(url)).rejects.toMatchObject({
            statusCode: 400,
        });
        expect(transport).not.toHaveBeenCalled();
    });

    it("pins all checked addresses while retaining hostname and TLS authority", async () => {
        const response = await providerFetch(
            "https://api.example.com:8443/v1/models?q=1",
            { headers: { Authorization: "Bearer test-key" } },
        );
        await expect(response.json()).resolves.toEqual({ ok: true });
        const options = transport.mock.calls[0][0] as RequestOptions & {
            lookup: LookupFunction;
        };
        expect(options).toMatchObject({
            protocol: "https:",
            hostname: "api.example.com",
            port: "8443",
            path: "/v1/models?q=1",
            agent: false,
            headers: {
                host: "api.example.com:8443",
                authorization: "Bearer test-key",
            },
        });
        lookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
        const callback = vi.fn();
        options.lookup("api.example.com", { all: true }, callback);
        expect(callback).toHaveBeenLastCalledWith(null, [
            { address: "8.8.8.8", family: 4 },
            { address: "2606:4700:4700::1111", family: 6 },
        ]);
        options.lookup("api.example.com", { family: 6 }, callback);
        expect(callback).toHaveBeenLastCalledWith(
            null,
            "2606:4700:4700::1111",
            6,
        );
        expect(lookup).toHaveBeenCalledTimes(1);
    });

    it.each([
        301, 302, 303, 307, 308,
    ])("refuses HTTP %i redirects", async (redirectStatus) => {
        status = redirectStatus;
        responseHeaders.push("Location", "http://169.254.169.254/latest");
        await expect(
            providerFetch("https://api.example.com/v1/models"),
        ).rejects.toThrow("redirects are not allowed");
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it("supports SDK chat and embedding calls with the guarded transport", async () => {
        const client = new OpenAI({
            apiKey: "test-key",
            baseURL: "https://api.example.com/v1",
            fetch: providerFetch,
            maxRetries: 0,
        });
        responseBody = Buffer.from(
            '{"choices":[{"message":{"content":"test reply"}}]}',
        );
        const chat = await client.chat.completions.create({
            model: "example",
            messages: [{ role: "user", content: "Český vstup" }],
        });
        expect(chat.choices[0]?.message.content).toBe("test reply");
        expect(
            Number(transport.mock.calls[0][0].headers["content-length"]),
        ).toBe(Buffer.concat(sent).byteLength);
        responseBody = Buffer.from('{"data":[{"embedding":[0.1,0.2]}]}');
        const embedded = await client.embeddings.create({
            model: "example",
            input: "test input",
            encoding_format: "float",
        });
        expect(embedded.data[0]?.embedding).toEqual([0.1, 0.2]);
        expect(lookup).toHaveBeenCalledTimes(2);
        expect(transport.mock.calls.map(([options]) => options.path)).toEqual([
            "/v1/chat/completions",
            "/v1/embeddings",
        ]);
    });

    it("serializes multipart uploads and preserves the boundary", async () => {
        const form = new FormData();
        form.set(
            "file",
            new File(["audio-content"], "sample.wav", { type: "audio/wav" }),
        );
        const response = await providerFetch(
            "https://api.example.com/v1/audio/transcriptions",
            { method: "POST", body: form },
        );
        await response.text();
        expect(transport.mock.calls[0][0].headers["content-type"]).toMatch(
            /^multipart\/form-data; boundary=/,
        );
        expect(Buffer.concat(sent).toString()).toContain("audio-content");
        expect(Buffer.concat(sent).toString()).toContain(
            'filename="sample.wav"',
        );
        expect(
            Number(transport.mock.calls[0][0].headers["content-length"]),
        ).toBe(Buffer.concat(sent).byteLength);
    });

    it("escapes multipart field and file names without injecting headers", async () => {
        const form = new FormData();
        form.append('config"\nname', "first\nsecond\rthird");
        form.append(
            "file",
            new File(["audio"], 'sample"\r\nX-Injected.wav', {
                type: "audio/wav",
            }),
        );
        await (
            await providerFetch("https://api.example.com/v2/jobs", {
                method: "POST",
                body: form,
            })
        ).text();
        const body = Buffer.concat(sent).toString();
        expect(body).toContain('name="config%22%0D%0Aname"');
        expect(body).toContain('filename="sample%22%0D%0AX-Injected.wav"');
        expect(body).toContain("first\r\nsecond\r\nthird");
        expect(body).not.toContain("\r\nX-Injected");
        expect(
            Number(transport.mock.calls[0][0].headers["content-length"]),
        ).toBe(Buffer.concat(sent).byteLength);
    });

    it("streams SDK transcription multipart through the guarded transport", async () => {
        const client = new OpenAI({
            apiKey: "test-key",
            baseURL: "https://api.example.com/v1",
            fetch: providerFetch,
            maxRetries: 0,
        });
        responseBody = Buffer.from('{"text":"test transcript"}');
        const result = await client.audio.transcriptions.create({
            model: "example",
            file: new File(["audio"], "sample.wav"),
        });
        expect(result.text).toBe("test transcript");
        expect(transport.mock.calls[0][0].path).toBe(
            "/v1/audio/transcriptions",
        );
        expect(Buffer.concat(sent).toString()).toContain('name="model"');
        expect(Buffer.concat(sent).toString()).toContain(
            'filename="sample.wav"',
        );
        expect(lookup).toHaveBeenCalledTimes(1);
    });

    it("decodes a compressed streaming response", async () => {
        responseBody = gzipSync(responseBody);
        responseHeaders.push(
            "Content-Encoding",
            "gzip",
            "Content-Length",
            String(responseBody.length),
        );
        const response = await providerFetch(
            "https://api.example.com/v1/models",
        );
        await expect(response.json()).resolves.toEqual({ ok: true });
        expect(response.headers.has("content-encoding")).toBe(false);
    });

    it("honors cancellation before connection", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            providerFetch("https://api.example.com/v1/models", {
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(transport).not.toHaveBeenCalled();
    });
});

describe("self-host provider fetch", () => {
    it.each([
        "http://ollama:11434/v1/models",
        "http://192.168.1.10:1234/v1/models",
        "http://169.254.169.254",
        "http://[fd00:ec2::254]",
        "http://api.internal",
    ])("passes %s to native fetch without DNS or pinning", async (url) => {
        env.IS_HOSTED = false;
        const response = new Response("local response");
        const fetch = vi.fn().mockResolvedValue(response);
        vi.stubGlobal("fetch", fetch);
        const options = { redirect: "follow" as const };
        await expect(providerFetch(url, options)).resolves.toBe(response);
        expect(fetch).toHaveBeenCalledWith(url, options);
        expect(lookup).not.toHaveBeenCalled();
        expect(transport).not.toHaveBeenCalled();
    });
});
