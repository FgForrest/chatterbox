// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiCostSummary } from "@/components/recordings/ai-cost-summary";

vi.mock("next-intl", () => ({
    useExtracted: () => (message: string) => message,
}));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("AI cost summary", () => {
    it("names mail in its empty state", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                Response.json({
                    totalUsd: 0,
                    byOperation: {},
                    byService: {},
                    unknownByService: {},
                    unknownCount: 0,
                    requestCount: 0,
                }),
            ),
        );
        render(<AiCostSummary recordingId="mail-1" kind="mail" />);
        expect(
            await screen.findByText("No AI spend tracked for this mail"),
        ).toBeTruthy();
    });
});
