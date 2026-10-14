import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock("@/db", () => ({ db: { select: selectMock } }));
vi.mock("@/db/queries/async-jobs", () => ({ getActiveJob: vi.fn() }));
vi.mock("@/lib/pipeline/pending", () => ({
    pipelineMayQueue: vi.fn(),
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({
        user: { id: "user-1", email: "user@example.test" },
    }),
    requireApiSessionActor: vi.fn(),
}));
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/env", () => ({
    env: { AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 60 },
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/sharing/access", () => ({
    requestedRecordingView: (request: Request) =>
        new URL(request.url).searchParams.get("view") === "org"
            ? "org"
            : "private",
    recordingJobSubject: (id: string, view: string) =>
        view === "org" ? `org:${id}` : id,
    requireRecordingView: vi.fn().mockResolvedValue({
        recordingId: "recording-1",
        ownerUserId: "user-1",
        contentUserId: "user-1",
        role: "owner",
        shared: false,
        orgUserId: null,
        view: "private",
    }),
}));
vi.mock("@/lib/sharing/jobs", () => ({ getJobVisibleTo: vi.fn() }));

import { GET } from "@/app/api/recordings/[id]/topics/route";
import { getActiveJob } from "@/db/queries/async-jobs";
import { pipelineMayQueue } from "@/lib/pipeline/pending";

describe("GET /api/recordings/[id]/topics", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        selectMock.mockReturnValue({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([{ topics: null }]),
                }),
            }),
        });
        (getActiveJob as Mock).mockResolvedValue(null);
        (pipelineMayQueue as Mock).mockResolvedValue(true);
    });

    it("reports the private pipeline driver while automatic topics work is pending", async () => {
        (getActiveJob as Mock).mockImplementation(
            async (kind: string, subjectId: string) =>
                kind === "pipeline.advance" && subjectId === "recording-1"
                    ? {
                          id: "pipeline-job-1",
                          kind: "pipeline.advance",
                          userId: "user-1",
                          status: "processing",
                          payload: {
                              itemId: "recording-1",
                              view: "private",
                          },
                      }
                    : null,
        );

        const response = await GET(
            new Request(
                "http://localhost/api/recordings/recording-1/topics?source=riffado",
            ),
            { params: Promise.resolve({ id: "recording-1" }) },
        );

        expect(await response.json()).toEqual({
            topics: null,
            jobId: "pipeline-job-1",
            jobKind: "pipeline.advance",
        });
        expect(pipelineMayQueue).toHaveBeenCalledWith(
            "user-1",
            "recording-1",
            "topics",
        );
    });

    it("does not report the pipeline driver when automatic topics are off", async () => {
        (pipelineMayQueue as Mock).mockResolvedValue(false);
        (getActiveJob as Mock).mockImplementation(
            async (kind: string, subjectId: string) =>
                kind === "pipeline.advance" && subjectId === "recording-1"
                    ? {
                          id: "pipeline-job-1",
                          kind: "pipeline.advance",
                          userId: "user-1",
                          status: "processing",
                          payload: {
                              itemId: "recording-1",
                              view: "private",
                          },
                      }
                    : null,
        );

        const response = await GET(
            new Request(
                "http://localhost/api/recordings/recording-1/topics?source=riffado",
            ),
            { params: Promise.resolve({ id: "recording-1" }) },
        );

        expect(await response.json()).toEqual({
            topics: null,
            jobId: null,
        });
        expect(pipelineMayQueue).toHaveBeenCalledWith(
            "user-1",
            "recording-1",
            "topics",
        );
    });

    it("does not report the pipeline driver while Learn holds the item", async () => {
        (pipelineMayQueue as Mock).mockResolvedValue(false);
        (getActiveJob as Mock).mockImplementation(
            async (kind: string, subjectId: string) =>
                kind === "pipeline.advance" && subjectId === "recording-1"
                    ? {
                          id: "pipeline-job-1",
                          kind: "pipeline.advance",
                          userId: "user-1",
                          status: "processing",
                          payload: {
                              itemId: "recording-1",
                              view: "private",
                          },
                      }
                    : null,
        );

        const response = await GET(
            new Request(
                "http://localhost/api/recordings/recording-1/topics?source=riffado",
            ),
            { params: Promise.resolve({ id: "recording-1" }) },
        );

        expect(await response.json()).toEqual({
            topics: null,
            jobId: null,
        });
        expect(pipelineMayQueue).toHaveBeenCalledWith(
            "user-1",
            "recording-1",
            "topics",
        );
    });

    it("reports a matching topics job regardless of who enqueued it", async () => {
        (getActiveJob as Mock).mockImplementation(async (kind: string) =>
            kind === "topics"
                ? {
                      id: "topics-job-1",
                      kind: "topics",
                      userId: "organization-user",
                      status: "processing",
                      payload: { source: "riffado" },
                  }
                : null,
        );

        const response = await GET(
            new Request(
                "http://localhost/api/recordings/recording-1/topics?source=riffado&view=org",
            ),
            { params: Promise.resolve({ id: "recording-1" }) },
        );

        expect(await response.json()).toMatchObject({
            topics: null,
            jobId: "topics-job-1",
            jobKind: "topics",
        });
    });
});
