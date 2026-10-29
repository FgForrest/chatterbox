// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptChapterBar } from "@/components/dashboard/transcript-chapter-bar";
import { TranscriptView } from "@/components/dashboard/transcript-view";
import { PlaybackProvider } from "@/components/playback/playback-context";
import type {
    PlaybackState,
    TranscriptPlayback,
} from "@/hooks/use-transcript-follow";

const topics = [
    { title: "Opening", fromMs: 0, toMs: 10000 },
    {
        title: "A long second topic title that must fit a narrow card",
        fromMs: 10000,
        toMs: 30000,
    },
];
const turns = [
    { speaker: "speaker_0", startMs: 0, endMs: 10000, text: "Hello." },
    { speaker: "speaker_1", startMs: 10000, endMs: 30000, text: "Next." },
];

function Harness({
    hasTopics = true,
    canDetect = true,
    waitingForReview = false,
    detecting = false,
    hasCorrections = false,
    onSelect = vi.fn(),
    onDetect = vi.fn(),
    playback,
}: {
    hasTopics?: boolean;
    canDetect?: boolean;
    waitingForReview?: boolean;
    detecting?: boolean;
    hasCorrections?: boolean;
    onSelect?: (index: number) => void;
    onDetect?: () => void;
    playback?: TranscriptPlayback;
}) {
    const scrollRef = useRef<HTMLElement>(null);
    const [original, setOriginal] = useState(false);
    return (
        <PlaybackProvider playback={playback ?? null}>
            <section
                ref={scrollRef}
                aria-label="Transcript content"
                className="@container/transcription overflow-y-auto"
            >
                <TranscriptChapterBar
                    topics={hasTopics ? topics : null}
                    scrollRef={scrollRef}
                    canDetect={canDetect}
                    waitingForReview={waitingForReview}
                    detecting={detecting}
                    onDetect={onDetect}
                    onSelect={onSelect}
                    hasCorrections={hasCorrections}
                    showOriginal={original}
                    onShowOriginalChange={setOriginal}
                    widgetId="topics-test"
                />
                <TranscriptView
                    text="Hello. Next."
                    storedTurns={turns}
                    topics={hasTopics ? topics : null}
                    scrollRef={scrollRef}
                />
            </section>
        </PlaybackProvider>
    );
}

function rect(top: number, height = 20): DOMRect {
    return {
        x: 0,
        y: top,
        width: 300,
        height,
        top,
        bottom: top + height,
        left: 0,
        right: 300,
        toJSON: () => ({}),
    };
}

function openList() {
    fireEvent.keyDown(screen.getByRole("button", { name: /Opening 1 \/ 2/ }), {
        key: "Enter",
    });
}

describe("transcript chapter bar", () => {
    beforeEach(() => {
        vi.spyOn(
            HTMLElement.prototype,
            "getBoundingClientRect",
        ).mockImplementation(function (this: HTMLElement) {
            const box = this.closest("section");
            const scrollTop = box?.scrollTop ?? 0;
            if (this.tagName === "SECTION") return rect(100, 300);
            if (this.dataset.topicIndex !== undefined)
                return rect(
                    160 + Number(this.dataset.topicIndex) * 500 - scrollTop,
                );
            if (this.dataset.sentence !== undefined)
                return rect(
                    190 + Number(this.dataset.sentence) * 500 - scrollTop,
                );
            return rect(100);
        });
        vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
            function (this: HTMLElement) {
                const first = this.getBoundingClientRect();
                return {
                    0: first,
                    length: 1,
                    item: () => first,
                    [Symbol.iterator]: () => [first][Symbol.iterator](),
                };
            },
        );
        vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
            300,
        );
        vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
            1300,
        );
        vi.spyOn(
            HTMLElement.prototype,
            "offsetHeight",
            "get",
        ).mockImplementation(function (this: HTMLElement) {
            return this.hasAttribute("data-chapter-bar") ? 48 : 20;
        });
        HTMLElement.prototype.scrollTo = vi.fn(function (
            this: HTMLElement,
            options?: ScrollToOptions | number,
            y?: number,
        ) {
            this.scrollTop =
                typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
            this.dispatchEvent(new Event("scroll"));
        });
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it("tracks forward and backward reading across topic headings", () => {
        render(<Harness />);
        expect(
            screen.getByRole("button", { name: "Opening 1 / 2" }),
        ).toBeTruthy();
        const box = screen.getByRole("region", { name: "Transcript content" });
        box.scrollTop = 500;
        fireEvent.scroll(box);
        expect(
            screen.getByRole("button", { name: `${topics[1].title} 2 / 2` }),
        ).toBeTruthy();
        box.scrollTop = 100;
        fireEvent.scroll(box);
        expect(
            screen.getByRole("button", { name: "Opening 1 / 2" }),
        ).toBeTruthy();
    });

    it("starts at the first topic when the whole transcript fits without scrolling", () => {
        vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
            300,
        );
        vi.spyOn(
            HTMLElement.prototype,
            "getBoundingClientRect",
        ).mockImplementation(function (this: HTMLElement) {
            return rect(this.dataset.topicIndex === "1" ? 220 : 160);
        });
        render(<Harness />);
        expect(
            screen.getByRole("button", { name: "Opening 1 / 2" }),
        ).toBeTruthy();
    });

    it("updates when follow-along playback scrolls the transcript", () => {
        const listeners = new Set<(state: PlaybackState) => void>();
        const playback: TranscriptPlayback = {
            play: vi.fn(),
            pause: vi.fn(),
            seek: vi.fn(),
            subscribe: (listener) => {
                listeners.add(listener);
                listener({ ms: 0, playing: false });
                return () => {
                    listeners.delete(listener);
                };
            },
        };
        render(<Harness playback={playback} />);
        act(() => {
            for (const listener of listeners)
                listener({ ms: 11000, playing: true });
        });
        expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
        expect(
            screen.getByRole("button", { name: `${topics[1].title} 2 / 2` }),
        ).toBeTruthy();
        expect(playback.seek).not.toHaveBeenCalled();
    });

    it("uses playback before follow scrolling moves, then returns to paused reading", () => {
        const listeners = new Set<(state: PlaybackState) => void>();
        const playback: TranscriptPlayback = {
            play: vi.fn(),
            pause: vi.fn(),
            seek: vi.fn(),
            subscribe: (listener) => {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
        };
        HTMLElement.prototype.scrollTo = vi.fn();
        render(<Harness playback={playback} />);
        act(() => {
            for (const listener of listeners)
                listener({ ms: 11000, playing: true });
        });
        const box = screen.getByRole("region", { name: "Transcript content" });
        expect(box.scrollTop).toBe(0);
        expect(
            screen.getByRole("button", { name: `${topics[1].title} 2 / 2` }),
        ).toBeTruthy();
        fireEvent.scroll(box);
        expect(
            screen.getByRole("button", { name: `${topics[1].title} 2 / 2` }),
        ).toBeTruthy();
        act(() => {
            for (const listener of listeners)
                listener({ ms: 11000, playing: false });
        });
        expect(
            screen.getByRole("button", { name: "Opening 1 / 2" }),
        ).toBeTruthy();
    });

    it("lists topic numbers and times, selects a topic and keeps re-detection", () => {
        const onSelect = vi.fn();
        const onDetect = vi.fn();
        render(<Harness onSelect={onSelect} onDetect={onDetect} />);
        openList();
        const item = screen.getByRole("menuitem", {
            name: /2.*A long second topic.*00:10/,
        });
        fireEvent.click(item);
        expect(onSelect).toHaveBeenCalledWith(1);
        expect(screen.queryByRole("menu")).toBeNull();
        fireEvent.keyDown(
            screen.getByRole("button", { name: `${topics[1].title} 2 / 2` }),
            { key: "Enter" },
        );
        fireEvent.click(
            screen.getByRole("menuitem", { name: "Re-detect topics" }),
        );
        expect(onDetect).toHaveBeenCalledOnce();
    });

    it("keeps the chapter list read-only when detection is unavailable", () => {
        render(<Harness canDetect={false} />);
        openList();
        expect(screen.getAllByRole("menuitem")).toHaveLength(2);
        expect(
            screen.queryByRole("menuitem", { name: "Re-detect topics" }),
        ).toBeNull();
    });

    it.each([
        true,
        false,
    ])("shows the original switch only for corrections, with topics=%s", (hasTopics) => {
        const { rerender } = render(
            <Harness
                hasTopics={hasTopics}
                hasCorrections={false}
                canDetect={false}
            />,
        );
        expect(screen.queryByRole("switch")).toBeNull();
        rerender(
            <Harness hasTopics={hasTopics} hasCorrections canDetect={false} />,
        );
        const toggle = screen.getByRole("switch", { name: "Original text" });
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        fireEvent.click(toggle);
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        expect(toggle.closest("[data-chapter-bar]")).toBeTruthy();
    });

    it("offers detection without topics", () => {
        const onDetect = vi.fn();
        render(<Harness hasTopics={false} onDetect={onDetect} />);
        fireEvent.click(screen.getByRole("button", { name: "Detect topics" }));
        expect(onDetect).toHaveBeenCalledOnce();
    });

    it("explains the Learn hold without offering detection", () => {
        render(<Harness hasTopics={false} waitingForReview />);
        expect(screen.getByText("Topics follow the Learn review")).toBeTruthy();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("disables detection while it runs", () => {
        render(<Harness hasTopics={false} detecting />);
        expect(
            screen.getByRole("button", { name: "Detecting topics…" }),
        ).toHaveProperty("disabled", true);
    });

    it("renders no bar when there are no topics, corrections or detection action", () => {
        render(<Harness hasTopics={false} canDetect={false} />);
        expect(document.querySelector("[data-chapter-bar]")).toBeNull();
    });

    it("truncates the title and shortens the label below the card's 560px breakpoint", () => {
        render(<Harness hasCorrections />);
        expect(
            screen
                .getByRole("button", { name: "Opening 1 / 2" })
                .querySelector(".truncate"),
        ).toBeTruthy();
        expect(screen.getByText("Original").className).toContain(
            "@min-[560px]/transcription:hidden",
        );
        expect(screen.getByText("Original text").className).toContain(
            "hidden @min-[560px]/transcription:inline",
        );
        const bar = document.querySelector("[data-chapter-bar]");
        expect(bar?.className).toContain("sticky top-0");
        expect(bar?.className).toContain("min-w-0");
    });
});
