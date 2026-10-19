// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";

vi.mock("@/components/summary/summary-widget", () => ({
    SummaryWidget: () => null,
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

function panel(hasTopics = true) {
    return render(
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
                    turns,
                    topics: hasTopics ? topics : null,
                },
            ]}
            isTranscribing={false}
            onTranscribe={vi.fn()}
            onSeekToTurn={seek}
            onPlayFromTurn={play}
        />,
    );
}

function collapse() {
    fireEvent.click(
        screen.getByRole("button", { name: "Collapse transcript" }),
    );
}

function openTopics() {
    fireEvent.keyDown(screen.getByRole("button", { name: /1 \/ 3 Opening/ }), {
        key: "Enter",
    });
}

describe("transcript card behavior", () => {
    beforeEach(() => {
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

    it("keeps collapsed topics and re-detection, then seeks and expands a short topic below the bar", () => {
        panel();
        collapse();
        expect(document.querySelector("[data-turn-index]")).toBeNull();
        expect(
            document.querySelector("[data-chapter-bar]")?.className,
        ).not.toContain("sticky");
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
            screen.getByRole("button", { name: /2 \/ 3 Brief/ }),
        ).toBeTruthy();
        fireEvent.wheel(box);
        fireEvent.scroll(box);
        expect(
            screen.getByRole("button", { name: /3 \/ 3 Discussion/ }),
        ).toBeTruthy();
    });

    it("runs re-detection from the collapsed card", async () => {
        panel();
        collapse();
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

    it("offers detection while collapsed without topics", async () => {
        panel(false);
        collapse();
        fireEvent.click(screen.getByRole("button", { name: "Detect topics" }));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/rec-card/topics?source=riffado",
                expect.objectContaining({ method: "POST" }),
            ),
        );
    });

    it("keeps the Learn hold note while collapsed", async () => {
        fetchMock.mockImplementation(async (url: string) =>
            Response.json(
                url.includes("/follow-ups")
                    ? { held: true, pending: [] }
                    : { speakers: [] },
            ),
        );
        panel(false);
        collapse();
        expect(
            await screen.findByText("Topics follow the Learn review"),
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Detect topics" }),
        ).toBeNull();
    });

    it("subtracts the bar height from a speaker jump and expands the card", () => {
        panel();
        collapse();
        fireEvent.click(
            screen.getByRole("button", {
                name: "Play the next turn of Speaker 1",
            }),
        );
        expect(play).toHaveBeenCalledWith(10000);
        expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith({
            top: 504,
            behavior: "smooth",
        });
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
        expect(play).toHaveBeenCalledWith(10000);
    });
});
