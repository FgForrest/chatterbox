/**
 * Detecting topics end to end, with the provider and the database stubbed.
 *
 * What matters: the model is shown times and its answer is snapped back to
 * them; a transcript without timings is refused before anything is paid for;
 * and topics are written only onto the transcript they were read from.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    apiCredentials,
    recordings,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { ErrorCode } from "@/lib/errors";
import { resolvedAudioProfile } from "@/tests/profiles/seeded-profile-fixture";

// Without corrections a model reads the stored turns as they are.
vi.mock("@/lib/learn/llm-input", () => ({
    modelInput: vi.fn(async (transcript: { text: string }) => ({
        text: transcript.text,
        turns: null,
        fingerprint: "input-fingerprint",
    })),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile,
}));
vi.mock("@/lib/env", () => ({
    env: { IS_HOSTED: false, ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: 60 },
}));

const {
    createMock,
    curatesNow,
    markSummaryStepDoneInTx,
    resolveItemProfile,
    runAsCurator,
} = vi.hoisted(() => ({
    createMock: vi.fn(),
    curatesNow: vi.fn(),
    markSummaryStepDoneInTx: vi.fn(),
    resolveItemProfile: vi.fn(),
    runAsCurator: { value: false },
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: curatesNow,
}));
vi.mock("@/lib/pipeline/state", () => ({ markSummaryStepDoneInTx }));

vi.mock("openai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("openai")>();
    return {
        ...actual,
        OpenAI: class {
            chat = { completions: { create: createMock } };
        },
    };
});

vi.mock("@/lib/encryption", () => ({ decrypt: (v: string) => v }));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string) => v,
    decryptJsonField: <T>(v: T) => v,
    encryptJsonField: <T>(v: T) => ({ encrypted: v }),
}));

const selectResults = new Map<unknown, unknown[][]>();
const writes: { set: Record<string, unknown> }[] = [];
let writeMatches = true;

function selectChain() {
    let table: unknown;
    const next = () => selectResults.get(table)?.shift() ?? [];
    const c = {
        from: (t: unknown) => {
            table = t;
            return c;
        },
        where: () => c,
        limit: () => Promise.resolve(next()),
        for: () =>
            Promise.resolve(table === recordings ? [{ id: "rec-1" }] : next()),
        // biome-ignore lint/suspicious/noThenProperty: mocks a thenable query builder
        then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve(next()).then(resolve),
    };
    return c;
}

vi.mock("@/db", () => {
    const update = () => ({
        set: (set: Record<string, unknown>) => ({
            where: () => ({
                returning: async () => {
                    writes.push({ set });
                    return writeMatches ? [{ id: "tr-1" }] : [];
                },
            }),
        }),
    });
    const tx = { select: () => selectChain(), update };
    return {
        db: {
            select: () => selectChain(),
            update,
            transaction: <T>(run: (transaction: typeof tx) => Promise<T>) =>
                run(tx),
        },
    };
});
// Sharing is tested against a real database (`src/tests/sharing/`); here
// every run is the owner's, on the private view.
vi.mock("@/lib/sharing/run-context", () => ({
    resolveRunContext: async (actorUserId: string) => ({
        view: runAsCurator.value ? "org" : "private",
        actsForOrganization: runAsCurator.value,
        actorUserId,
        ownerUserId: actorUserId,
        contentUserId: actorUserId,
        settingsUserId: actorUserId,
    }),
}));
// Sharing is tested against a real database (`src/tests/sharing/`).
vi.mock("@/lib/sharing/writer", () => ({
    contentWriterRefusal: async (
        _tx: unknown,
        input: { actsForOrganization?: boolean },
    ) => (runAsCurator.value && !input.actsForOrganization ? "shared" : null),
    contentWriterRefusalNow: async () => null,
    sharingOrgUserId: async () => null,
    writerRefusalError: () => new Error("refused"),
}));

import { generateTopicsForTranscript } from "@/lib/topics/generate-topics";

const TURNS = [
    {
        speaker: "speaker_0",
        startMs: 18_000,
        endMs: 60_000,
        text: "Objednala jsem jízdenku.",
    },
    {
        speaker: "speaker_1",
        startMs: 67_000,
        endMs: 200_000,
        text: "A datum bylo špatně.",
    },
    {
        speaker: "speaker_0",
        startMs: 222_000,
        endMs: 300_000,
        text: "Pak přišla kontrola.",
    },
];

function stage(
    turns: unknown = TURNS,
    stored?: { topics: unknown; topicsInputFingerprint: string | null },
    confirmedLanguage: string | null = null,
) {
    const transcript = {
        id: "tr-1",
        revision: 7,
        text: "ciphertext",
        turns,
        detectedLanguage: "cs",
        topics: stored?.topics ?? null,
        topicsInputFingerprint: stored?.topicsInputFingerprint ?? null,
    };
    selectResults.set(recordings, [[{ id: "rec-1", confirmedLanguage }]]);
    selectResults.set(transcriptions, [[transcript], [transcript]]);
    selectResults.set(users, [[{ uiLocale: "cs-CZ" }]]);
    selectResults.set(userSettings, [
        [{ topicPrompt: null, aiOutputLanguage: null }],
        [{ defaultProviders: null }],
    ]);
    selectResults.set(apiCredentials, [
        [
            {
                apiKey: "key",
                baseUrl: "",
                provider: "openai",
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            },
        ],
    ]);
}

function reply(content: string) {
    createMock.mockResolvedValueOnce({ choices: [{ message: { content } }] });
}

const run = () =>
    generateTopicsForTranscript("user-1", "rec-1", "plaud", {
        trigger: "manual",
    });
const runAutomatic = () =>
    generateTopicsForTranscript("user-1", "rec-1", "plaud", {
        trigger: "auto",
    });

describe("generateTopicsForTranscript", () => {
    beforeEach(() => {
        selectResults.clear();
        writes.length = 0;
        writeMatches = true;
        runAsCurator.value = false;
        curatesNow.mockReset().mockResolvedValue(true);
        markSummaryStepDoneInTx.mockReset();
        const profile = resolvedAudioProfile();
        profile.settings.steps.topics.automatic = false;
        resolveItemProfile.mockReset().mockResolvedValue(profile);
    });
    afterEach(() => {
        createMock.mockReset();
    });

    it.each([
        false,
        true,
    ])("uses the same confirmed language on topics (Organization=%s)", async (organization) => {
        stage(TURNS, undefined, "cs");
        runAsCurator.value = organization;
        reply(
            JSON.stringify({ topics: [{ start: "00:18", title: "Jízdenka" }] }),
        );
        await run();
        expect(createMock.mock.calls[0]?.[0].messages[0].content).toContain(
            "Write all natural-language output in Czech",
        );
    });

    it("explicit topics output wins over the confirmed language", async () => {
        stage(TURNS, undefined, "cs");
        const profile = resolvedAudioProfile();
        profile.settings.steps.summary.outputLanguage = "en";
        resolveItemProfile.mockResolvedValue(profile);
        reply(
            JSON.stringify({ topics: [{ start: "00:18", title: "Ticket" }] }),
        );
        await run();
        expect(createMock.mock.calls[0]?.[0].messages[0].content).toContain(
            "Write all natural-language output in English",
        );
    });

    it("runs manual topics when automatic topics are off", async () => {
        stage();
        reply(
            JSON.stringify({
                topics: [
                    { start: "00:18", title: "Objednání jízdenky" },
                    // Misquoted by a few seconds.
                    { start: "01:09", title: "Špatné datum" },
                    { start: "03:42", title: "Kontrola ve vlaku" },
                ],
            }),
        );

        const result = await run();

        const [{ messages }] = createMock.mock.calls[0];
        expect(messages[0].content).toContain('"start" must be copied exactly');
        expect(messages[1].content).toContain(
            "[00:18] Speaker 0: Objednala jsem jízdenku.",
        );
        expect(messages[1].content).toContain("[01:07] Speaker 1:");

        expect(result.topics).toEqual([
            { title: "Objednání jízdenky", fromMs: 18_000, toMs: 67_000 },
            { title: "Špatné datum", fromMs: 67_000, toMs: 222_000 },
            { title: "Kontrola ve vlaku", fromMs: 222_000, toMs: 300_000 },
        ]);
        expect(writes).toHaveLength(1);
        expect(writes[0].set.topics).toMatchObject({
            encrypted: {
                topics: result.topics,
                templateId: "default",
                profileRevisionId: "seeded-profile-revision",
                outputLanguage: "auto",
                promptTemplate: expect.any(String),
            },
        });
        expect(writes[0].set).not.toHaveProperty("profileRevisionId");
        expect(writes[0].set).not.toHaveProperty("builtinPromptsVersion");
        expect(writes[0].set).not.toHaveProperty("payerUserId");
        expect(writes[0].set).not.toHaveProperty("inputs");
        expect(markSummaryStepDoneInTx).not.toHaveBeenCalled();
        expect(createMock.mock.calls[0]?.[0].messages[0].content).toContain(
            "the language the transcription is predominantly spoken in",
        );
    });

    it("reuses a matching manual run for the automatic topics step", async () => {
        stage();
        reply(
            JSON.stringify({
                topics: [{ start: "00:18", title: "Objednání jízdenky" }],
            }),
        );
        const manual = await run();
        const stored = writes[0]?.set.topics as {
            encrypted: unknown;
        };

        stage(TURNS, {
            topics: stored.encrypted,
            topicsInputFingerprint: "input-fingerprint",
        });
        const automatic = await runAutomatic();

        expect(automatic.topics).toEqual(manual.topics);
        expect(createMock).toHaveBeenCalledOnce();
        expect(markSummaryStepDoneInTx).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                itemId: "rec-1",
                step: "topics",
            }),
        );
    });

    it("does not reuse a manual run made with another profile", async () => {
        const manualProfile = resolvedAudioProfile();
        manualProfile.revisionId = "manual-profile-revision";
        const automaticProfile = resolvedAudioProfile();
        resolveItemProfile
            .mockResolvedValueOnce(manualProfile)
            .mockResolvedValueOnce(automaticProfile);
        stage();
        reply(JSON.stringify({ topics: [{ start: "00:18", title: "A" }] }));
        await run();
        const stored = writes[0]?.set.topics as {
            encrypted: unknown;
        };

        stage(TURNS, {
            topics: stored.encrypted,
            topicsInputFingerprint: "input-fingerprint",
        });
        reply(JSON.stringify({ topics: [{ start: "00:18", title: "B" }] }));
        await runAutomatic();

        expect(createMock).toHaveBeenCalledTimes(2);
    });

    it("does not reuse a legacy topics payload without recipe fields", async () => {
        stage(TURNS, {
            topics: {
                topics: [
                    {
                        title: "Old topic",
                        fromMs: 18_000,
                        toMs: 300_000,
                    },
                ],
                provider: "openai",
                model: "gpt-4o-mini",
                templateId: "default",
                generatedAt: new Date(0).toISOString(),
            },
            topicsInputFingerprint: "input-fingerprint",
        });
        reply(JSON.stringify({ topics: [{ start: "00:18", title: "New" }] }));

        await runAutomatic();

        expect(createMock).toHaveBeenCalledOnce();
    });

    it("marks an automatic topics step done with its committed input", async () => {
        stage();
        reply(
            JSON.stringify({
                topics: [{ start: "00:18", title: "Objednání jízdenky" }],
            }),
        );

        await runAutomatic();

        expect(markSummaryStepDoneInTx).toHaveBeenCalledWith(
            expect.anything(),
            {
                itemId: "rec-1",
                userId: "user-1",
                view: "private",
                step: "topics",
                content: {
                    contentId: "tr-1",
                    contentSourceId: "plaud",
                    contentRevision: 7,
                },
                inputFingerprint: "input-fingerprint",
            },
        );
    });

    it("rechecks curation after the model finishes and refuses a revoked curator", async () => {
        stage();
        runAsCurator.value = true;
        createMock.mockImplementationOnce(async () => {
            curatesNow.mockResolvedValue(false);
            return {
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                topics: [{ start: "00:18", title: "A" }],
                            }),
                        },
                    },
                ],
            };
        });
        await expect(run()).rejects.toThrow("refused");
        expect(curatesNow).toHaveBeenCalledWith("user-1");
        expect(createMock).toHaveBeenCalledOnce();
        expect(writes).toHaveLength(0);
    });

    it("refuses a transcript without timings before calling the provider", async () => {
        stage(null);
        await expect(run()).rejects.toMatchObject({
            code: ErrorCode.INVALID_INPUT,
        });
        expect(createMock).not.toHaveBeenCalled();
        expect(writes).toHaveLength(0);
    });

    it("fails, writing nothing, when the reply holds no usable topics", async () => {
        stage();
        reply("I could not find any topics.");
        await expect(run()).rejects.toMatchObject({
            code: ErrorCode.AI_PROVIDER_API_ERROR,
        });
        expect(writes).toHaveLength(0);
    });

    it("reports a conflict when the transcript changed meanwhile", async () => {
        stage();
        reply(JSON.stringify({ topics: [{ start: "00:18", title: "A" }] }));
        writeMatches = false;
        await expect(run()).rejects.toMatchObject({
            code: ErrorCode.CONFLICT,
        });
    });

    it("splits a long transcript into windows and joins their topics", async () => {
        const long = Array.from({ length: 120 }, (_, i) => ({
            speaker: `speaker_${i % 2}`,
            startMs: i * 30_000,
            endMs: i * 30_000 + 29_000,
            text: "slovo ".repeat(100).trim(),
        }));
        stage(long);
        createMock.mockImplementation(async ({ messages }) => {
            // Name a topic at the first line of every window.
            const first = /\[(\d+:\d{2}(?::\d{2})?)\]/.exec(
                messages[1].content,
            )?.[1];
            return {
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                topics: [
                                    { start: first, title: `Od ${first}` },
                                ],
                            }),
                        },
                    },
                ],
            };
        });

        const result = await run();

        expect(result.windows).toBeGreaterThan(1);
        expect(createMock).toHaveBeenCalledTimes(result.windows);
        // Only the first window's opening topic survives: every later window
        // opens inside the previous one's overlap, which is not its to decide.
        expect(result.topics.map((topic) => topic.fromMs)).toEqual([0]);
    });
});
