import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/queries/async-jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));

import { titleJobHandler } from "@/lib/recordings/title-job-handler";

describe("legacy title jobs", () => {
    it("drains a previously queued job without generating a title", async () => {
        await expect(
            titleJobHandler.run({
                jobId: "job-1",
                userId: "user-1",
                attempt: 1,
                maxAttempts: 3,
                payload: { recordingId: "recording-1" },
                signal: new AbortController().signal,
                reportProgress: () => {},
            }),
        ).resolves.toEqual({ skipped: "superseded" });
    });
});
