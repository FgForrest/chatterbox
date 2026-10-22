import { describe, expect, it, vi } from "vitest";

const { transcribe } = vi.hoisted(() => ({
    transcribe: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock("@/db/queries/async-jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/recordings/erase", () => ({
    allowManualArtifactGeneration: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/transcription/transcribe-recording", () => ({
    transcribeRecording: transcribe,
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

import { parseTranscriptionJobPayload } from "@/lib/transcription/transcription-job";
import { transcriptionJobHandler } from "@/lib/transcription/transcription-job-handler";

describe("one-run transcription language override", () => {
    it("survives persisted payload validation and reaches the provider runner", async () => {
        const payload = parseTranscriptionJobPayload({
            recordingId: "invented-rec",
            trigger: "manual",
            force: true,
            language: "cs",
            view: "org",
        });
        await transcriptionJobHandler.run({
            payload,
            userId: "invented-curator",
            jobId: "invented-job",
            attempt: 1,
            maxAttempts: 3,
            signal: new AbortController().signal,
            reportProgress: () => {},
        });
        expect(transcribe).toHaveBeenCalledWith(
            "invented-curator",
            "invented-rec",
            expect.objectContaining({
                language: "cs",
                force: true,
                view: "org",
            }),
        );
    });
    it.each([
        { force: false, trigger: "manual", language: "cs" },
        { force: true, trigger: "pipeline", language: "cs" },
        { force: true, trigger: "manual", language: "auto" },
    ])("refuses an override outside a confirmed manual run %j", (options) => {
        expect(() =>
            parseTranscriptionJobPayload({
                recordingId: "invented-rec",
                ...options,
            }),
        ).toThrow();
    });
    it("leaves ordinary transcription without an override", () => {
        expect(
            parseTranscriptionJobPayload({
                recordingId: "invented-rec",
                trigger: "pipeline",
                force: false,
            }),
        ).not.toHaveProperty("language");
    });
});
