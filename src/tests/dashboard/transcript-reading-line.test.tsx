// @vitest-environment jsdom

import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type PlaybackState,
    type TranscriptPlayback,
    transcriptReadingLine,
    useTranscriptFollow,
} from "@/hooks/use-transcript-follow";

function geometry(top: number): DOMRect {
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
}

function scrollBox({
    bar = 48,
    height = 300,
    content = 1300,
    scroll = 500,
} = {}) {
    const box = document.createElement("section");
    const chapter = document.createElement("div");
    chapter.dataset.chapterBar = "";
    Object.defineProperty(chapter, "offsetHeight", { value: bar });
    box.append(chapter);
    Object.defineProperty(box, "clientHeight", { value: height });
    Object.defineProperty(box, "scrollHeight", { value: content });
    box.scrollTop = scroll;
    box.getBoundingClientRect = () => geometry(100);
    box.scrollTo = vi.fn();
    return box;
}

describe("transcript reading line", () => {
    it.each([
        { scroll: 0, expected: 148 },
        { scroll: 500, expected: 232 },
        { scroll: 1000, expected: 400 },
    ])("stays below the bar at scroll $scroll", ({ scroll, expected }) => {
        expect(transcriptReadingLine(scrollBox({ scroll }))).toBeCloseTo(
            expected,
        );
    });

    it("starts below the bar when the entire transcript fits", () => {
        expect(
            transcriptReadingLine(scrollBox({ content: 300, scroll: 0 })),
        ).toBe(148);
    });

    it("supports transcripts without a chapter bar", () => {
        const box = scrollBox();
        box.replaceChildren();
        expect(transcriptReadingLine(box)).toBeCloseTo(200);
    });

    it("clamps the remaining height when the bar fills the box", () => {
        expect(transcriptReadingLine(scrollBox({ height: 30, bar: 48 }))).toBe(
            148,
        );
    });
});

describe("transcript follow offsets", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    function harness() {
        const box = scrollBox();
        const root = document.createElement("div");
        const sentences = [180, 220].map((top, index) => {
            const sentence = document.createElement("span");
            sentence.dataset.sentence = String(index);
            sentence.getClientRects = () =>
                [geometry(top)] as unknown as DOMRectList;
            root.append(sentence);
            return sentence;
        });
        box.append(root);
        const scrollRef = createRef<HTMLElement>();
        scrollRef.current = box;
        const rootRef = createRef<HTMLElement>();
        rootRef.current = root;
        let listener: ((state: PlaybackState) => void) | undefined;
        const playback: TranscriptPlayback = {
            play: vi.fn(),
            pause: vi.fn(),
            seek: vi.fn(),
            subscribe: (next) => {
                listener = next;
                return () => {
                    listener = undefined;
                };
            },
        };
        renderHook(() =>
            useTranscriptFollow({
                rootRef,
                scrollRef,
                playback,
                startsMs: [0, 10000],
                holdScroll: false,
            }),
        );
        return {
            box,
            sentences,
            playback,
            emit: (state: PlaybackState) => act(() => listener?.(state)),
        };
    }

    it("subtracts the bar height and uses the remaining height for the follow target", () => {
        const { box, sentences, emit } = harness();
        sentences[1].getClientRects = () =>
            [geometry(600)] as unknown as DOMRectList;
        emit({ ms: 11000, playing: true });
        expect(box.scrollTo).toHaveBeenCalledWith({
            top: 500 + 600 - 100 - 48 - 252 / 3,
            behavior: "smooth",
        });
    });

    it("follows a sentence hidden under the chapter bar", () => {
        const { box, sentences, emit } = harness();
        sentences[0].getClientRects = () =>
            [geometry(130)] as unknown as DOMRectList;
        emit({ ms: 1000, playing: true });
        expect(box.scrollTo).toHaveBeenCalledWith({
            top: 500 + 130 - 100 - 48 - 252 / 3,
            behavior: "smooth",
        });
    });

    it("seeks the reader's sentence at the reading line below the bar", () => {
        const { box, playback } = harness();
        fireEvent.wheel(box);
        fireEvent.scroll(box);
        act(() => vi.advanceTimersByTime(180));
        expect(playback.seek).toHaveBeenCalledWith(10000);
    });
});
