import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type * as errors from "@/lib/errors";
import type * as summaryJob from "@/lib/summary/summary-job";
import type * as sessionActor from "@/tests/helpers/session-actor";

/**
 * The manual `POST /api/recordings/[id]/summary` contract.
 *
 * The route no longer generates anything: it queues a durable job and waits
 * for it, so that a summary outlives the request that asked for it. Two things
 * still have to hold across that change, and this pins both:
 *
 *   1. the chosen preset reaches the work -- now via the job payload rather
 *      than a direct call, which is exactly the kind of hop where a value
 *      quietly stops being passed;
 *   2. a caller that did not ask for the event stream gets the same JSON
 *      object it always did.
 */

vi.mock("@/lib/identity/factory", () => ({ isIdpAuthorization: () => false }));
// Without corrections a model reads the stored text as it is.
vi.mock("@/lib/learn/llm-input", () => ({
    modelInput: vi.fn(async (transcript: { text: string }) => ({
        text: transcript.text,
        turns: null,
        fingerprint: null,
    })),
    llmRendering: vi.fn(async () => null),
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
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));

vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: vi.fn().mockResolvedValue(false),
    userCuratesOrganizationNow: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/auth-server", async () => {
    const { withSessionActor } = await vi.importActual<typeof sessionActor>(
        "@/tests/helpers/session-actor",
    );
    return withSessionActor({
        requireApiSession: vi.fn().mockResolvedValue({
            user: { id: "user-1", email: "u@example.com" },
        }),
    });
});

vi.mock("@/lib/summary/summary-job", async (importOriginal) => {
    const actual = await importOriginal<typeof summaryJob>();
    return { ...actual, enqueueSummaryJob: vi.fn() };
});

vi.mock("@/lib/summary/corrections", () => ({
    summaryEditState: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/jobs/watch", () => ({ watchJob: vi.fn() }));
vi.mock("@/lib/export/document-sidecars", () => ({
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/summary/read-summary", () => ({
    readStoredSummary: vi.fn(),
    readStoredSummaries: vi.fn(),
}));
vi.mock("@/db/queries/async-jobs", () => ({ getActiveJob: vi.fn() }));
vi.mock("@/lib/pipeline/pending", () => ({
    pipelineMayQueue: vi.fn(),
}));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveSelectedProfile: vi.fn(),
}));
vi.mock("@/lib/profiles/access", () => ({
    mayUseProfile: vi.fn().mockResolvedValue(false),
}));

const { recordingAccess } = vi.hoisted(() => ({
    recordingAccess: { exists: true },
}));

// Ownership lives in the access layer, which has its own tests against a
// real database; here it answers "owner" unless a test says otherwise.
vi.mock("@/lib/sharing/access", async () => {
    const { AppError, ErrorCode } =
        await vi.importActual<typeof errors>("@/lib/errors");
    return {
        requestedRecordingView: (request: Request) =>
            new URL(request.url).searchParams.get("view") === "org"
                ? "org"
                : "private",
        recordingJobSubject: (id: string, view: string) =>
            view === "org" ? `org:${id}` : id,
        requireRecordingView: vi.fn(
            async (userId: string, id: string, view: "private" | "org") => {
                if (!recordingAccess.exists) {
                    throw new AppError(
                        ErrorCode.RECORDING_NOT_FOUND,
                        "Recording not found",
                        404,
                    );
                }
                return {
                    recordingId: id,
                    ownerUserId: userId,
                    contentUserId: userId,
                    role: "owner",
                    kind: "audio",
                    shared: false,
                    orgUserId: null,
                    view,
                };
            },
        ),
    };
});
vi.mock("@/lib/sharing/jobs", () => ({ getJobVisibleTo: vi.fn() }));

// `apiHandler` wraps the route in a try/catch that maps thrown AppErrors to
// status codes. The real implementation is used so a regression in error
// mapping also surfaces here; the ownership lookup it guards is stubbed
// below.
const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock("@/db", () => ({
    db: { select: selectMock, transaction: vi.fn() },
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: vi.fn((v: string | null) => v),
    decryptJsonField: vi.fn(),
}));

vi.mock("@/lib/demo/fixtures", () => ({
    DEMO_SUMMARIES: new Map(),
    isDemoRecordingId: vi.fn().mockReturnValue(false),
}));

import { GET, POST } from "@/app/api/recordings/[id]/summary/route";
import { getActiveJob } from "@/db/queries/async-jobs";
import { actsForOrganization } from "@/lib/authz/curator";
import { watchJob } from "@/lib/jobs/watch";
import { pipelineMayQueue } from "@/lib/pipeline/pending";
import { resolveSelectedProfile } from "@/lib/profiles/resolve";
import {
    readStoredSummaries,
    readStoredSummary,
} from "@/lib/summary/read-summary";
import { enqueueSummaryJob } from "@/lib/summary/summary-job";

/** The recording-ownership check the route makes before queueing anything. */
function stubRecordingExists(exists = true) {
    recordingAccess.exists = exists;
    const query = {
        innerJoin: () => query,
        where: () => query,
        limit: () =>
            Promise.resolve(
                exists
                    ? [
                          {
                              id: "rec-1",
                              hasAgenda: false,
                              agendaCandidateCount: 0,
                          },
                      ]
                    : [],
            ),
    };
    selectMock.mockReturnValue({ from: () => query });
}

describe("POST /api/recordings/[id]/summary (manual)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(actsForOrganization).mockResolvedValue(false);
        stubRecordingExists();
        (enqueueSummaryJob as Mock).mockResolvedValue({
            job: { id: "job-1", status: "pending" },
            created: true,
        });
        (watchJob as Mock).mockResolvedValue({
            reason: "settled",
            row: {
                id: "job-1",
                status: "completed",
                result: { provider: "openai", model: "gpt-4o-mini" },
            },
        });
        (readStoredSummary as Mock).mockResolvedValue({
            id: "summary-row",
            speakerNumberOffset: null,
            summary: "ok",
            keyPoints: ["a", "b"],
            actionItems: ["x"],
            source: "riffado",
            transcriptionId: "tr-custom",
            provider: "openai",
            model: "gpt-4o-mini",
            multiPass: undefined,
            createdAt: new Date(0),
        });
        (resolveSelectedProfile as Mock).mockResolvedValue(null);
    });

    function makeRequest(body: unknown): Request {
        return new Request("http://localhost/api/recordings/rec-1/summary", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    }

    function makeContext(id = "rec-1") {
        return { params: Promise.resolve({ id }) };
    }

    it("forwards preset from body into the queued job", async () => {
        const response = await POST(
            makeRequest({ preset: "meeting-notes" }),
            makeContext(),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            canEditSummary: true,
            summaryId: "summary-row",
            speakerNumberOffset: null,
            editedAt: null,
            editedByName: null,
            revision: 0,
            correctedWithRemarks: false,
            remarksAppliedCount: 0,
            summary: "ok",
            keyPoints: ["a", "b"],
            actionItems: ["x"],
            source: "riffado",
            transcriptionId: "tr-custom",
            provider: "openai",
            model: "gpt-4o-mini",
            promptFallback: false,
        });
        expect(enqueueSummaryJob).toHaveBeenCalledWith({
            expectedSummaryId: null,
            userId: "user-1",
            ownerUserId: "user-1",
            recordingId: "rec-1",
            presetId: "meeting-notes",
            trigger: "manual",
            view: "private",
        });
    });

    it("passes presetId: undefined when body omits preset", async () => {
        await POST(makeRequest({}), makeContext());

        expect(enqueueSummaryJob).toHaveBeenCalledWith({
            expectedSummaryId: null,
            userId: "user-1",
            ownerUserId: "user-1",
            recordingId: "rec-1",
            presetId: undefined,
            trigger: "manual",
            view: "private",
        });
    });

    it("queues a manual summary when the selected profile's automatic summary is off", async () => {
        (resolveSelectedProfile as Mock).mockResolvedValue({
            revisionId: "profile-revision-1",
            profile: { id: "profile-1", channel: "audio" },
            settings: { steps: { summary: { automatic: false } } },
        });

        const response = await POST(
            makeRequest({ profileId: "profile-1" }),
            makeContext(),
        );

        expect(response.status).toBe(200);
        expect(resolveSelectedProfile).toHaveBeenCalledWith({
            profileId: "profile-1",
            actorUserId: "user-1",
            view: "private",
        });
        expect(enqueueSummaryJob).toHaveBeenCalledWith({
            expectedSummaryId: null,
            userId: "user-1",
            ownerUserId: "user-1",
            recordingId: "rec-1",
            presetId: undefined,
            profileRevisionId: "profile-revision-1",
            trigger: "manual",
            view: "private",
        });
    });

    it("rejects a personal profile on the Organization view", async () => {
        vi.mocked(actsForOrganization).mockResolvedValue(true);
        (resolveSelectedProfile as Mock).mockResolvedValue(null);
        const response = await POST(
            new Request(
                "http://localhost/api/recordings/rec-1/summary?view=org",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ profileId: "personal-profile" }),
                },
            ),
            makeContext(),
        );

        expect(response.status).toBe(400);
        expect(resolveSelectedProfile).toHaveBeenCalledWith({
            profileId: "personal-profile",
            actorUserId: "user-1",
            view: "org",
        });
        expect(enqueueSummaryJob).not.toHaveBeenCalled();
    });

    it("rejects preset and profileId together", async () => {
        const response = await POST(
            makeRequest({ preset: "general", profileId: "profile-1" }),
            makeContext(),
        );

        expect(response.status).toBe(400);
        expect(enqueueSummaryJob).not.toHaveBeenCalled();
    });

    it("rejects an unavailable profile or one for the other channel", async () => {
        expect(
            (
                await POST(
                    makeRequest({ profileId: "hidden-profile" }),
                    makeContext(),
                )
            ).status,
        ).toBe(400);

        (resolveSelectedProfile as Mock).mockResolvedValue({
            revisionId: "mail-revision",
            profile: { id: "mail-profile", channel: "mail" },
        });
        expect(
            (
                await POST(
                    makeRequest({ profileId: "mail-profile" }),
                    makeContext(),
                )
            ).status,
        ).toBe(400);
        expect(enqueueSummaryJob).not.toHaveBeenCalled();
    });

    it("tolerates a non-JSON body (parses to empty object)", async () => {
        const garbageRequest = new Request(
            "http://localhost/api/recordings/rec-1/summary",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "not-json{",
            },
        );

        const response = await POST(garbageRequest, makeContext());

        expect(response.status).toBe(200);
        expect(enqueueSummaryJob).toHaveBeenCalledWith({
            expectedSummaryId: null,
            userId: "user-1",
            ownerUserId: "user-1",
            recordingId: "rec-1",
            presetId: undefined,
            trigger: "manual",
            view: "private",
        });
    });

    it("404s without queueing when the recording is not the caller's", async () => {
        stubRecordingExists(false);

        const response = await POST(makeRequest({}), makeContext());

        expect(response.status).toBe(404);
        // The point of checking ownership in the route: a request that cannot
        // succeed should not leave a job behind for a worker to discover and
        // fail a second later.
        expect(enqueueSummaryJob).not.toHaveBeenCalled();
    });

    it("reports a failed job with the status its error code implies", async () => {
        (watchJob as Mock).mockResolvedValue({
            reason: "settled",
            row: {
                id: "job-1",
                status: "failed",
                errorCode: "AI_PROVIDER_NOT_CONFIGURED",
                lastError: "No AI provider configured",
            },
        });

        const response = await POST(makeRequest({}), makeContext());

        // Not a 500: the worker's failure was the user's configuration, and
        // flattening every job failure to a server error would hide that.
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe("No AI provider configured");
    });

    it("answers 202 with the job id when the job outlives the wait", async () => {
        (watchJob as Mock).mockResolvedValue({
            reason: "timeout",
            row: { id: "job-1", status: "processing" },
        });

        const response = await POST(makeRequest({}), makeContext());

        // Nothing failed -- the work is still running, and the caller is told
        // where to follow it rather than being handed an error.
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({
            jobId: "job-1",
            status: "processing",
        });
    });
});

describe("GET /api/recordings/[id]/summary (source variants)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubRecordingExists();
        (getActiveJob as Mock).mockResolvedValue(null);
        (pipelineMayQueue as Mock).mockResolvedValue(true);
        (readStoredSummaries as Mock).mockResolvedValue([
            {
                summary: "Plaud summary",
                keyPoints: [],
                actionItems: [],
                source: "plaud",
                transcriptionId: "tr-plaud",
                provider: "plaud",
                model: "plaud-native",
                createdAt: new Date(0),
            },
            {
                summary: "Custom summary",
                keyPoints: [],
                actionItems: [],
                source: "riffado",
                transcriptionId: "tr-custom",
                provider: "openai",
                model: "gpt-4o-mini",
                createdAt: new Date(0),
            },
        ]);
    });

    it("returns the requested pipeline and advertises both variants", async () => {
        const response = await GET(
            new Request(
                "http://localhost/api/recordings/rec-1/summary?source=plaud",
            ),
            { params: Promise.resolve({ id: "rec-1" }) },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            summary: "Plaud summary",
            canEditSummary: false,
            source: "plaud",
            transcriptionId: "tr-plaud",
            provider: "plaud",
            model: "plaud-native",
            availableSources: ["plaud", "riffado"],
            hasAgenda: false,
            agendaCandidateCount: 0,
        });
        expect(pipelineMayQueue).not.toHaveBeenCalled();
    });

    it("reports the private pipeline driver while automatic summary work is pending", async () => {
        (readStoredSummaries as Mock).mockResolvedValue([]);
        (getActiveJob as Mock).mockImplementation(
            async (kind: string, subjectId: string) =>
                kind === "pipeline.advance" && subjectId === "rec-1"
                    ? {
                          id: "pipeline-job-1",
                          kind: "pipeline.advance",
                          userId: "user-1",
                          status: "pending",
                          progress: null,
                      }
                    : null,
        );

        const response = await GET(
            new Request(
                "http://localhost/api/recordings/rec-1/summary?source=riffado",
            ),
            { params: Promise.resolve({ id: "rec-1" }) },
        );

        expect(await response.json()).toMatchObject({
            summary: null,
            activeJob: {
                jobId: "pipeline-job-1",
                status: "pending",
                progress: null,
                kind: "pipeline.advance",
            },
        });
        expect(pipelineMayQueue).toHaveBeenCalledWith(
            "user-1",
            "rec-1",
            "summary",
        );
        expect(
            vi.mocked(getActiveJob).mock.invocationCallOrder[0],
        ).toBeLessThan(vi.mocked(pipelineMayQueue).mock.invocationCallOrder[0]);
    });

    it("does not report the pipeline driver when automatic summaries are off", async () => {
        (readStoredSummaries as Mock).mockResolvedValue([]);
        (pipelineMayQueue as Mock).mockResolvedValue(false);
        (getActiveJob as Mock).mockImplementation(
            async (kind: string, subjectId: string) =>
                kind === "pipeline.advance" && subjectId === "rec-1"
                    ? {
                          id: "pipeline-job-1",
                          kind: "pipeline.advance",
                          userId: "user-1",
                          status: "pending",
                          progress: null,
                      }
                    : null,
        );

        const response = await GET(
            new Request(
                "http://localhost/api/recordings/rec-1/summary?source=riffado",
            ),
            { params: Promise.resolve({ id: "rec-1" }) },
        );

        expect((await response.json()).activeJob).toBeUndefined();
        expect(pipelineMayQueue).toHaveBeenCalledWith(
            "user-1",
            "rec-1",
            "summary",
        );
    });

    it("does not report the pipeline driver while Learn holds the item", async () => {
        (readStoredSummaries as Mock).mockResolvedValue([]);
        (pipelineMayQueue as Mock).mockResolvedValue(false);
        (getActiveJob as Mock).mockImplementation(
            async (kind: string, subjectId: string) =>
                kind === "pipeline.advance" && subjectId === "rec-1"
                    ? {
                          id: "pipeline-job-1",
                          kind: "pipeline.advance",
                          userId: "user-1",
                          status: "pending",
                          progress: null,
                      }
                    : null,
        );

        const response = await GET(
            new Request(
                "http://localhost/api/recordings/rec-1/summary?source=riffado",
            ),
            { params: Promise.resolve({ id: "rec-1" }) },
        );

        expect((await response.json()).activeJob).toBeUndefined();
        expect(pipelineMayQueue).toHaveBeenCalledWith(
            "user-1",
            "rec-1",
            "summary",
        );
    });
    it("returns agenda presence even when no summary exists", async () => {
        vi.mocked(readStoredSummaries).mockResolvedValue([]);
        const response = await GET(
            new Request("http://localhost/api/recordings/rec-1/summary"),
            { params: Promise.resolve({ id: "rec-1" }) },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            summary: null,
            hasAgenda: false,
            agendaCandidateCount: 0,
        });
    });
});
