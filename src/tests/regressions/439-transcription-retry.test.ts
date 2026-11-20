import {
    createServer,
    type IncomingMessage,
    type RequestOptions,
    type Server,
} from "node:http";
import { PassThrough, Writable } from "node:stream";
import { OpenAI } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithoutIdleTimeout } from "@/lib/ai/provider-fetch";
import {
    createUsageAttemptFetch,
    createUsageFetch,
    withUsageFailure,
} from "@/lib/ai/usage-attempt";
import { recordAiUsage } from "@/lib/ai/usage-cost";
import { env } from "@/lib/env";
import { transcribeViaMynah } from "@/lib/hosted/transcription/mynah";
import { chatTranscribe } from "@/lib/transcription/chat-transcribe";
import { elevenLabsTranscribe } from "@/lib/transcription/elevenlabs-transcribe";
import { fetchTranscription } from "@/lib/transcription/fetch";
import { geminiTranscribe } from "@/lib/transcription/gemini-transcribe";
import { speechmaticsTranscribe } from "@/lib/transcription/speechmatics-transcribe";

const { lookup, httpsRequest } = vi.hoisted(() => ({
    lookup: vi.fn(),
    httpsRequest: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:https", () => ({ request: httpsRequest }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        WHISPER_REQUEST_TIMEOUT_MS: 120_000,
        MYNAH_BASE_URL: "https://mynah.example.com",
        MYNAH_SERVICE_TOKEN: "test",
    },
}));
vi.mock("@/lib/ai/usage-cost", () => ({
    recordAiUsage: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/hosted/billing/enforcement", () => ({
    reserveMynah: vi.fn(async () => ({
        reserved: true,
        userId: "actor",
        seconds: 60,
    })),
    commitMynahReservation: vi.fn(),
    releaseMynahReservation: vi.fn(),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(async () => ({
        getSignedUrl: async () => "https://example.com/audio",
    })),
}));

const url = "https://provider.example.com/transcribe";
const post = { method: "POST", body: "audio" };
const file = new File(["audio"], "sample.wav", { type: "audio/wav" });
const audio = {
    audioBuffer: Buffer.from("audio"),
    contentType: "audio/wav",
};
const usage = {
    ownerUserId: "owner",
    actorUserId: "actor",
    payerUserId: "payer",
    recordingId: "recording",
    operation: "transcription" as const,
    provider: "Example",
    model: "example",
};

function rateLimited(retryAfter?: string, cost?: number) {
    return Response.json(
        { error: { message: "Rate limited", usage: { cost } } },
        {
            status: 429,
            headers:
                retryAfter === undefined ? {} : { "Retry-After": retryAfter },
        },
    );
}

function nodeError(code: string) {
    return new TypeError("fetch failed", {
        cause: Object.assign(new Error("connection failure"), { code }),
    });
}

function bunError(code: string) {
    return Object.assign(new TypeError("connection failure"), { code });
}

function stubFetch(...outcomes: (Response | Error)[]) {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const outcome of outcomes) {
        if (outcome instanceof Error) fetch.mockRejectedValueOnce(outcome);
        else fetch.mockResolvedValueOnce(outcome);
    }
    vi.stubGlobal("fetch", fetch);
    return fetch;
}

function hostedResponse(statusCode: number, rawHeaders: string[]) {
    return (
        _options: RequestOptions,
        receive: (response: IncomingMessage) => void,
    ) =>
        Object.assign(
            new Writable({
                write(_chunk, _encoding, callback) {
                    callback();
                },
                final(callback) {
                    const incoming = Object.assign(new PassThrough(), {
                        statusCode,
                        rawHeaders,
                    });
                    receive(incoming as unknown as IncomingMessage);
                    incoming.end();
                    callback();
                },
            }),
            { setTimeout: vi.fn() },
        );
}

async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected a TCP listening address");
    }
    return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
    });
}

beforeEach(() => {
    env.IS_HOSTED = false;
    env.WHISPER_REQUEST_TIMEOUT_MS = 120_000;
    lookup.mockReset();
    httpsRequest.mockReset();
    vi.mocked(recordAiUsage).mockClear();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("transcription request retry timing", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });

    it.each([
        ["seconds", "3", 3_000],
        ["an HTTP date", "Thu, 01 Jan 2026 00:00:04 GMT", 4_000],
        ["seconds over the cap", "120", 30_000],
        ["a date over the cap", "Thu, 01 Jan 2026 00:01:00 GMT", 30_000],
        ["a malformed header", "invalid", 1_000],
    ])("honours Retry-After with %s", async (_kind, header, delay) => {
        const limited = rateLimited(header);
        const cancel = vi.spyOn(limited.body as ReadableStream, "cancel");
        const fetch = stubFetch(limited, new Response("ok"));
        const result = fetchTranscription(url, post);
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await (await result).text()).toBe("ok");
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(cancel).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[1][1]).toEqual(fetch.mock.calls[0][1]);
    });

    it("backs off for one then two seconds and returns the third 429 intact", async () => {
        const terminal = rateLimited();
        const fetch = stubFetch(rateLimited(), rateLimited(), terminal);
        const result = fetchTranscription(url, post);
        await vi.advanceTimersByTimeAsync(999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(fetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toBe(terminal);
        expect(await terminal.json()).toMatchObject({
            error: { message: "Rate limited" },
        });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("shares its retry budget across transport errors and rate limits", async () => {
        const terminal = bunError("ECONNRESET");
        const fetch = stubFetch(
            nodeError("ECONNREFUSED"),
            rateLimited(),
            terminal,
        );
        const result = expect(fetchTranscription(url, post)).rejects.toBe(
            terminal,
        );
        await vi.runAllTimersAsync();
        await result;
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it.each([
        ["Bun refused", bunError("ConnectionRefused"), 6_000],
        ["Node refused", nodeError("ECONNREFUSED"), 6_000],
        ["Bun unresolved", bunError("ENOTFOUND"), 6_000],
        ["Node unresolved", nodeError("ENOTFOUND"), 6_000],
        ["Bun reset", bunError("ECONNRESET"), 4_999],
        ["Node reset", nodeError("ECONNRESET"), 4_999],
        ["Node closed socket", nodeError("UND_ERR_SOCKET"), 4_999],
        [
            "hosted reset",
            Object.assign(new Error("reset"), { code: "ECONNRESET" }),
            4_999,
        ],
    ] as const)("retries %s raised before a response", async (_kind, error, elapsed) => {
        const fetch = stubFetch();
        fetch
            .mockImplementationOnce(
                () =>
                    new Promise((_resolve, reject) =>
                        setTimeout(() => reject(error), elapsed),
                    ),
            )
            .mockResolvedValueOnce(new Response("ok"));
        const result = fetchTranscription(url, post);
        await vi.advanceTimersByTimeAsync(elapsed + 999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect((await result).ok).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it.each([
        ["Bun reset", bunError("ECONNRESET")],
        ["Node reset", nodeError("ECONNRESET")],
        ["Node closed socket", nodeError("UND_ERR_SOCKET")],
    ])("does not retry %s at the five-second cutoff", async (_kind, error) => {
        const fetch = stubFetch();
        fetch.mockImplementation(
            () =>
                new Promise((_resolve, reject) =>
                    setTimeout(() => reject(error), 5_000),
                ),
        );
        const result = expect(fetchTranscription(url, post)).rejects.toBe(
            error,
        );
        await vi.runAllTimersAsync();
        await result;
        expect(fetch).toHaveBeenCalledOnce();
    });
});

describe("transcription failures that are not replayed", () => {
    it.each([
        400, 401, 403, 404, 408, 413, 422, 500, 502, 503, 504, 524,
    ])("returns HTTP %i after one attempt", async (status) => {
        const response = new Response("failure", { status });
        const fetch = stubFetch(response);
        expect(await fetchTranscription(url, post)).toBe(response);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it.each([
        ["timeout", new DOMException("timed out", "TimeoutError")],
        ["abort", new DOMException("aborted", "AbortError")],
        ["connect timeout", nodeError("UND_ERR_CONNECT_TIMEOUT")],
        ["OS timeout", bunError("ETIMEDOUT")],
        ["unknown error", nodeError("UNKNOWN")],
        [
            "Node's blocked port 1 error",
            new TypeError("fetch failed", { cause: new Error("bad port") }),
        ],
    ])("rethrows %s after one attempt", async (_kind, error) => {
        const fetch = stubFetch(error);
        await expect(fetchTranscription(url, post)).rejects.toBe(error);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it("does not retry an error from a response body", async () => {
        const error = bunError("ECONNRESET");
        const response = new Response(
            new ReadableStream({
                start(controller) {
                    controller.error(error);
                },
            }),
        );
        const fetch = stubFetch(response);
        await expect((await fetchTranscription(url, post)).text()).rejects.toBe(
            error,
        );
        expect(fetch).toHaveBeenCalledOnce();
    });

    it.each([
        [
            "ReadableStream",
            () =>
                [url, { ...post, body: new Blob(["audio"]).stream() }] as const,
        ],
        [
            "async iterable",
            () => {
                async function* body() {
                    yield Buffer.from("audio");
                }
                return [
                    url,
                    { ...post, body: body() as unknown as BodyInit },
                ] as const;
            },
        ],
        [
            "Request with a body",
            () => [new Request(url, post), undefined] as const,
        ],
    ] as const)("does not replay a %s", async (_kind, request) => {
        const response = rateLimited("0");
        const fetch = stubFetch(response);
        const [input, init] = request();
        expect(await fetchTranscription(input, init)).toBe(response);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it("keeps the original deadline while waiting for a retry", async () => {
        env.WHISPER_REQUEST_TIMEOUT_MS = 50;
        const fetch = stubFetch(rateLimited("10"));
        await expect(fetchTranscription(url, post)).rejects.toMatchObject({
            name: "TimeoutError",
        });
        expect(fetch).toHaveBeenCalledOnce();
    });

    it("retains the deadline after a retry has received headers", async () => {
        env.WHISPER_REQUEST_TIMEOUT_MS = 100;
        const fetch = stubFetch(rateLimited("0"));
        fetch.mockImplementationOnce(
            async (_input, init) =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            const signal = init?.signal;
                            signal?.addEventListener(
                                "abort",
                                () => controller.error(signal.reason),
                                { once: true },
                            );
                        },
                    }),
                ),
        );
        await expect(
            (await fetchTranscription(url, post)).text(),
        ).rejects.toMatchObject({
            name: "TimeoutError",
        });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[1][1]?.signal).toBe(
            fetch.mock.calls[0][1]?.signal,
        );
    });

    it.each([
        true,
        false,
    ])("cancels backoff using the caller signal (embedded in a Request %s)", async (embedded) => {
        vi.useFakeTimers();
        const fetch = stubFetch(rateLimited("10"));
        const controller = new AbortController();
        const options = { signal: controller.signal };
        const pending = fetchTranscription(
            embedded ? new Request(url, options) : url,
            embedded ? undefined : { ...post, ...options },
        );
        const result = expect(pending).rejects.toMatchObject({
            name: "AbortError",
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledOnce();
        controller.abort();
        await result;
        expect(vi.getTimerCount()).toBe(0);
        expect(fetch).toHaveBeenCalledOnce();
    });
});

describe("transcription retries through the provider guard", () => {
    it("rechecks the URL scheme when a retry starts", async () => {
        const target = new URL(url);
        const fetch = stubFetch();
        fetch.mockImplementationOnce(async () => {
            target.href = "file:///tmp/example";
            return rateLimited("0");
        });
        await expect(fetchTranscription(target, post)).rejects.toMatchObject({
            code: "INVALID_INPUT",
            statusCode: 400,
        });
        expect(fetch).toHaveBeenCalledOnce();
    });

    it("re-resolves hosted destinations and checks each DNS answer", async () => {
        env.IS_HOSTED = true;
        lookup
            .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
            .mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
        httpsRequest.mockImplementationOnce(
            hostedResponse(429, ["Retry-After", "0"]),
        );
        await expect(fetchTranscription(url, post)).rejects.toMatchObject({
            code: "INVALID_INPUT",
            statusCode: 400,
        });
        expect(lookup).toHaveBeenCalledTimes(2);
        expect(httpsRequest).toHaveBeenCalledOnce();
    });

    it("refuses a redirect returned by a hosted retry", async () => {
        env.IS_HOSTED = true;
        lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
        httpsRequest
            .mockImplementationOnce(hostedResponse(429, ["Retry-After", "0"]))
            .mockImplementationOnce(
                hostedResponse(307, ["Location", "http://10.0.0.1"]),
            );
        await expect(fetchTranscription(url, post)).rejects.toThrow(
            "redirects are not allowed",
        );
        expect(lookup).toHaveBeenCalledTimes(2);
        expect(httpsRequest).toHaveBeenCalledTimes(2);
    });

    it("replays the original self-host upload when a redirect target refuses the connection", async () => {
        let location: string;
        const uploads: { method: string | undefined; body: string }[] = [];
        const origin = createServer((request, response) => {
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
                body += chunk;
            });
            request.once("end", () => {
                uploads.push({ method: request.method, body });
                if (uploads.length === 1) {
                    response.writeHead(307, { Location: location }).end();
                } else {
                    response.end("ok");
                }
            });
        });
        const endpoint = await listen(origin);
        try {
            const redirectTarget = createServer();
            location = await listen(redirectTarget);
            await close(redirectTarget);

            const response = await fetchTranscription(endpoint, post);
            expect(await response.text()).toBe("ok");
            expect(uploads).toEqual([post, post]);
        } finally {
            await close(origin);
        }
    });

    it("enforces the deadline while hosted DNS resolution is pending", async () => {
        env.IS_HOSTED = true;
        env.WHISPER_REQUEST_TIMEOUT_MS = 50;
        const pendingLookup = Promise.withResolvers<unknown>();
        lookup.mockReturnValueOnce(pendingLookup.promise);
        await expect(fetchTranscription(url, post)).rejects.toMatchObject({
            name: "TimeoutError",
        });
        pendingLookup.resolve([{ address: "8.8.8.8", family: 4 }]);
        await new Promise((resolve) => setImmediate(resolve));
        expect(lookup).toHaveBeenCalledOnce();
        expect(httpsRequest).not.toHaveBeenCalled();
    });
});

describe("transcription adapters and usage tracking", () => {
    function sdkClient() {
        return new OpenAI({
            apiKey: "test",
            baseURL: "https://provider.example.com/v1",
            maxRetries: 0,
            fetch: createUsageAttemptFetch(fetchTranscription),
        });
    }

    it("replays the SDK multipart upload and records only the completed transcription", async () => {
        const fetch = stubFetch(
            rateLimited("0"),
            Response.json({ text: "test transcript" }),
        );
        await withUsageFailure(usage, async () => {
            const result = await sdkClient().audio.transcriptions.create({
                file,
                model: "whisper-1",
            });
            expect(result.text).toBe("test transcript");
            await recordAiUsage(usage, { audioSeconds: 60 });
        });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[0][1]?.body).toBeInstanceOf(FormData);
        expect(fetch.mock.calls[1][1]?.body).toBe(fetch.mock.calls[0][1]?.body);
        expect(recordAiUsage).toHaveBeenCalledExactlyOnceWith(usage, {
            audioSeconds: 60,
        });
    });

    it("records the terminal 429 and its reported usage once", async () => {
        const fetch = stubFetch(
            rateLimited("0"),
            rateLimited("0"),
            rateLimited("0", 12),
        );
        await expect(
            withUsageFailure(usage, () =>
                sdkClient().audio.transcriptions.create({
                    file,
                    model: "whisper-1",
                }),
            ),
        ).rejects.toMatchObject({ status: 429 });
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(recordAiUsage).toHaveBeenCalledExactlyOnceWith(
            usage,
            expect.objectContaining({ outcome: "failed", reportedCostUsd: 12 }),
        );
    });

    it("records an exhausted connection failure only once", async () => {
        vi.useFakeTimers();
        const fetch = stubFetch(
            bunError("ENOTFOUND"),
            bunError("ENOTFOUND"),
            bunError("ENOTFOUND"),
        );
        const result = expect(
            withUsageFailure(usage, () =>
                sdkClient().audio.transcriptions.create({
                    file,
                    model: "whisper-1",
                }),
            ),
        ).rejects.toBeInstanceOf(OpenAI.APIConnectionError);
        await vi.runAllTimersAsync();
        await result;
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(recordAiUsage).toHaveBeenCalledExactlyOnceWith(
            usage,
            expect.objectContaining({ outcome: "failed" }),
        );
    });

    it("retries a chat transcription's JSON request", async () => {
        const fetch = stubFetch(
            rateLimited("0"),
            Response.json({
                choices: [{ message: { content: "test transcript" } }],
            }),
        );
        const result = await chatTranscribe({
            ...audio,
            model: "example",
            client: sdkClient(),
        });
        expect(result.text).toBe("test transcript");
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[1][1]?.body).toBe(fetch.mock.calls[0][1]?.body);
    });

    it("retries a hosted Gemini rate limit through its native fetch transport", async () => {
        env.IS_HOSTED = true;
        const fetch = stubFetch(
            rateLimited("0"),
            Response.json({
                candidates: [
                    { content: { parts: [{ text: "test transcript" }] } },
                ],
            }),
        );
        const result = await geminiTranscribe({
            ...audio,
            model: "gemini-example",
            apiKey: "test",
        });
        expect(result.text).toBe("test transcript");
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(lookup).not.toHaveBeenCalled();
        expect(httpsRequest).not.toHaveBeenCalled();
    });

    it("preserves TimeoutError when a hosted Gemini response body stalls", async () => {
        env.IS_HOSTED = true;
        env.WHISPER_REQUEST_TIMEOUT_MS = 1_000;
        const server = createServer((request, response) => {
            request.resume();
            response.writeHead(200, { "Content-Type": "application/json" });
            response.write('{"candidates":');
        });
        const endpoint = await listen(server);
        const nativeFetch = globalThis.fetch;
        let receivedHeaders = false;
        const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
            const response = await nativeFetch(endpoint, init);
            receivedHeaders = response.ok;
            return response;
        });
        vi.stubGlobal("fetch", fetch);

        try {
            await expect(
                geminiTranscribe({
                    ...audio,
                    model: "gemini-example",
                    apiKey: "test",
                }),
            ).rejects.toMatchObject({ name: "TimeoutError" });
            expect(receivedHeaders).toBe(true);
            expect(fetch).toHaveBeenCalledOnce();
            expect(lookup).not.toHaveBeenCalled();
        } finally {
            await close(server);
        }
    });

    it("retries an ElevenLabs rate limit", async () => {
        const fetch = stubFetch(
            rateLimited("0"),
            Response.json({ text: "test transcript", language_code: "eng" }),
        );
        const result = await elevenLabsTranscribe({
            file,
            model: "scribe_v2",
            apiKey: "test",
        });
        expect(result.text).toBe("test transcript");
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("retries Speechmatics job creation but submits only one accepted job", async () => {
        const fetch = stubFetch(
            rateLimited("0"),
            Response.json({ id: "example" }, { status: 201 }),
            Response.json({ job: { status: "done" } }),
            Response.json({
                metadata: { transcription_config: { language: "en" } },
                results: [
                    { type: "word", alternatives: [{ content: "test" }] },
                ],
            }),
            new Response(null, { status: 204 }),
        );
        const result = await speechmaticsTranscribe({
            file,
            model: "enhanced",
            apiKey: "test",
        });
        expect(result.text).toBe("test");
        expect(
            fetch.mock.calls.map(([, init]) => init?.method ?? "GET"),
        ).toEqual(["POST", "POST", "GET", "GET", "DELETE"]);
    });

    it("keeps Mynah on its existing gateway retry and ledger path", async () => {
        env.IS_HOSTED = true;
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const fetch = stubFetch(
            new Response("gateway error", { status: 502 }),
            rateLimited("0"),
        );
        const result = expect(
            transcribeViaMynah({
                userId: "actor",
                storagePath: "audio.wav",
                durationMs: 60_000,
                fetch: createUsageFetch(usage, fetchWithoutIdleTimeout),
            }),
        ).rejects.toThrow("Mynah transcription failed (429)");
        await vi.runAllTimersAsync();
        await result;
        expect(fetch).toHaveBeenCalledTimes(2);
        const idempotencyKeys = fetch.mock.calls.map(([, init]) =>
            new Headers(init?.headers).get("idempotency-key"),
        );
        expect(idempotencyKeys[0]).toBeTruthy();
        expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
        expect(recordAiUsage).toHaveBeenCalledTimes(2);
    });
});
