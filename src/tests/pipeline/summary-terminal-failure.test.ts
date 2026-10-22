import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: mocks.emitEvent }));

import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import { topicsJobHandler } from "@/lib/topics/topics-job-handler";
import { transcriptionJobHandler } from "@/lib/transcription/transcription-job-handler";

describe("pipeline terminal failure hooks", () => {
    it("retains the summary notification after settlement, including manual jobs", async () => {
        await summaryJobHandler.onTerminalFailure?.({
            jobId: "job-veln",
            userId: "owner-veln",
            payload: { recordingId: "item-veln", trigger: "manual" },
            errorCode: "PROVIDER_FAILED",
        });
        expect(mocks.emitEvent).toHaveBeenCalledWith(
            "summary.failed",
            "owner-veln",
            "item-veln",
            { error: "PROVIDER_FAILED" },
        );
    });
    it("removes hooks whose only purpose was pipeline state", () => {
        expect(topicsJobHandler.onTerminalFailure).toBeUndefined();
        expect(transcriptionJobHandler.onTerminalFailure).toBeUndefined();
    });
});
