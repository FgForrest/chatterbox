/**
 * When multi-pass actually engages, and how many provider calls it costs.
 *
 * The orchestration itself is covered in `multi-pass.test.ts` without a
 * provider. This file covers the wiring in `generateSummaryForRecording`: the
 * settings that turn it on, the separate opt-in for the auto path, and the
 * clamp that stops a stored value out of range from firing 99 passes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    aiEnhancements,
    apiCredentials,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { defaultTemplateConfig } from "@/lib/ai/prompt-templates";
import { SUMMARY_TEMPLATE_KIND } from "@/lib/ai/summary-presets";
import { BUILTIN_PROMPTS_VERSION } from "@/lib/profiles/prompts";
import { loadSelectedProfileRevision } from "@/lib/profiles/resolve";
import type { LegacyProfileSettings } from "@/lib/profiles/seed";
import { DEFAULT_MERGE_PROMPT } from "@/lib/summary/multi-pass";
import {
    loadTasksPromptContext,
    resolveTaskProposals,
} from "@/lib/tasks/proposals";
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

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
    env: { IS_HOSTED: false, ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: 60 },
}));

const { createMock, plaudActionItems, profileLegacy, tasksEnabled } =
    vi.hoisted(() => ({
        createMock: vi.fn(),
        plaudActionItems: { current: [] as string[] },
        profileLegacy: {
            current: {} as Partial<LegacyProfileSettings>,
        },
        tasksEnabled: { current: true },
    }));

vi.mock("@/lib/summary/read-summary", () => ({
    readPlaudActionItems: vi.fn(async () => plaudActionItems.current),
}));

vi.mock("@/lib/profiles/resolve", () => ({
    loadSelectedProfileRevision: vi.fn(
        async ({ revisionId }: { revisionId: string }) => {
            const profile = resolvedAudioProfile(profileLegacy.current);
            profile.settings.steps.tasks.enabled = tasksEnabled.current;
            return { ...profile, revisionId };
        },
    ),
    resolveItemProfile: vi.fn(async () => {
        const profile = resolvedAudioProfile(profileLegacy.current);
        profile.settings.steps.tasks.enabled = tasksEnabled.current;
        return profile;
    }),
}));
vi.mock("@/lib/pipeline/trigger", () => ({
    requestAdvanceInTx: vi.fn().mockResolvedValue(null),
}));

vi.mock("openai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("openai")>();
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

/** Rows handed to `upsertEnhancement`, so provenance writes can be asserted. */
const written: Record<string, unknown>[] = [];

const tx = {
    select: () => selectChain(),
    insert: () => ({
        values: (row: Record<string, unknown>) => {
            written.push(row);
            return Promise.resolve();
        },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};

vi.mock("@/db", () => ({
    db: {
        select: () => selectChain(),
        transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
}));

type Settings = Record<string, unknown>;

function stage(settings: Settings) {
    profileLegacy.current = settings;
    selectResults.set(recordings, [
        [{ id: "rec-1", userId: "user-1", deletedAt: null }],
        [{ deletedAt: null }],
    ]);
    selectResults.set(transcriptions, [
        [
            {
                id: "transcription-1",
                revision: 4,
                recordingId: "rec-1",
                userId: "user-1",
                text: "a transcript",
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
                isDefaultEnhancement: true,
                userId: "user-1",
            },
        ],
    ]);
    selectResults.set(aiEnhancements, [[]]);

    createMock.mockResolvedValue({
        choices: [
            {
                message: {
                    content: JSON.stringify({
                        summary: "s",
                        keyPoints: ["k"],
                        actionItems: [],
                    }),
                },
            },
        ],
    });
}

async function generate(
    trigger: "manual" | "auto",
    profileRevisionId?: string,
) {
    const { generateSummaryForRecording } = await import(
        "@/lib/summary/generate-summary"
    );
    return generateSummaryForRecording("user-1", "rec-1", {
        trigger,
        profileRevisionId,
    });
}

/** The system prompt of every completion call, in order. */
function systemPrompts(): string[] {
    return createMock.mock.calls.map(
        (call) =>
            (
                call[0] as {
                    messages: { role: string; content: string }[];
                }
            ).messages.find((m) => m.role === "system")?.content ?? "",
    );
}

describe("multi-pass gating", () => {
    beforeEach(() => {
        createMock.mockReset();
        vi.mocked(loadSelectedProfileRevision).mockClear();
        vi.mocked(loadTasksPromptContext).mockClear();
        vi.mocked(resolveTaskProposals).mockClear();
        plaudActionItems.current = [];
        tasksEnabled.current = true;
        selectResults.clear();
        written.length = 0;
    });

    it("makes exactly one call when multi-pass is off", async () => {
        stage({ summaryMultiPass: false });
        const result = await generate("manual");

        expect(createMock).toHaveBeenCalledTimes(1);
        expect(result.multiPass).toBeUndefined();
    });

    it("runs N passes plus one merge when on", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 3 });
        const result = await generate("manual");

        expect(createMock).toHaveBeenCalledTimes(4);
        expect(result.multiPass).toEqual({
            roundsRequested: 3,
            passesUsed: 3,
            merged: true,
            detail: "3/3 passes + merge",
        });
        // The last call is the merge, and it carries the merge prompt rather
        // than the summary system prompt.
        expect(systemPrompts().at(-1)).toContain(
            "UNION-and-DEDUP task, NOT a re-summarization",
        );
    });

    it("stays single-pass on the auto path unless separately enabled", async () => {
        stage({
            summaryMultiPass: true,
            summaryMultiPassRounds: 3,
            summaryMultiPassAuto: false,
        });
        const result = await generate("auto");

        // A sync can fire a dozen of these; the pass count would multiply
        // every one of them.
        expect(createMock).toHaveBeenCalledTimes(1);
        expect(result.multiPass).toBeUndefined();
    });

    it("runs multi-pass on the auto path once opted in", async () => {
        stage({
            summaryMultiPass: true,
            summaryMultiPassRounds: 2,
            summaryMultiPassAuto: true,
        });
        await generate("auto");

        expect(createMock).toHaveBeenCalledTimes(3);
    });

    it("clamps a stored pass count that is out of range", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 99 });
        const result = await generate("manual");

        // 5 passes + 1 merge. A column written before the clamp existed, or
        // by hand, must not be able to fire 99 provider calls.
        expect(createMock).toHaveBeenCalledTimes(6);
        expect(result.multiPass?.roundsRequested).toBe(5);
    });

    it("persists provenance so the badge survives a reload", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 3 });
        await generate("manual");

        const row = written.at(-1) as Record<string, unknown>;
        expect(row.multiPassRounds).toBe(3);
        expect(row.multiPassUsed).toBe(3);
        expect(row.multiPassMerged).toBe(true);
        expect(row.inputs).toMatchObject({ multiPass: "person" });
    });

    it("persists the profile, prompt version, payer, and content inputs", async () => {
        stage({ summaryMultiPass: false });
        await generate("manual");

        expect(written.at(-1)).toMatchObject({
            profileRevisionId: "seeded-profile-revision",
            builtinPromptsVersion: BUILTIN_PROMPTS_VERSION,
            payerUserId: "user-1",
            inputs: {
                contentId: "transcription-1",
                contentRevision: 4,
                multiPass: "off",
            },
            outputLanguage: null,
            outputFormatLocale: "en",
        });
    });

    it("records no built-in prompt version for a full custom prompt", async () => {
        const summaryPrompt = defaultTemplateConfig(SUMMARY_TEMPLATE_KIND);
        summaryPrompt.selectedPrompt = "custom-summary";
        summaryPrompt.templates.push({
            id: "custom-summary",
            name: "Custom",
            prompt: "Summarize this: {transcription}",
            createdAt: "2026-10-15T00:00:00.000Z",
        });
        stage({ summaryPrompt });

        await generate("manual");

        expect(written.at(-1)).toMatchObject({ builtinPromptsVersion: null });
    });

    it("persists the explicitly selected immutable profile revision", async () => {
        stage({ summaryMultiPass: false });
        await generate("manual", "selected-profile-revision");

        expect(loadSelectedProfileRevision).toHaveBeenCalledWith({
            revisionId: "selected-profile-revision",
            actorUserId: "user-1",
            channel: "audio",
            view: "private",
        });
        expect(written.at(-1)).toMatchObject({
            profileRevisionId: "selected-profile-revision",
        });
    });

    it("clears provenance when a multi-pass summary is regenerated single-pass", async () => {
        stage({ summaryMultiPass: false });
        await generate("manual");

        // Written as NULL, not omitted: leaving the old values in place would
        // have the row claim a provenance this summary does not have.
        const row = written.at(-1) as Record<string, unknown>;
        expect(row.multiPassRounds).toBeNull();
        expect(row.multiPassUsed).toBeNull();
        expect(row.multiPassMerged).toBeNull();
    });

    it("prefers the user's merge prompt over the built-in one", async () => {
        stage({
            summaryMultiPass: true,
            summaryMultiPassRounds: 2,
            summaryMergePrompt: "Merge them my way.",
        });
        await generate("manual");

        const mergeSystem = systemPrompts().at(-1) ?? "";
        expect(mergeSystem).toContain("Merge them my way.");
        expect(mergeSystem).not.toContain(DEFAULT_MERGE_PROMPT);
    });

    it("passes Plaud action items after the transcript as suggestions", async () => {
        stage({ summaryMultiPass: false });
        plaudActionItems.current = ["Call Alice", "Send the report"];
        createMock.mockResolvedValue({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            summary: "s",
                            keyPoints: [],
                            actionItems: [{ text: "Send the report" }],
                            taskUpdates: [],
                        }),
                    },
                },
            ],
        });

        await generate("manual");

        const userPrompt = (
            createMock.mock.calls[0]?.[0] as {
                messages: { role: string; content: string }[];
            }
        ).messages.find((message) => message.role === "user")?.content;
        expect(userPrompt).toContain("Plaud's action-item suggestions");
        expect(userPrompt).toContain("- Call Alice");
        expect(userPrompt).toContain("- Send the report");
        expect(userPrompt?.indexOf("a transcript")).toBeLessThan(
            userPrompt?.indexOf("Plaud's action-item suggestions") ?? -1,
        );
        expect(resolveTaskProposals).toHaveBeenCalledWith(
            expect.objectContaining({
                source: "riffado",
                items: [expect.objectContaining({ text: "Send the report" })],
            }),
        );
    });

    it("drops task output and task prompt context when Tasks are off", async () => {
        stage({ summaryMultiPass: false });
        tasksEnabled.current = false;
        plaudActionItems.current = ["Do not pass this hint"];
        createMock.mockResolvedValue({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            summary: "s",
                            keyPoints: ["k"],
                            actionItems: [{ text: "Ignored task" }],
                            taskUpdates: [
                                { ref: "T1", kind: "done", quote: "done" },
                            ],
                        }),
                    },
                },
            ],
        });

        const result = await generate("manual");

        expect(result.actionItems).toEqual([]);
        expect(loadTasksPromptContext).not.toHaveBeenCalled();
        expect(resolveTaskProposals).not.toHaveBeenCalled();
        expect(systemPrompts()[0]).not.toContain("ACTION ITEMS:");
        const userPrompt = (
            createMock.mock.calls[0]?.[0] as {
                messages: { role: string; content: string }[];
            }
        ).messages.find((message) => message.role === "user")?.content;
        expect(userPrompt).not.toContain("Plaud's action-item suggestions");
    });

    it("removes task data and directives from a Tasks-off multi-pass merge", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 2 });
        tasksEnabled.current = false;
        createMock.mockResolvedValue({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            summary: "s",
                            keyPoints: ["k"],
                            actionItems: [{ text: "Ignored task" }],
                            taskUpdates: [{ ref: "T1", kind: "match" }],
                        }),
                    },
                },
            ],
        });

        const result = await generate("manual");

        const mergeCall = createMock.mock.calls.at(-1)?.[0] as {
            messages: { role: string; content: string }[];
        };
        const mergeSystem = mergeCall.messages.find(
            (message) => message.role === "system",
        )?.content;
        const mergeInput = mergeCall.messages.find(
            (message) => message.role === "user",
        )?.content;
        expect(result.actionItems).toEqual([]);
        expect(mergeSystem).not.toContain("ACTION ITEMS:");
        expect(mergeSystem).not.toContain("taskUpdates");
        expect(mergeInput).not.toContain("actionItems");
        expect(mergeInput).not.toContain("taskUpdates");
        expect(resolveTaskProposals).not.toHaveBeenCalled();
    });
});
