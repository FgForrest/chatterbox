import { beforeEach, describe, expect, it, vi } from "vitest";

const { queriesMock, envMock } = vi.hoisted(() => ({
    queriesMock: {
        EXPORT_COOLDOWN_MS: 24 * 60 * 60 * 1000,
        createExportJob: vi.fn(),
        getActiveExportJobForUser: vi.fn(),
        getRecentCompletedExportJobForUser: vi.fn(),
        listExportJobsForUser: vi.fn(),
    },
    envMock: { IS_HOSTED: false },
}));

vi.mock("@/db/queries/export-jobs", () => queriesMock);
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));
vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "@/app/api/backup/route";

const HOUR_MS = 60 * 60 * 1000;

function job(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: "job-new",
        userId: "user-1",
        status: "pending",
        storageKey: null,
        fileSize: null,
        recordingCount: null,
        errorMessage: null,
        attempts: 0,
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
        expiresAt: null,
        ...overrides,
    };
}

const finishedAnHourAgo = job({
    id: "job-old",
    status: "completed",
    storageKey: "exports/user-1/job-old.zip",
    completedAt: new Date(Date.now() - HOUR_MS),
    expiresAt: new Date(Date.now() + 100 * HOUR_MS),
});

async function post() {
    const response = await POST(
        new Request("https://app.example.com/api/backup", { method: "POST" }),
    );
    return { status: response.status, body: await response.json() };
}

describe("POST /api/backup cooldown", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        queriesMock.getActiveExportJobForUser.mockResolvedValue(null);
        queriesMock.getRecentCompletedExportJobForUser.mockResolvedValue(
            finishedAnHourAgo,
        );
        queriesMock.createExportJob.mockResolvedValue(job());
    });

    it("hands back the archive finished an hour ago on hosted", async () => {
        envMock.IS_HOSTED = true;

        const { status, body } = await post();

        expect(status).toBe(200);
        expect(body.job.id).toBe("job-old");
        expect(queriesMock.createExportJob).not.toHaveBeenCalled();
    });

    it("builds a new archive on a self-hosted instance", async () => {
        envMock.IS_HOSTED = false;

        const { status, body } = await post();

        expect(status).toBe(202);
        expect(body.job.id).toBe("job-new");
        expect(queriesMock.createExportJob).toHaveBeenCalledWith("user-1");
    });

    it("still hands back a backup being built, self-hosted too", async () => {
        envMock.IS_HOSTED = false;
        queriesMock.getActiveExportJobForUser.mockResolvedValue(
            job({ id: "job-running", status: "processing" }),
        );

        const { status, body } = await post();

        expect(status).toBe(202);
        expect(body.job.id).toBe("job-running");
        expect(queriesMock.createExportJob).not.toHaveBeenCalled();
    });
});
