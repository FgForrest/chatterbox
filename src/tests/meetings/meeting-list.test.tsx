// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { createRef } from "react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    RecordingList,
    type RecordingListHandle,
} from "@/components/dashboard/recording-list";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import type { Recording } from "@/types/recording";
import { row } from "./ui-fixtures";

vi.mock("next-intl", () => ({
    useExtracted:
        () =>
        (text: string | { message: string }, values?: TranslationValues) =>
            translatedSourceMessage(
                "en",
                typeof text === "string" ? text : text.message,
                values,
            ),
    useLocale: () => "en",
    useFormatter: () => ({
        dateTime: (value: Date) => value.toISOString().slice(0, 16),
    }),
}));
vi.mock("@/components/dashboard/recording-row", () => ({
    RecordingRow: ({
        recording,
        onSelect,
    }: {
        recording: Recording;
        onSelect: (recording: Recording) => void;
    }) => (
        <button type="button" onClick={() => onSelect(recording)}>
            {recording.filename}
        </button>
    ),
}));
beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: vi.fn(),
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    vi.stubGlobal(
        "IntersectionObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
function mount() {
    const ref = createRef<RecordingListHandle>();
    const onSelectMeeting = vi.fn();
    const onSelect = vi.fn();
    const recording: Recording = {
        id: "recording",
        filename: "Past recording",
        duration: 1,
        filesize: 1,
        startTime: "2026-10-26T10:00:00Z",
        deviceSn: "test",
    };
    render(
        <RecordingList
            ref={ref}
            recordings={[recording]}
            meetings={[
                row(),
                row({
                    id: "manual",
                    meetingItemId: "manual-item",
                    title: "Untimed agenda",
                    start: null,
                    end: null,
                    timeSet: false,
                    createdAt: "2026-10-27T11:00:00Z",
                }),
            ]}
            currentRecording={null}
            transcriptions={new Map()}
            pendingUploads={[]}
            inFlightActions={new Map()}
            onSelect={onSelect}
            onSelectMeeting={onSelectMeeting}
            onDelete={vi.fn()}
            initialDateTimeFormat="absolute"
            initialSortOrder="newest"
            initialChunkSize={20}
            header={(count) => <span>{count} items</span>}
        />,
    );
    return { ref, onSelectMeeting, onSelect };
}
it("puts future agendas under Upcoming and keeps untimed agendas on their creation date", () => {
    mount();
    expect(screen.getByText("Upcoming")).toBeTruthy();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("No scheduled time")).toBeTruthy();
    expect(screen.getByText("3 items")).toBeTruthy();
    const titles = screen
        .getAllByRole("button")
        .map((button) => button.textContent)
        .filter(
            (text) =>
                text?.includes("agenda") ||
                text?.includes("planning") ||
                text?.includes("Past recording"),
        );
    expect(titles[0]).toContain("Acme planning");
    expect(titles[1]).toContain("Untimed agenda");
    expect(titles[2]).toBe("Past recording");
});
it("includes meeting rows in keyboard navigation and title search", () => {
    const { ref, onSelectMeeting } = mount();
    act(() => ref.current?.next());
    expect(onSelectMeeting).toHaveBeenCalledWith("agenda");
    fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Untimed" },
    });
    expect(screen.queryByText("Acme planning")).toBeNull();
    expect(screen.getByText("Untimed agenda")).toBeTruthy();
    expect(screen.getByText("1 items")).toBeTruthy();
});
