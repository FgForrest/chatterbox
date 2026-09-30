// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { RecordingList } from "@/components/dashboard/recording-list";
import type { Recording } from "@/types/recording";

function recording(id: string, filename: string, needsReview = false) {
    return {
        id,
        filename,
        duration: 60_000,
        startTime: "2026-09-01T10:00:00.000Z",
        filesize: 11,
        deviceSn: "local",
        hasTranscript: true,
        hasSummary: false,
        audioReaped: false,
        waveformPeaks: null,
        ...(needsReview ? { needsReview: true } : {}),
    } as Recording;
}

// jsdom has no IntersectionObserver; the list uses one to load more rows.
class NoIntersections {
    observe() {}
    unobserve() {}
    disconnect() {}
}

function list(
    recordings: Recording[],
    transcriptions: Map<
        string,
        { text?: string; readText?: string }
    > = new Map(),
) {
    vi.stubGlobal("IntersectionObserver", NoIntersections);
    return render(
        <ConfirmDialogProvider>
            <RecordingList
                recordings={recordings}
                transcriptions={transcriptions}
                currentRecording={null}
                pendingUploads={[]}
                inFlightActions={new Map()}
                onSelect={vi.fn()}
                onDelete={vi.fn()}
                initialDateTimeFormat="relative"
                initialSortOrder="newest"
                initialChunkSize={50}
                onOrganize={vi.fn()}
            />
        </ConfirmDialogProvider>,
    );
}

describe("the Needs review filter", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("shows only the recordings a review waits on, when asked", () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
        list([recording("r1", "Weekly"), recording("r2", "Budget", true)]);
        expect(screen.getByText("Weekly")).toBeTruthy();
        fireEvent.click(
            screen.getByRole("button", { name: "Needs review (1)" }),
        );
        expect(screen.queryByText("Weekly")).toBeNull();
        expect(screen.getByText("Budget")).toBeTruthy();
    });

    it("is not offered while nothing waits", () => {
        list([recording("r1", "Weekly")]);
        expect(
            screen.queryByRole("button", { name: /Needs review/ }),
        ).toBeNull();
    });
});

describe("the list, as people read the transcript", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("previews the corrected text and finds a recording by either words", () => {
        list(
            [recording("r1", "Weekly"), recording("r2", "Budget")],
            new Map([
                [
                    "r1",
                    {
                        text: "speaker_0: Sanesi joined.",
                        readText: "speaker_0: Tavesi joined.",
                    },
                ],
                ["r2", { text: "speaker_0: Numbers." }],
            ]),
        );
        expect(screen.getByText(/Tavesi joined\./)).toBeTruthy();
        expect(screen.queryByText(/Sanesi joined\./)).toBeNull();
        const search = screen.getByRole("textbox", {
            name: "Search recordings",
        });
        for (const words of ["tavesi", "sanesi"]) {
            fireEvent.change(search, { target: { value: words } });
            expect(screen.getByText("Weekly")).toBeTruthy();
            expect(screen.queryByText("Budget")).toBeNull();
        }
    });
});
