import { describe, expect, it } from "vitest";
import { processingStartedBy } from "@/lib/pipeline/processing-origin";

const JOB_KINDS = {
    transcription: "transcription",
    summary: "summary",
    topics: "topics",
};

describe("processing presentation request origin", () => {
    it("uses the latest durable job payload for each rerunnable step", () => {
        expect(
            processingStartedBy(
                [
                    {
                        kind: "summary",
                        payload: { trigger: "manual" },
                        createdAt: new Date("2026-10-16T09:00:00.000Z"),
                    },
                    {
                        kind: "summary",
                        payload: { trigger: "auto" },
                        createdAt: new Date("2026-10-16T08:00:00.000Z"),
                    },
                    {
                        kind: "transcription",
                        payload: { trigger: "pipeline" },
                        createdAt: new Date("2026-10-16T08:30:00.000Z"),
                    },
                    {
                        kind: "topics",
                        payload: { trigger: "manual" },
                        createdAt: new Date("2026-10-16T09:15:00.000Z"),
                    },
                ],
                JOB_KINDS,
            ),
        ).toEqual({
            transcription: "pipeline",
            summary: "person",
            topics: "person",
        });
    });

    it("returns null when no durable request identifies the starter", () => {
        expect(
            processingStartedBy(
                [
                    {
                        kind: "summary",
                        payload: {},
                        createdAt: new Date("2026-10-16T09:00:00.000Z"),
                    },
                ],
                JOB_KINDS,
            ),
        ).toEqual({ transcription: null, summary: null, topics: null });
    });
});
