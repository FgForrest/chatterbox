import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatterItems, recordings, transcriptions } from "@/db/schema";
import { generateTitleFromTranscription } from "@/lib/ai/generate-title";
import * as summaryGeneration from "@/lib/summary/generate-summary";
import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import { topicsJobHandler } from "@/lib/topics/topics-job-handler";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";

const mocks = vi.hoisted(() => ({
    resolveItemProfile: vi.fn(),
    resolveManualItemProfile: vi.fn(),
    rows: new Map<unknown, unknown[]>(),
    stop: new Error("stop at profile resolution"),
}));
vi.mock("@/db", () => ({
    db: {
        select: () => {
            let table: unknown;
            const chain = {
                from: (value: unknown) => {
                    table = value;
                    return chain;
                },
                innerJoin: () => chain,
                leftJoin: () => chain,
                where: () => chain,
                limit: async () => mocks.rows.get(table) ?? [],
            };
            return chain;
        },
    },
}));
vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: mocks.resolveItemProfile,
    loadSelectedProfileRevision: vi.fn(),
}));
vi.mock("@/lib/profiles/resolve-manual", () => ({
    resolveManualItemProfile: mocks.resolveManualItemProfile,
}));
vi.mock("@/lib/sharing/run-context", () => ({
    resolveRunContext: vi.fn().mockResolvedValue({
        view: "private",
        ownerUserId: "owner-zava",
        actorUserId: "owner-zava",
        contentUserId: "owner-zava",
        settingsUserId: "owner-zava",
    }),
}));
vi.mock("@/lib/sharing/writer", () => ({
    contentWriterRefusalNow: vi.fn().mockResolvedValue(null),
    sharingOrgUserId: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/learn/llm-input", () => ({
    modelInput: vi.fn().mockResolvedValue({
        text: "Planning notes",
        fingerprint: "test-input",
    }),
}));
vi.mock("@/lib/transcription/read-turns", () => ({
    readTranscriptTurns: vi.fn().mockReturnValue([
        {
            speaker: "speaker_0",
            startMs: 0,
            endMs: 1000,
            text: "Planning notes",
        },
    ]),
}));
vi.mock("@/lib/learn/hold", () => ({
    isHeldForLearn: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/learn/summary-refresh", () => ({
    summaryRefreshDue: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/pipeline/state", () => ({
    readProcessing: vi
        .fn()
        .mockResolvedValue({ phases: {}, profileRevisionId: "base-revision" }),
}));
vi.mock("@/lib/recordings/erase", () => ({
    allowManualArtifactGeneration: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

function context(trigger: "manual" | "auto") {
    return {
        jobId: "held-job",
        userId: "owner-zava",
        attempt: 1,
        maxAttempts: 3,
        payload: { recordingId: "shared-item", trigger },
        signal: new AbortController().signal,
        reportProgress: vi.fn(),
    };
}

describe("#221 job profile resolution", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.rows.clear();
        mocks.rows.set(chatterItems, [{ kind: "audio" }]);
        mocks.rows.set(recordings, [
            { id: "shared-item", audioReapedAt: null },
        ]);
        mocks.rows.set(transcriptions, [
            { id: "transcript", revision: 0, source: "riffado" },
        ]);
        mocks.resolveItemProfile.mockReset().mockRejectedValue(mocks.stop);
        mocks.resolveManualItemProfile
            .mockReset()
            .mockRejectedValue(mocks.stop);
    });

    it.each([
        "manual",
        "auto",
    ] as const)("passes the summary step only for an %s job", async (trigger) => {
        await expect(summaryJobHandler.run(context(trigger))).rejects.toBe(
            mocks.stop,
        );
        const resolve =
            trigger === "auto"
                ? mocks.resolveItemProfile
                : mocks.resolveManualItemProfile;
        expect(resolve).toHaveBeenCalledWith(
            "shared-item",
            "private",
            "owner-zava",
            "owner-zava",
            trigger === "auto" ? "summary" : undefined,
            trigger === "auto" ? "held-job" : undefined,
        );
    });

    it.each([
        "manual",
        "auto",
    ] as const)("passes the topics step only for an %s job", async (trigger) => {
        await expect(
            topicsJobHandler.run({
                ...context(trigger),
                payload: { ...context(trigger).payload, source: "riffado" },
            }),
        ).rejects.toBe(mocks.stop);
        const resolve =
            trigger === "auto"
                ? mocks.resolveItemProfile
                : mocks.resolveManualItemProfile;
        expect(resolve).toHaveBeenCalledWith(
            "shared-item",
            "private",
            "owner-zava",
            "owner-zava",
            trigger === "auto" ? "topics" : undefined,
            trigger === "auto" ? "held-job" : undefined,
        );
    });

    it("resolves the title step after a completed summary job", async () => {
        vi.spyOn(
            summaryGeneration,
            "generateSummaryForRecording",
        ).mockResolvedValueOnce({
            ownerUserId: "owner-zava",
            summary: "Planning notes",
            keyPoints: [],
            actionItems: [],
            provider: "test",
            model: "test",
            promptId: "general",
            promptFallback: false,
        });
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        await summaryJobHandler.run(context("auto"));
        expect(mocks.resolveItemProfile).toHaveBeenCalledWith(
            "shared-item",
            "private",
            "owner-zava",
            "owner-zava",
            "title",
            "held-job",
        );
        error.mockRestore();
    });

    it("passes the title step from a summary job through automatic title generation", async () => {
        vi.spyOn(
            summaryGeneration,
            "generateSummaryForRecording",
        ).mockResolvedValueOnce({
            ownerUserId: "owner-zava",
            summary: "Planning notes",
            keyPoints: [],
            actionItems: [],
            provider: "test",
            model: "test",
            promptId: "general",
            promptFallback: false,
        });
        mocks.resolveItemProfile.mockResolvedValueOnce({
            settings: { steps: { title: { automatic: true } } },
        });
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        await summaryJobHandler.run(context("auto"));
        expect(mocks.resolveItemProfile).toHaveBeenNthCalledWith(
            2,
            "shared-item",
            "private",
            "owner-zava",
            "owner-zava",
            "title",
            "held-job",
        );
        error.mockRestore();
    });

    it("manual title generation does not use an automatic job's held revision", async () => {
        await expect(
            generateTitleFromTranscription(
                "owner-zava",
                "shared-item",
                "Planning notes",
            ),
        ).rejects.toBe(mocks.stop);
        expect(mocks.resolveItemProfile).toHaveBeenCalledWith(
            "shared-item",
            "private",
            "owner-zava",
            "owner-zava",
            undefined,
            undefined,
        );
    });

    it.each([
        "manual",
        "pipeline",
    ] as const)("passes the transcription step only for a %s run", async (trigger) => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        await transcribeRecording("owner-zava", "shared-item", {
            trigger,
            jobId: "held-job",
        });
        const resolve =
            trigger === "pipeline"
                ? mocks.resolveItemProfile
                : mocks.resolveManualItemProfile;
        expect(resolve).toHaveBeenCalledWith(
            "shared-item",
            "private",
            "owner-zava",
            "owner-zava",
            trigger === "pipeline" ? "transcribe" : undefined,
            trigger === "pipeline" ? "held-job" : undefined,
        );
        error.mockRestore();
    });
});
