// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";
import { PlaybackProvider } from "@/components/playback/playback-context";
import { createTestPlayback } from "@/tests/helpers/playback";

const summary = vi.hoisted(() => ({ disabled: false, run: vi.fn() }));
vi.mock("@/components/summary/summary-widget", () => ({
    SummaryWidget: ({
        source,
        onSourceChange,
        onResummarizeReady,
    }: {
        source: string;
        onSourceChange: (source: "plaud" | "riffado") => void;
        onResummarizeReady: (
            action: { run: () => void; disabled: boolean } | null,
        ) => void;
    }) => {
        const disabled = summary.disabled || source !== "riffado";
        useEffect(() => {
            onResummarizeReady({ run: summary.run, disabled });
            return () => onResummarizeReady(null);
        }, [onResummarizeReady, disabled]);
        return (
            <button
                type="button"
                onClick={() =>
                    onSourceChange(source === "riffado" ? "plaud" : "riffado")
                }
            >
                Switch summary source
            </button>
        );
    },
}));
vi.mock("@/components/learn/learn-review", () => ({ LearnReview: () => null }));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));

const turns = [
    { speaker: "speaker_0", startMs: 0, endMs: 10000, text: "Opening." },
    { speaker: "speaker_1", startMs: 10000, endMs: 11000, text: "Brief." },
    { speaker: "speaker_0", startMs: 11000, endMs: 60000, text: "Discussion." },
];
const topics = turns.map((turn) => ({
    title: turn.text,
    fromMs: turn.startMs,
    toMs: turn.endMs,
}));
const seek = vi.fn();
const play = vi.fn();
const fetchMock = vi.fn();

function panelElement(
    hasTopics = true,
    readOnly = false,
    isTranscribing = false,
) {
    return (
        <PlaybackProvider
            playback={createTestPlayback({ seek, play }).playback}
        >
            <TranscriptionPanel
                recording={{
                    id: "rec-card",
                    filename: "Meeting",
                    duration: 60000,
                    filesize: 100,
                    startTime: new Date(0).toISOString(),
                    deviceSn: "local",
                }}
                transcripts={[
                    {
                        source: "riffado",
                        text: turns
                            .map((turn) => `${turn.speaker}: ${turn.text}`)
                            .join("\n"),
                        language: "cs",
                        provider: "Test provider",
                        model: "Test model",
                        turns,
                        topics: hasTopics ? topics : null,
                    },
                ]}
                readOnly={readOnly}
                isTranscribing={isTranscribing}
                onTranscribe={vi.fn()}
            />
        </PlaybackProvider>
    );
}

function panel(hasTopics = true, readOnly = false) {
    return render(panelElement(hasTopics, readOnly));
}

function collapse() {
    fireEvent.click(
        screen.getByRole("button", { name: "Collapse transcript" }),
    );
}

function expand() {
    fireEvent.click(screen.getByRole("button", { name: "Expand transcript" }));
}

function expectCollapsed() {
    expect(
        screen.queryByRole("region", { name: "Transcript content" }),
    ).toBeNull();
    expect(
        screen.queryByRole("group", { name: "Transcript speakers" }),
    ).toBeNull();
    expect(
        screen.queryByRole("button", { name: /Opening\. 1 \/ 3/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Detect topics" })).toBeNull();
    const card = document.getElementById("recording-transcription-rec-card");
    expect(card?.querySelector("footer")?.closest("[hidden]")).toBeTruthy();
}

function openTopics() {
    fireEvent.keyDown(
        screen.getByRole("button", { name: /Opening\. 1 \/ 3/ }),
        {
            key: "Enter",
        },
    );
}

describe("transcript card behavior", () => {
    beforeEach(() => {
        summary.run.mockReset();
        summary.disabled = false;
        seek.mockReset();
        play.mockReset();
        fetchMock
            .mockReset()
            .mockImplementation(async () =>
                Response.json({ speakers: [], corrections: [] }),
            );
        vi.stubGlobal("fetch", fetchMock);
        vi.spyOn(
            HTMLElement.prototype,
            "offsetHeight",
            "get",
        ).mockImplementation(function (this: HTMLElement) {
            return this.hasAttribute("data-chapter-bar") ? 48 : 20;
        });
        vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
            300,
        );
        vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
            1300,
        );
        vi.spyOn(
            HTMLElement.prototype,
            "getBoundingClientRect",
        ).mockImplementation(function (this: HTMLElement) {
            const top =
                this.tagName === "SECTION"
                    ? 100
                    : (this.dataset.topicIndex === "2" ? 680 : 660) -
                      (this.closest("section")?.scrollTop ?? 0);
            return {
                top,
                bottom: top + 20,
                height: 20,
                width: 300,
                left: 0,
                right: 300,
                x: 0,
                y: top,
                toJSON: () => ({}),
            };
        });
        HTMLElement.prototype.scrollTo = vi.fn();
    });
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("drops a disabled re-summarize click instead of running later", async () => {
        fetchMock.mockImplementation(async (url: string) =>
            Response.json(
                url.endsWith("/language")
                    ? {
                          confirmedLanguage: "hu",
                          needsResummary: true,
                          canChange: true,
                      }
                    : { speakers: [], corrections: [] },
            ),
        );
        const view = panel();
        const button = await screen.findByRole("button", {
            name: "Re-summarize",
        });
        await waitFor(() => expect(button).toHaveProperty("disabled", false));
        fireEvent.click(
            screen.getByRole("button", { name: "Switch summary source" }),
        );
        expect(button).toHaveProperty("disabled", true);
        fireEvent.click(button);
        fireEvent.click(
            screen.getByRole("button", { name: "Switch summary source" }),
        );
        await waitFor(() => expect(button).toHaveProperty("disabled", false));
        expect(summary.run).not.toHaveBeenCalled();
        summary.disabled = true;
        view.rerender(panelElement());
        await waitFor(() => expect(button).toHaveProperty("disabled", true));
        fireEvent.click(button);
        summary.disabled = false;
        view.rerender(panelElement());
        await waitFor(() => expect(button).toHaveProperty("disabled", false));
        expect(summary.run).not.toHaveBeenCalled();
        fireEvent.click(button);
        expect(summary.run).toHaveBeenCalledOnce();
    });

    it("hides the collapsed body and footer, then navigates topics after expanding", () => {
        panel();
        const turn = document.querySelector("[data-turn-index]");
        const boxBeforeCollapse = screen.getByRole("region", {
            name: "Transcript content",
        });
        collapse();
        expectCollapsed();
        expect(document.querySelector("[data-turn-index]")).toBe(turn);
        expand();
        expect(screen.getByRole("region", { name: "Transcript content" })).toBe(
            boxBeforeCollapse,
        );
        expect(
            document.querySelector("[data-chapter-bar]")?.className,
        ).toContain("sticky");
        openTopics();
        expect(
            screen.getByRole("menuitem", { name: "Re-detect topics" }),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("menuitem", { name: /2.*Brief/ }));
        expect(seek).toHaveBeenCalledWith(10000);
        expect(
            screen.getByRole("button", { name: "Collapse transcript" }),
        ).toBeTruthy();
        expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith({
            top: 504,
            behavior: "smooth",
        });
        const box = screen.getByRole("region", { name: "Transcript content" });
        box.scrollTop = 500;
        fireEvent.scroll(box);
        expect(
            screen.getByRole("button", { name: /Brief\. 2 \/ 3/ }),
        ).toBeTruthy();
        collapse();
        expand();
        expect(
            screen.getByRole("button", { name: /Brief\. 2 \/ 3/ }),
        ).toBeTruthy();
        fireEvent.wheel(box);
        fireEvent.scroll(box);
        expect(
            screen.getByRole("button", { name: /Discussion\. 3 \/ 3/ }),
        ).toBeTruthy();
    });

    it("shows re-transcription progress on a collapsed card", () => {
        const view = panel();
        collapse();
        expectCollapsed();
        view.rerender(panelElement(true, false, true));
        expect(
            screen.getByText("Transcribing audio…").closest("[hidden]"),
        ).toBeNull();
        view.rerender(panelElement());
        expectCollapsed();
    });

    it("runs re-detection after expanding the card", async () => {
        panel();
        collapse();
        expectCollapsed();
        expand();
        openTopics();
        fireEvent.click(
            screen.getByRole("menuitem", { name: "Re-detect topics" }),
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/rec-card/topics?source=riffado",
                expect.objectContaining({ method: "POST" }),
            ),
        );
    });

    it("offers detection after expanding without topics", async () => {
        panel(false);
        collapse();
        expectCollapsed();
        expand();
        fireEvent.click(screen.getByRole("button", { name: "Detect topics" }));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/rec-card/topics?source=riffado",
                expect.objectContaining({ method: "POST" }),
            ),
        );
    });

    it("hides the Learn hold note until expanded", async () => {
        fetchMock.mockImplementation(async (url: string) =>
            Response.json(
                url.includes("/follow-ups")
                    ? { held: true, pending: [] }
                    : { speakers: [] },
            ),
        );
        panel(false);
        await screen.findByText("Topics follow the Learn review");
        collapse();
        expectCollapsed();
        expect(
            screen
                .getByText("Topics follow the Learn review")
                .closest("[hidden]"),
        ).toBeTruthy();
        expand();
        expect(
            await screen.findByText("Topics follow the Learn review"),
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Detect topics" }),
        ).toBeNull();
    });

    it("restores speaker playback and metadata after expanding", () => {
        panel();
        collapse();
        expectCollapsed();
        expand();
        expect(
            screen.getByText("Test provider").closest("[hidden]"),
        ).toBeNull();
        expect(screen.getByText("Test model")).toBeTruthy();
        expect(screen.getByText("Czech (detected)").textContent).toContain(
            "Czech",
        );
        expect(screen.getByText("words", { exact: false })).toBeTruthy();
        expect(screen.getByText("characters", { exact: false })).toBeTruthy();
        fireEvent.click(
            screen.getByRole("button", {
                name: "Play the next turn of Speaker 1",
            }),
        );
        expect(play).toHaveBeenCalledWith(10000, expect.any(String), undefined);
        expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith({
            top: 504,
            behavior: "smooth",
        });
    });

    it("hides the Organization note with read-only chips", async () => {
        panel(true, true);
        expect(screen.getByText("Managed by the Organization")).toBeTruthy();
        collapse();
        expectCollapsed();
        expect(
            screen.getByText("Managed by the Organization").closest("[hidden]"),
        ).toBeTruthy();
        expand();
        expect(
            screen.getByText("Managed by the Organization").closest("[hidden]"),
        ).toBeNull();
    });

    it("applies an in-flight speaker answer while the card is collapsed", async () => {
        let finishSave: (response: Response) => void = () => {};
        fetchMock.mockImplementation(
            async (_url: string, init?: RequestInit) => {
                if (init?.method === "PUT") {
                    return new Promise<Response>((resolve) => {
                        finishSave = resolve;
                    });
                }
                return Response.json({
                    transcriptionId: "transcript-1",
                    revision: 1,
                    speakers: [
                        {
                            label: "speaker_0",
                            personId: "person-jan",
                            personName: "Jan",
                            status: "confirmed",
                        },
                    ],
                });
            },
        );
        panel();
        fireEvent.click(
            await screen.findByRole("button", {
                name: "Unlink Jan from Speaker 0",
            }),
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/rec-card/speakers?source=riffado",
                expect.objectContaining({ method: "PUT" }),
            ),
        );
        collapse();
        finishSave(
            Response.json({
                transcriptionId: "transcript-1",
                revision: 1,
                speakers: [],
            }),
        );
        await waitFor(() => expect(screen.queryByText("Jan")).toBeNull());
        expand();
        expect(screen.queryByRole("button", { name: "Jan" })).toBeNull();
        expect(screen.getByRole("button", { name: "Speaker 0" })).toBeTruthy();
    });

    it("opens a confirmed speaker's picker with an Almanac link", async () => {
        fetchMock.mockImplementation(async () =>
            Response.json({
                speakers: [
                    {
                        label: "speaker_0",
                        personId: "person-jan",
                        personName: "Jan",
                        status: "confirmed",
                    },
                ],
            }),
        );
        panel();
        const name = await screen.findByRole("button", { name: "Jan" });
        expect(name.getAttribute("aria-haspopup")).toBe("dialog");
        fireEvent.click(name);
        expect(screen.getByRole("dialog")).toBeTruthy();
        expect(
            screen
                .getByRole("link", { name: "Open in Almanac" })
                .getAttribute("href"),
        ).toBe("/almanac/person-jan");
    });

    it("plays the next turn of a suggestion without evidence", async () => {
        fetchMock.mockImplementation(async () =>
            Response.json({
                speakers: [
                    {
                        label: "speaker_1",
                        personId: "person-jan",
                        personName: "Jan",
                        status: "suggested",
                    },
                ],
            }),
        );
        panel();
        const name = await screen.findByRole("button", { name: "Jan?" });
        expect(name.getAttribute("aria-haspopup")).toBe("dialog");
        const button = screen.getByRole("button", {
            name: "Play the next turn of Speaker 1",
        });
        expect(button).toHaveProperty("disabled", false);
        fireEvent.click(button);
        expect(play).toHaveBeenCalledWith(10000, expect.any(String), undefined);
    });
});
