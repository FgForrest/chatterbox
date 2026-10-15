import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    enqueueJob: vi.fn(),
    limit: vi.fn(),
    nudge: vi.fn(),
    select: vi.fn(),
    transcribeRecording: vi.fn(),
    allowManualArtifactGeneration: vi.fn(),
    requestAdvance: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        select: mocks.select,
    },
}));
vi.mock("@/db/queries/async-jobs", () => ({
    enqueueJob: mocks.enqueueJob,
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: mocks.nudge }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/transcription/transcribe-recording", () => ({
    transcribeRecording: mocks.transcribeRecording,
}));
vi.mock("@/lib/recordings/erase", () => ({
    allowManualArtifactGeneration: mocks.allowManualArtifactGeneration,
}));
vi.mock("@/lib/pipeline/trigger", () => ({
    requestAdvance: mocks.requestAdvance,
}));

import { ErrorCode } from "@/lib/errors";
import { InvalidJobPayloadError } from "@/lib/jobs/types";
import {
    enqueueTranscriptionJob,
    parseTranscriptionJobPayload,
    TRANSCRIPTION_MAX_ATTEMPTS,
} from "@/lib/transcription/transcription-job";
import { transcriptionJobHandler } from "@/lib/transcription/transcription-job-handler";

function handlerContext() {
    return {
        jobId: "job-1",
        userId: "user-1",
        attempt: 1,
        maxAttempts: TRANSCRIPTION_MAX_ATTEMPTS,
        payload: {
            recordingId: "recording-1",
            trigger: "upload" as const,
            force: false,
        },
        signal: new AbortController().signal,
        reportProgress: vi.fn(),
    };
}

describe("automatic upload transcription", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.select.mockReturnValue({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({ limit: mocks.limit }),
            }),
        });
        mocks.enqueueJob.mockResolvedValue({
            job: { id: "job-1" },
            created: true,
        });
        mocks.allowManualArtifactGeneration.mockResolvedValue(true);
        mocks.requestAdvance.mockResolvedValue({
            requestedGeneration: 2,
            enqueued: true,
        });
    });

    it("deduplicates by recording and wakes the worker", async () => {
        await enqueueTranscriptionJob({
            userId: "user-1",
            recordingId: "recording-1",
            trigger: "upload",
        });

        expect(mocks.enqueueJob).toHaveBeenCalledWith(
            expect.objectContaining({ subjectId: "recording-1" }),
        );
        expect(mocks.nudge).toHaveBeenCalledTimes(1);
    });

    it("validates persisted job payloads", () => {
        expect(
            parseTranscriptionJobPayload({
                recordingId: "recording-1",
                trigger: "upload",
            }),
        ).toEqual({
            recordingId: "recording-1",
            trigger: "upload",
            providerId: undefined,
            model: undefined,
            force: false,
        });
        expect(() => parseTranscriptionJobPayload({})).toThrow(
            InvalidJobPayloadError,
        );
        expect(
            parseTranscriptionJobPayload({
                recordingId: "recording-1",
                trigger: "sync",
            }),
        ).toMatchObject({ trigger: "sync", force: false });
        expect(
            parseTranscriptionJobPayload({
                recordingId: "recording-1",
                trigger: "manual",
                providerId: "provider-1",
                model: "whisper-large-v3",
                force: true,
            }),
        ).toEqual({
            recordingId: "recording-1",
            trigger: "manual",
            providerId: "provider-1",
            model: "whisper-large-v3",
            force: true,
        });
    });

    it("transcribes in the background with upload attribution", async () => {
        mocks.transcribeRecording.mockResolvedValue({
            success: true,
            text: "private transcript",
        });

        await expect(
            transcriptionJobHandler.run(handlerContext()),
        ).resolves.toEqual({ transcribed: true });
        expect(mocks.transcribeRecording).toHaveBeenCalledWith(
            "user-1",
            "recording-1",
            expect.objectContaining({
                trigger: "upload",
                providerId: undefined,
                model: undefined,
                force: false,
            }),
        );
    });

    it("records completed transcription failures without retrying them", async () => {
        mocks.transcribeRecording.mockResolvedValue({
            success: false,
            error: "provider detail must not reach the job row",
            errorCode: "NO_TRANSCRIPTION_PROVIDER",
        });
        let failure: unknown;

        try {
            await transcriptionJobHandler.run(handlerContext());
        } catch (error) {
            failure = error;
        }

        expect(failure).toMatchObject({
            code: ErrorCode.NO_TRANSCRIPTION_PROVIDER,
            message: "No transcription provider is configured",
        });
        expect(transcriptionJobHandler.isRetryable?.(failure)).toBe(false);
    });

    it("requests the private pipeline after a pipeline transcription fails", async () => {
        await transcriptionJobHandler.onTerminalFailure?.({
            jobId: "job-1",
            userId: "user-1",
            payload: {
                recordingId: "recording-1",
                trigger: "pipeline",
                force: false,
            },
            errorCode: ErrorCode.TRANSCRIPTION_FAILED,
        });

        expect(mocks.requestAdvance).toHaveBeenCalledWith({
            itemId: "recording-1",
            userId: "user-1",
            view: "private",
            reason: "transcription-failed",
        });
    });

    it("does not recreate an erased transcript from an upload job", async () => {
        mocks.allowManualArtifactGeneration.mockResolvedValueOnce(false);

        await expect(
            transcriptionJobHandler.run(handlerContext()),
        ).rejects.toMatchObject({
            code: ErrorCode.RECORDING_DATA_REAPED,
        });
        expect(mocks.transcribeRecording).not.toHaveBeenCalled();
    });
});
