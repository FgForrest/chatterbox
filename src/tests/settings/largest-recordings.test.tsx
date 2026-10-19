// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
    useExtracted: () => (message: string) => message,
}));

import { LargestRecordings } from "@/components/settings-sections/storage/largest-recordings";

describe("LargestRecordings", () => {
    afterEach(cleanup);

    it("opens the recording in the dashboard pane", () => {
        render(
            <LargestRecordings
                items={[
                    {
                        id: "rec / 1",
                        filename: "Large recording",
                        filesize: 1024,
                        duration: 60_000,
                        startTime: "2026-10-18T10:00:00.000Z",
                    },
                ]}
            />,
        );

        expect(
            screen
                .getByRole("link", { name: /Large recording/ })
                .getAttribute("href"),
        ).toBe("/dashboard?recording=rec+%2F+1");
    });
});
