import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAI } from "openai";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { usageAttemptFetch, withUsageFailure } from "@/lib/ai/usage-attempt";
import { recordAiUsage } from "@/lib/ai/usage-cost";

vi.mock("@/lib/env", () => ({
    env: { IS_HOSTED: false, WHISPER_REQUEST_TIMEOUT_MS: 60_000 },
}));
vi.mock("@/lib/ai/usage-cost", () => ({
    recordAiUsage: vi.fn().mockResolvedValue(undefined),
    recordChatCompletionUsage: vi.fn().mockResolvedValue(undefined),
}));

const requests: string[] = [];
const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ text: "hello" }));
    });
});
let baseURL = "";

beforeAll(async () => {
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());
beforeEach(() => {
    requests.length = 0;
    vi.clearAllMocks();
});

describe("usageAttemptFetch with SDK file uploads", () => {
    it("records no failed attempt for a successful upload", async () => {
        const openai = new OpenAI({
            fetch: usageAttemptFetch,
            apiKey: "test",
            baseURL,
            maxRetries: 0,
        });

        const result = await withUsageFailure(
            {
                recordingId: "item",
                ownerUserId: "owner",
                actorUserId: "actor",
                payerUserId: "payer",
                operation: "transcription",
                provider: "Example",
                model: "model",
            },
            () =>
                openai.audio.transcriptions.create({
                    file: new File([new Uint8Array([1, 2, 3])], "audio.mp3", {
                        type: "audio/mpeg",
                    }),
                    model: "model",
                }),
        );

        expect(result.text).toBe("hello");
        expect(requests).toEqual(["POST /v1/audio/transcriptions"]);
        expect(recordAiUsage).not.toHaveBeenCalled();
    });
});
