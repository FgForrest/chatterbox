/**
 * Retrying a single provider call.
 *
 * The job worker retries whole jobs, minutes apart. That is the wrong
 * instrument for the most common failure by far: one rate-limited call out of
 * the three a multi-pass run makes. Retrying the job would re-run every pass,
 * paying again for the ones that already succeeded, and make the user wait
 * out a job-level backoff for all of them.
 *
 * So there is a second, much shorter retry around each call. These tests pin
 * the two halves of that: it retries what a wait can fix, and it does not
 * retry what a wait cannot -- because paying three times to discover the same
 * permanent failure is strictly worse than paying once.
 */

import type * as OpenAIModule from "openai";
import { APIError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    aiEnhancements,
    apiCredentials,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import type { LegacyProfileSettings } from "@/lib/profiles/seed";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import { summaryOutputTokens } from "@/lib/summary/summary-model";
import { resolvedAudioProfile } from "@/tests/profiles/seeded-profile-fixture";

// Without corrections a model reads the stored text as it is.
// Task proposals read and write the database; covered on their own.
// Mail's masking reads mail configuration; no mail is summarized here.
vi.mock("@/lib/mail/redact", () => ({
    maskedContentForModel: async (content: unknown) => content,
    secretAddressMasker: async () => (text: string) => text,
}));
vi.mock("@/lib/tasks/access", () => ({
    taskViewerById: vi.fn(async () => ({})),
}));
vi.mock("@/lib/tasks/proposals", () => ({
    loadTasksPromptContext: vi.fn(async () => ({ text: "", refs: new Map() })),
    resolveTaskProposals: vi.fn(async () => undefined),
}));

vi.mock("@/lib/learn/llm-input", () => ({
    modelInput: vi.fn(async (transcript: { text: string }) => ({
        text: transcript.text,
        turns: null,
        fingerprint: null,
    })),
    llmRendering: vi.fn(async () => null),
}));
// Organization curation is decided against verified access; these
// runs are on the private view.
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: vi.fn().mockResolvedValue(false),
    userCuratesOrganizationNow: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/org/config", () => ({
    isOrgScopeVisible: () => false,
    isOrgScopeEnabled: () => false,
    getOrgUserId: async () => null,
    assertOrgScopeWritable: () => {},
    isOrgAccount: async () => false,
    assertNotOrgAccount: async () => {},
}));

vi.mock("@/lib/ai/usage-cost", () => ({
    recordChatCompletionUsage: vi.fn(async () => undefined),
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
    env: { IS_HOSTED: false, ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: 60 },
}));

const { createMock, profileLegacy } = vi.hoisted(() => ({
    createMock: vi.fn(),
    profileLegacy: {
        current: {} as Partial<LegacyProfileSettings>,
    },
}));

vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: vi.fn(async () =>
        resolvedAudioProfile(profileLegacy.current),
    ),
}));
vi.mock("@/lib/pipeline/trigger", () => ({
    requestAdvanceInTx: vi.fn().mockResolvedValue(null),
}));

vi.mock("openai", async (importOriginal) => {
    const actual = await importOriginal<typeof OpenAIModule>();
    return {
        ...actual,
        OpenAI: class {
            chat = { completions: { create: createMock } };
        },
        default: class {
            chat = { completions: { create: createMock } };
        },
    };
});

vi.mock("@/lib/encryption", () => ({ decrypt: (v: string) => v }));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string) => v,
    encryptText: (v: string) => v,
    decryptJsonField: <T>(v: T) => v,
    encryptJsonField: <T>(v: T) => v,
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(async () => undefined),
}));

const selectResults = new Map<unknown, unknown[][]>();

function selectChain() {
    let table: unknown;
    const next = () => selectResults.get(table)?.shift() ?? [];
    const c = {
        from: (t: unknown) => {
            table = t;
            return c;
        },
        innerJoin: () => c,
        where: () => c,
        for: () => c,
        orderBy: () => c,
        limit: () => Promise.resolve(next()),
        // biome-ignore lint/suspicious/noThenProperty: mocks a thenable query builder
        then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve(next()).then(resolve),
    };
    return c;
}

const tx = {
    select: () => selectChain(),
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};

vi.mock("@/db", () => ({
    db: {
        select: () => selectChain(),
        transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
}));

function stage(
    settings: Record<string, unknown> = {},
    transcript = "a transcript",
    maxOutputTokens: number | null = null,
) {
    profileLegacy.current = settings;
    selectResults.set(recordings, [
        [{ id: "rec-1", userId: "user-1", deletedAt: null }],
        [{ deletedAt: null }],
    ]);
    selectResults.set(transcriptions, [
        [
            {
                recordingId: "rec-1",
                userId: "user-1",
                source: "riffado",
                text: transcript,
            },
        ],
    ]);
    selectResults.set(userSettings, [
        [{ summaryPrompt: null, aiOutputLanguage: null, ...settings }],
    ]);
    selectResults.set(apiCredentials, [
        [
            {
                apiKey: "enc-key",
                baseUrl: "",
                provider: "openai",
                defaultModel: "gpt-4o-mini",
                maxOutputTokens,
                isDefaultEnhancement: true,
                userId: "user-1",
            },
        ],
    ]);
    selectResults.set(aiEnhancements, [[]]);
}

function reply(
    content = '{"summary":"s","keyPoints":[],"actionItems":[]}',
    finishReason = "stop",
) {
    return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

function providerError(status: number, code?: string) {
    return new APIError(
        status,
        code ? { code, message: code } : { message: "boom" },
        undefined,
        undefined,
    );
}

/**
 * Run generation with the backoff waits skipped.
 *
 * The retries sleep on real timers, so without this the suite would spend
 * seconds asleep proving something about arithmetic that is already tested in
 * `jobs/backoff.test.ts`.
 */
async function generate(): Promise<unknown> {
    const promise = generateSummaryForRecording("user-1", "rec-1", {
        trigger: "manual",
    });
    // Settled either way; the caller decides which it expected.
    const settled = promise.then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
    );
    for (let i = 0; i < 12; i += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
    }
    return settled;
}

describe("per-call retry and repair inside summary generation", () => {
    beforeEach(() => {
        createMock.mockReset();
        selectResults.clear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("allows detailed minutes and structured tasks in every pass and merge", async () => {
        stage(
            { summaryMultiPass: true, summaryMultiPassRounds: 2 },
            "A long working discussion. ".repeat(1500),
        );
        createMock.mockResolvedValue(reply());
        const result = (await generate()) as { ok: boolean };
        expect(result.ok).toBe(true);
        expect(createMock).toHaveBeenCalledTimes(3);
        for (const [request] of createMock.mock.calls) {
            const prompt = createMock.mock.calls[0]?.[0].messages[1]
                .content as string;
            expect(request.max_tokens).toBe(summaryOutputTokens(prompt.length));
        }
    });

    it("gives short recordings the 4000-token pass and merge floor", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 2 });
        createMock.mockResolvedValue(reply());
        const result = (await generate()) as { ok: boolean };
        expect(result.ok).toBe(true);
        expect(
            createMock.mock.calls.map(([request]) => request.max_tokens),
        ).toEqual([4000, 4000, 4000]);
    });

    it("caps passes, the merge and its repair at the provider limit", async () => {
        stage(
            { summaryMultiPass: true, summaryMultiPassRounds: 2 },
            "A working discussion. ".repeat(3000),
            3500,
        );
        createMock
            .mockResolvedValueOnce(reply())
            .mockResolvedValueOnce(reply())
            .mockResolvedValueOnce(reply('{"summary":"unfinished"'))
            .mockResolvedValueOnce(reply());
        const result = (await generate()) as { ok: boolean };
        expect(result.ok).toBe(true);
        expect(
            createMock.mock.calls.map(([request]) => request.max_tokens),
        ).toEqual([3500, 3500, 3500, 3500]);
    });

    it("caps a single-pass repair and keeps a smaller pass allowance", async () => {
        stage({}, "a transcript", 5000);
        createMock
            .mockResolvedValueOnce(reply('{"summary":"unfinished"'))
            .mockResolvedValueOnce(reply());
        expect((await generate()) as { ok: boolean }).toMatchObject({
            ok: true,
        });
        expect(
            createMock.mock.calls.map(([request]) => request.max_tokens),
        ).toEqual([4000, 5000]);
    });

    it("bounds long pass and repair allowances at 16000", async () => {
        stage({}, "A working discussion. ".repeat(10000));
        createMock
            .mockResolvedValueOnce(reply('{"summary":"unfinished"'))
            .mockResolvedValueOnce(reply());
        expect((await generate()) as { ok: boolean }).toMatchObject({
            ok: true,
        });
        expect(
            createMock.mock.calls.map(([request]) => request.max_tokens),
        ).toEqual([16000, 16000]);
    });

    it("retries a rate-limited pass and succeeds on the next one", async () => {
        stage();
        createMock
            .mockRejectedValueOnce(providerError(429))
            .mockResolvedValue(reply());

        const result = (await generate()) as { ok: boolean };

        expect(result.ok).toBe(true);
        expect(createMock).toHaveBeenCalledTimes(2);
    });

    it("retries a provider outage", async () => {
        stage();
        createMock
            .mockRejectedValueOnce(providerError(503))
            .mockRejectedValueOnce(providerError(503))
            .mockResolvedValue(reply());

        const result = (await generate()) as { ok: boolean };

        expect(result.ok).toBe(true);
        expect(createMock).toHaveBeenCalledTimes(3);
    });

    it("repairs invalid JSON through a follow-up conversation", async () => {
        stage({}, "A long working discussion. ".repeat(1500));
        const invalid = '{"summary":"unfinished"';
        createMock
            .mockResolvedValueOnce(reply(invalid))
            .mockResolvedValueOnce(
                reply('{"summary":"repaired","keyPoints":[],"actionItems":[]}'),
            );

        const result = (await generate()) as {
            ok: boolean;
            value?: { summary: string };
        };

        expect(result.ok).toBe(true);
        expect(result.value?.summary).toBe("repaired");
        expect(createMock).toHaveBeenCalledTimes(2);

        const repairRequest = createMock.mock.calls[1]?.[0] as {
            messages: Array<{ role: string; content: string }>;
            max_tokens: number;
        };
        expect(repairRequest.messages).toHaveLength(3);
        expect(repairRequest.messages[1]).toEqual({
            role: "assistant",
            content: invalid,
        });
        expect(repairRequest.messages[2]?.content).toContain("JSON.parse");
        expect(repairRequest.messages[2]?.content).toContain("position");
        expect(JSON.stringify(repairRequest.messages)).not.toContain(
            "a transcript",
        );
        const passTokens = createMock.mock.calls[0]?.[0].max_tokens as number;
        expect(repairRequest.max_tokens).toBe(
            Math.min(16000, Math.ceil(passTokens * 1.5)),
        );
    });

    it("repairs an invalid merge instead of degrading the run", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 3 });
        createMock
            .mockResolvedValueOnce(reply())
            .mockResolvedValueOnce(reply())
            .mockResolvedValueOnce(reply())
            .mockResolvedValueOnce(reply('{"summary":"unfinished"'))
            .mockResolvedValueOnce(
                reply('{"summary":"merged","keyPoints":[],"actionItems":[]}'),
            );

        const result = (await generate()) as {
            ok: boolean;
            value?: {
                summary: string;
                multiPass?: { merged: boolean; passesUsed: number };
            };
        };

        expect(result.ok).toBe(true);
        expect(result.value?.summary).toBe("merged");
        expect(result.value?.multiPass).toMatchObject({
            merged: true,
            passesUsed: 3,
        });
        expect(createMock).toHaveBeenCalledTimes(5);
    });

    it("surfaces the existing context error only after the 2000-token fallback fails", async () => {
        stage();
        createMock.mockRejectedValue(
            providerError(400, "context_length_exceeded"),
        );

        const result = (await generate()) as { ok: boolean };

        expect(result.ok).toBe(false);
        expect(
            createMock.mock.calls.map(([request]) => request.max_tokens),
        ).toEqual([4000, 2000]);
        expect(result).toMatchObject({
            error: expect.objectContaining({
                code: "context_length_exceeded",
            }),
        });
    });

    it.each([
        "code",
        "message",
    ])("retries a context-rejected pass once at 2000 and logs only allowances (%s)", async (kind) => {
        stage({}, "private transcript marker");
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        createMock
            .mockRejectedValueOnce(
                kind === "code"
                    ? providerError(400, "context_length_exceeded")
                    : new APIError(
                          400,
                          { message: "Maximum context length is 8192 tokens" },
                          undefined,
                          undefined,
                      ),
            )
            .mockResolvedValueOnce(reply());
        expect(await generate()).toMatchObject({ ok: true });
        expect(
            createMock.mock.calls.map(([request]) => request.max_tokens),
        ).toEqual([4000, 2000]);
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining(
                "4000 output tokens; retrying once with 2000",
            ),
        );
        expect(JSON.stringify(warning.mock.calls)).not.toContain(
            "private transcript marker",
        );
    });

    it("does not retry context errors when the provider cap already limits the request to 2000", async () => {
        stage({}, "a transcript", 2000);
        createMock.mockRejectedValue(
            providerError(400, "context_length_exceeded"),
        );
        expect(await generate()).toMatchObject({ ok: false });
        expect(createMock).toHaveBeenCalledTimes(1);
        expect(createMock.mock.calls[0]?.[0].max_tokens).toBe(2000);
    });

    it("falls back once on a context-rejected merge", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 2 });
        createMock
            .mockResolvedValueOnce(reply())
            .mockResolvedValueOnce(reply())
            .mockRejectedValueOnce(
                providerError(400, "context_length_exceeded"),
            )
            .mockResolvedValueOnce(reply());
        expect(await generate()).toMatchObject({
            ok: true,
            value: { multiPass: { merged: true } },
        });
        expect(
            createMock.mock.calls.map(([request]) => request.max_tokens),
        ).toEqual([4000, 4000, 4000, 2000]);
    });

    it("falls back once on a context-rejected repair", async () => {
        stage();
        createMock
            .mockResolvedValueOnce(reply('{"summary":"unfinished"'))
            .mockRejectedValueOnce(
                providerError(400, "context_length_exceeded"),
            )
            .mockResolvedValueOnce(reply());
        expect(await generate()).toMatchObject({ ok: true });
        expect(
            createMock.mock.calls.map(([request]) => request.max_tokens),
        ).toEqual([4000, 6000, 2000]);
    });

    it("sizes a repair from the effective allowance after a context fallback", async () => {
        stage();
        createMock
            .mockRejectedValueOnce(
                providerError(400, "context_length_exceeded"),
            )
            .mockResolvedValueOnce(reply('{"summary":"unfinished"', "length"))
            .mockResolvedValueOnce(reply());
        expect(await generate()).toMatchObject({ ok: true });
        expect(
            createMock.mock.calls.map(([request]) => request.max_tokens),
        ).toEqual([4000, 2000, 3000]);
    });

    it.each([
        "provider cap",
        "ceiling",
    ] as const)("skips an impossible length repair at the %s", async (limit) => {
        stage(
            {},
            limit === "ceiling"
                ? "Long working discussion. ".repeat(10000)
                : "a transcript",
            limit === "provider cap" ? 3500 : null,
        );
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        createMock.mockResolvedValue(
            reply('{"summary":"unfinished"', "length"),
        );
        await generate();
        expect(createMock).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("reply was cut off by the output limit"),
        );
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("skipping repair"),
        );
    });

    it("repairs a length-truncated response when a larger allowance is available", async () => {
        stage();
        createMock
            .mockResolvedValueOnce(reply('{"summary":"unfinished"', "length"))
            .mockResolvedValueOnce(reply());
        expect(await generate()).toMatchObject({ ok: true });
        expect(
            createMock.mock.calls.map(([request]) => request.max_tokens),
        ).toEqual([4000, 6000]);
    });

    it("does not retry a provider that rejected the request", async () => {
        stage();
        createMock.mockRejectedValue(providerError(400));

        const result = (await generate()) as { ok: boolean };

        expect(result.ok).toBe(false);
        expect(createMock).toHaveBeenCalledTimes(1);
    });

    it("gives up after a bounded number of attempts", async () => {
        stage();
        createMock.mockRejectedValue(providerError(429));

        const result = (await generate()) as { ok: boolean };

        expect(result.ok).toBe(false);
        // Bounded on purpose: a provider that is genuinely down should not be
        // ground against, and the job-level retry covers the longer outage.
        expect(createMock).toHaveBeenCalledTimes(3);
    });

    it("retries each multi-pass pass on its own, not the whole run", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 3 });
        let calls = 0;
        createMock.mockImplementation(async () => {
            calls += 1;
            // Exactly one pass gets rate-limited, once.
            if (calls === 2) throw providerError(429);
            return reply();
        });

        const result = (await generate()) as { ok: boolean };

        expect(result.ok).toBe(true);
        // Three passes + one retry of the unlucky one + the merge. The two
        // passes that already succeeded are not re-run, which is the entire
        // reason this retry sits here rather than at the job level.
        expect(createMock).toHaveBeenCalledTimes(5);
    });

    it("still degrades when one pass exhausts its retries", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 3 });
        let started = 0;
        createMock.mockImplementation(async () => {
            started += 1;
            // The second pass to start fails every time it is tried.
            if (started % 3 === 2) throw providerError(503);
            return reply();
        });

        const result = (await generate()) as {
            ok: boolean;
            value?: { multiPass?: { passesUsed: number } };
        };

        // A pass that runs out of attempts is dropped and the rest are
        // merged, rather than failing a run that has usable output.
        expect(result.ok).toBe(true);
        expect(result.value?.multiPass?.passesUsed).toBeGreaterThanOrEqual(1);
    });
});

describe("summary output scaling", () => {
    it.each([
        [0, 4000],
        [12000, 4000],
        [24000, 4000],
        [24001, 4001],
        [30000, 5000],
        [60000, 10000],
        [96000, 16000],
        [500000, 16000],
    ])("allows %i prompt characters %i tokens", (chars, tokens) => {
        expect(summaryOutputTokens(chars)).toBe(tokens);
    });
});
