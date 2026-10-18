// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingList } from "@/components/dashboard/recording-list";
import type { Recording } from "@/types/recording";

vi.mock("next-intl", () => ({
    useExtracted: () => (input: string | { message: string }) =>
        typeof input === "string" ? input : input.message,
    useLocale: () => "en",
}));

vi.mock("@/components/dashboard/recording-row", () => ({
    RecordingRow: ({ recording }: { recording: Recording }) => (
        <div>{recording.filename}</div>
    ),
}));

class TestIntersectionObserver {
    observe() {}
    disconnect() {}
}

const uploaded: Recording = {
    id: "uploaded",
    filename: "Uploaded recording",
    duration: 1_000,
    startTime: "2026-10-16T10:00:00.000Z",
    filesize: 1_000,
    deviceSn: "uploaded",
};

beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("RecordingList upload reset", () => {
    it("clears a search that hides the completed upload", () => {
        const props = {
            recordings: [uploaded],
            transcriptions: new Map(),
            currentRecording: uploaded,
            pendingUploads: [],
            inFlightActions: new Map<string, "transcribing" | "summarizing">(),
            onSelect: vi.fn(),
            onDelete: vi.fn(),
            initialDateTimeFormat: "relative" as const,
            initialSortOrder: "name" as const,
            initialChunkSize: 50,
            onOrganize: vi.fn(),
        };
        const { rerender } = render(
            <RecordingList {...props} resetToRecentKey={0} />,
        );

        fireEvent.change(
            screen.getByRole("textbox", { name: "Search recordings" }),
            {
                target: { value: "different" },
            },
        );
        expect(screen.queryByText("Uploaded recording")).toBeNull();

        rerender(<RecordingList {...props} resetToRecentKey={1} />);

        expect(
            screen.getByRole("textbox", { name: "Search recordings" }),
        ).toHaveProperty("value", "");
        expect(screen.getByText("Uploaded recording")).toBeTruthy();
    });
});
