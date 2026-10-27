// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/summary/summary-widget", () => ({
    SummaryWidget: () => <div data-testid="summary-and-tasks" />,
}));
vi.mock("@/components/learn/learn-review", () => ({ LearnReview: () => null }));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));

function panel(slots: { agenda?: ReactNode; nextMeeting?: ReactNode } = {}) {
    return render(
        <TranscriptionPanel
            {...slots}
            recording={{
                id: "rec-layout",
                filename: "Meeting",
                duration: 60000,
                filesize: 100,
                startTime: new Date(0).toISOString(),
                deviceSn: "local",
            }}
            transcripts={["plaud", "riffado"].map((source) => ({
                source,
                text: source === "plaud" ? "Hello." : "Custom text.",
                turns: [
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 60000,
                        text: source === "plaud" ? "Hello." : "Custom text.",
                    },
                ],
                topics: [
                    {
                        title: "A very long chapter title for a narrow transcript card",
                        fromMs: 0,
                        toMs: 60000,
                    },
                ],
            }))}
            isTranscribing={false}
            onTranscribe={vi.fn()}
        />,
    );
}

function openActions() {
    fireEvent.keyDown(
        screen.getByRole("button", { name: "Transcript actions" }),
        { key: "Enter" },
    );
}

describe("transcript card narrow controls", () => {
    const writeText = vi.fn();
    beforeEach(() => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) =>
                url.includes("/markdown/")
                    ? new Response("# Transcript")
                    : Response.json({ speakers: [], corrections: [] }),
            ),
        );
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });
        writeText.mockReset();
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("keeps accessible icon actions and hides their text at the container breakpoint", () => {
        const { container } = panel();
        expect(container.firstElementChild?.className).toContain(
            "@container/transcription",
        );
        for (const name of ["Re-transcribe", "Collapse transcript"]) {
            const control = screen.getByRole("button", { name });
            expect(control.className).toContain(
                "@max-[560px]/transcription:size-8",
            );
            expect(control.querySelector("span")?.className).toContain(
                "@max-[560px]/transcription:hidden",
            );
        }
        for (const name of [
            "Re-transcribe",
            "Transcript source",
            "Transcript actions",
        ]) {
            expect(
                screen.getByRole("button", { name }).getAttribute("title"),
            ).toBe(name);
        }
        const actions = screen.getByRole("button", {
            name: "Transcript actions",
        });
        expect(actions.parentElement?.className).toContain(
            "@min-[560px]/transcription:hidden",
        );
        expect(
            screen.getByRole("link", { name: "Download transcript Markdown" })
                .parentElement?.className,
        ).toContain("hidden");
    });

    it("keeps downloading and copying available from the narrow actions menu", async () => {
        panel();
        openActions();
        const download = screen.getByRole("menuitem", {
            name: "Download transcript Markdown",
        });
        expect(download.getAttribute("href")).toBe(
            "/api/recordings/rec-layout/markdown/transcript?source=plaud",
        );
        fireEvent.click(
            screen.getByRole("menuitem", { name: "Copy transcript Markdown" }),
        );
        await waitFor(() =>
            expect(writeText).toHaveBeenCalledWith("# Transcript"),
        );
    });

    it("switches transcript sources from the narrow icon menu", async () => {
        panel();
        fireEvent.keyDown(
            screen.getByRole("button", { name: "Transcript source" }),
            { key: "Enter" },
        );
        fireEvent.click(screen.getByRole("menuitemradio", { name: "Custom" }));
        expect(await screen.findByText("Custom text.")).toBeTruthy();
        expect(
            screen
                .getByRole("link", { name: "Download transcript Markdown" })
                .getAttribute("href"),
        ).toContain("source=riffado");
    });
    it("places recurring preparation and the absorbed agenda after summary/tasks and before the transcript", () => {
        panel({
            agenda: <div data-testid="absorbed-agenda" />,
            nextMeeting: <div data-testid="next-meeting" />,
        });
        expect(
            screen.getByTestId("summary-and-tasks").parentElement?.className,
        ).toContain("order-1");
        expect(
            screen.getByTestId("next-meeting").parentElement?.className,
        ).toContain("order-2");
        expect(
            screen.getByTestId("absorbed-agenda").parentElement?.className,
        ).toContain("order-3");
        expect(
            screen
                .getByRole("region", { name: "Transcript content" })
                .closest(".order-4"),
        ).toBeTruthy();
    });
    it("preserves the existing content layout for recordings without an agenda", () => {
        const { container } = panel();
        expect(
            screen.getByTestId("summary-and-tasks").parentElement?.className,
        ).toBe("contents");
        expect(container.querySelector(".order-4")).toBeNull();
    });
});
