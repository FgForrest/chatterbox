import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    enqueueTranscriptionJob: vi.fn(),
    getActiveJob: vi.fn(),
    limit: vi.fn(),
    select: vi.fn(),
    access: { exists: true },
    transcriptRows: [] as Array<{ id: string }>,
}));

// Ownership lives in the access layer, tested against a real database in
// `src/tests/sharing/`; here it answers "owner" unless a test says otherwise.
vi.mock("@/lib/org/config", () => ({
    isOrgScopeVisible: () => false,
    isOrgScopeEnabled: () => false,
    getOrgUserId: async () => null,
    assertOrgScopeWritable: () => {},
    isOrgAccount: async () => false,
    assertNotOrgAccount: async () => {},
}));

vi.mock("@/lib/sharing/access", async () => {
    const { AppError, ErrorCode } =
        await vi.importActual<typeof import("@/lib/errors")>("@/lib/errors");
    return {
        requestedRecordingView: (request: Request) =>
            new URL(request.url).searchParams.get("view") === "org"
                ? "org"
                : "private",
        recordingJobSubject: (id: string, view: string) =>
            view === "org" ? `org:${id}` : id,
        requireRecordingView: vi.fn(async (userId: string) => {
            if (!mocks.access.exists) {
                throw new AppError(
                    ErrorCode.RECORDING_NOT_FOUND,
                    "Recording not found",
                    404,
                );
            }
            return { ownerUserId: userId, contentUserId: userId };
        }),
    };
});

vi.mock("@/db", () => ({
    db: { select: mocks.select },
}));
vi.mock("@/db/queries/async-jobs", () => ({
    getActiveJob: mocks.getActiveJob,
}));
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: vi.fn().mockResolvedValue(false),
    userCuratesOrganizationNow: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/auth-server", async () => {
    const { withSessionActor } = await vi.importActual<
        typeof import("@/tests/helpers/session-actor")
    >("@/tests/helpers/session-actor");
    return withSessionActor({
        requireApiSession: vi.fn().mockResolvedValue({
            user: { id: "user-1" },
        }),
    });
});

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/transcription/transcription-job", () => ({
    enqueueTranscriptionJob: mocks.enqueueTranscriptionJob,
    TRANSCRIPTION_JOB_KIND: "transcription",
}));

import { GET, POST } from "@/app/api/recordings/[id]/transcribe/route";
import { ErrorCode } from "@/lib/errors";

const context = { params: Promise.resolve({ id: "recording-1" }) };

function request(method = "GET", body?: Record<string, unknown>) {
    return new Request(
        "http://localhost/api/recordings/recording-1/transcribe",
        {
            method,
            ...(body
                ? {
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify(body),
                  }
                : {}),
        },
    );
}

describe("recording transcription jobs route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.select.mockReturnValue({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({ limit: mocks.limit }),
            }),
        });
        mocks.limit.mockImplementation(async () => mocks.transcriptRows);
        mocks.access.exists = true;
        mocks.transcriptRows = [];
        mocks.getActiveJob.mockResolvedValue(null);
        mocks.enqueueTranscriptionJob.mockResolvedValue({
            job: { id: "job-1", status: "pending" },
            created: true,
        });
    });

    it("queues a plain manual job without force and returns immediately", async () => {
        const response = await POST(
            request("POST", {
                providerId: "provider-1",
                model: "whisper-large-v3",
            }),
            context,
        );

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual({
            jobId: "job-1",
            status: "pending",
            created: true,
        });
        expect(mocks.enqueueTranscriptionJob).toHaveBeenCalledWith({
            userId: "user-1",
            recordingId: "recording-1",
            providerId: "provider-1",
            model: "whisper-large-v3",
            force: false,
            trigger: "manual",
            view: "private",
        });
    });

    it("returns the active job even when a transcript already exists", async () => {
        mocks.transcriptRows = [{ id: "transcript-1" }];
        mocks.getActiveJob.mockResolvedValue({
            id: "job-auto",
            userId: "user-1",
            status: "processing",
        });

        const response = await POST(request("POST"), context);

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({
            jobId: "job-auto",
            status: "processing",
            created: false,
        });
        expect(mocks.enqueueTranscriptionJob).not.toHaveBeenCalled();
    });

    it("refuses a plain request when a transcript already exists", async () => {
        mocks.transcriptRows = [{ id: "transcript-1" }];

        const response = await POST(request("POST"), context);

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
            code: "TRANSCRIPT_ALREADY_EXISTS",
        });
        expect(mocks.enqueueTranscriptionJob).not.toHaveBeenCalled();
    });

    it("queues an explicitly confirmed re-transcription with force", async () => {
        mocks.transcriptRows = [{ id: "transcript-1" }];

        const response = await POST(
            request("POST", { retranscribe: true }),
            context,
        );

        expect(response.status).toBe(202);
        expect(mocks.enqueueTranscriptionJob).toHaveBeenCalledWith({
            userId: "user-1",
            recordingId: "recording-1",
            providerId: undefined,
            model: undefined,
            attributionSource: undefined,
            force: true,
            trigger: "manual",
            view: "private",
        });
    });

    it("pins a language only on an explicitly confirmed re-transcription", async () => {
        const response = await POST(
            request("POST", { retranscribe: true, language: "cs" }),
            context,
        );
        expect(response.status).toBe(202);
        expect(mocks.enqueueTranscriptionJob).toHaveBeenCalledWith(
            expect.objectContaining({
                force: true,
                trigger: "manual",
                language: "cs",
            }),
        );
    });

    it.each([
        { language: "auto", retranscribe: true },
        { language: "ces", retranscribe: true },
        { language: "cs", retranscribe: false },
    ])("refuses invalid or unconfirmed language override %j", async (body) => {
        const response = await POST(request("POST", body), context);
        expect(response.status).toBe(400);
        expect(mocks.enqueueTranscriptionJob).not.toHaveBeenCalled();
    });

    it("reports an active background job only to its recording owner", async () => {
        mocks.getActiveJob.mockResolvedValue({
            id: "job-sync",
            userId: "user-1",
            status: "processing",
        });

        const response = await GET(request(), context);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            activeJob: { jobId: "job-sync", status: "processing" },
        });
        expect(mocks.getActiveJob).toHaveBeenCalledWith(
            "transcription",
            "recording-1",
        );
    });

    it("rejects a recording the caller does not own before queueing", async () => {
        mocks.access.exists = false;

        const response = await POST(request("POST"), context);

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.RECORDING_NOT_FOUND,
        });
        expect(mocks.enqueueTranscriptionJob).not.toHaveBeenCalled();
    });
});
