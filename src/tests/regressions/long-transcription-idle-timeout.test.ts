/**
 * A two-hour recording failed to transcribe with ElevenLabs on a self-host
 * install: Bun's fetch closes a socket after five idle minutes, and Scribe
 * sends nothing until the whole transcript is ready. Every long provider
 * call must switch that timer off and leave the deadline to its own signal.
 */
import { OpenAI } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: { IS_HOSTED: false, WHISPER_REQUEST_TIMEOUT_MS: 3_600_000 },
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

import { providerFetch } from "@/lib/ai/provider-fetch";
import { elevenLabsTranscribe } from "@/lib/transcription/elevenlabs-transcribe";
import { geminiTranscribe } from "@/lib/transcription/gemini-transcribe";

function stubFetch(body: unknown) {
    const fetch = vi.fn(
        async () =>
            new Response(JSON.stringify(body), {
                headers: { "Content-Type": "application/json" },
            }),
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
}

function requestInit(fetch: ReturnType<typeof stubFetch>) {
    const calls = fetch.mock.calls as unknown as [unknown, RequestInit][];
    return calls.at(-1)?.[1];
}

afterEach(() => vi.unstubAllGlobals());

describe("long provider calls on Bun", () => {
    it("sends ElevenLabs Scribe without the socket idle timeout", async () => {
        const fetch = stubFetch({ text: "přepis", language_code: "ces" });
        await elevenLabsTranscribe({
            apiKey: "test-key",
            model: "scribe_v2+diarize",
            file: new File(["audio"], "workshop.m4a"),
        });
        expect(requestInit(fetch)).toMatchObject({
            timeout: false,
            signal: expect.any(AbortSignal),
        });
    });

    it("sends Gemini without the socket idle timeout", async () => {
        const fetch = stubFetch({
            candidates: [{ content: { parts: [{ text: "přepis" }] } }],
        });
        await geminiTranscribe({
            apiKey: "test-key",
            model: "gemini-test",
            audioBuffer: Buffer.from("audio"),
            contentType: "audio/mpeg",
        });
        expect(requestInit(fetch)).toMatchObject({
            timeout: false,
            signal: expect.any(AbortSignal),
        });
    });

    it("sends OpenAI SDK calls without the socket idle timeout", async () => {
        const fetch = stubFetch({ text: "přepis" });
        const client = new OpenAI({
            apiKey: "test-key",
            baseURL: "https://api.example.com/v1",
            fetch: providerFetch,
            maxRetries: 0,
        });
        await client.audio.transcriptions.create({
            model: "whisper-test",
            file: new File(["audio"], "workshop.m4a"),
        });
        expect(requestInit(fetch)).toMatchObject({
            timeout: false,
            signal: expect.any(AbortSignal),
        });
    });
});
