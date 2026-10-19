import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ redirect }));

import RecordingDetailPage from "@/app/(app)/recordings/[id]/page";

describe("legacy recording detail route", () => {
    beforeEach(() => redirect.mockClear());

    it("opens an audio item in the dashboard pane", async () => {
        await RecordingDetailPage({
            params: Promise.resolve({ id: "rec-1" }),
            searchParams: Promise.resolve({}),
        });

        expect(redirect).toHaveBeenCalledExactlyOnceWith(
            "/dashboard?recording=rec-1",
        );
    });

    it("opens mail and preserves the dashboard evidence parameters", async () => {
        await RecordingDetailPage({
            params: Promise.resolve({ id: "mail / 1" }),
            searchParams: Promise.resolve({
                playFrom: "12000",
                evidenceSegment: "3",
                evidenceStart: "4",
                evidenceEnd: "19",
                ignored: "drop-me",
            }),
        });

        expect(redirect).toHaveBeenCalledExactlyOnceWith(
            "/dashboard?recording=mail+%2F+1&playFrom=12000&evidenceSegment=3&evidenceStart=4&evidenceEnd=19",
        );
    });

    it("opens an Organization item in the Organization pane", async () => {
        await RecordingDetailPage({
            params: Promise.resolve({ id: "shared-1" }),
            searchParams: Promise.resolve({ view: ["org", "private"] }),
        });

        expect(redirect).toHaveBeenCalledExactlyOnceWith(
            "/dashboard?recording=shared-1&view=org",
        );
    });
});
