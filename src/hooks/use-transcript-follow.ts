"use client";

import { type RefObject, useEffect, useRef, useState } from "react";

/** Where the audio is, as the transcript follows it. */
export interface PlaybackState {
    ms: number;
    playing: boolean;
}

/** The player, as a transcript drives and follows it. */
export interface TranscriptPlayback {
    /** Seek to `ms` and play. */
    play: (ms: number) => void;
    pause: () => void;
    /** Seek to `ms`, playing or not as before. */
    seek: (ms: number) => void;
    /** Called with the state now and on every change; returns the unsubscribe. */
    subscribe: (listener: (state: PlaybackState) => void) => () => void;
}

/** Where an active sentence is put when the transcript scrolls to it. */
const READING_LINE = 1 / 3;
/** An active sentence below this fraction of the box scrolls it. */
const FOLLOW_BOTTOM = 0.75;
/** A scroll this soon after a wheel, touch or key is the reader's. */
const INTENT_MS = 600;
/** The reader's scroll seeks once it has been still this long. */
const SETTLE_MS = 180;
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End"]);

/**
 * How far down a scroll box its reading line is, as a fraction of its
 * height: a third of the way down, except that it slides to the top as the
 * box reaches its top and to the bottom as it reaches its bottom, so the
 * first and last sentences can be scrolled to as well.
 */
export function readingLineFraction(
    scrollTop: number,
    clientHeight: number,
    scrollHeight: number,
): number {
    const max = Math.max(0, scrollHeight - clientHeight);
    const ramp = clientHeight * READING_LINE;
    if (ramp <= 0) return 0;
    const top = READING_LINE * Math.min(1, scrollTop / ramp);
    const bottom =
        (1 - READING_LINE) * Math.max(0, 1 - (max - scrollTop) / ramp);
    return Math.min(1, top + bottom);
}

/** Index of the sentence playing at `ms`: the last to start by then, or -1. */
export function sentenceIndexAt(
    startsMs: readonly number[],
    ms: number,
): number {
    let found = -1;
    startsMs.forEach((start, index) => {
        if (start <= ms && (found < 0 || start >= startsMs[found])) {
            found = index;
        }
    });
    return found;
}

/** A rendered sentence of the transcript under `root`, by sentence index. */
export function sentenceElement(
    root: HTMLElement,
    index: number,
): HTMLElement | null {
    return root.querySelector<HTMLElement>(
        `[data-sentence="${index}"]:not([data-marker])`,
    );
}

/** The sentence on the box's reading line: the last whose first line starts above it. */
function sentenceOnReadingLine(
    root: HTMLElement,
    box: HTMLElement,
): number | null {
    const boxTop = box.getBoundingClientRect().top;
    const line =
        boxTop +
        box.clientHeight *
            readingLineFraction(
                box.scrollTop,
                box.clientHeight,
                box.scrollHeight,
            );
    let found: number | null = null;
    for (const element of root.querySelectorAll<HTMLElement>(
        "[data-sentence]",
    )) {
        if (element.dataset.marker !== undefined) continue;
        const first = element.getClientRects()[0];
        if (!first) continue;
        if (first.top > line) break;
        found = Number(element.dataset.sentence);
    }
    if (found === null) {
        const first = root.querySelector<HTMLElement>(
            "[data-sentence]:not([data-marker])",
        );
        return first ? Number(first.dataset.sentence) : null;
    }
    return found;
}

/**
 * Keeps a transcript and its player on one position.
 *
 * The audio moves the transcript: the sentence being played is marked, and
 * the scroll box follows it out of view. The reader moves the audio: a
 * scroll they make (wheel, touch, scrollbar or paging keys) seeks to the
 * sentence on the reading line once it settles, playing or not. Scrolls the
 * page makes itself never seek, so following cannot feed back into seeking.
 */
export function useTranscriptFollow({
    rootRef,
    scrollRef,
    playback,
    startsMs,
    holdScroll,
}: {
    rootRef: RefObject<HTMLElement | null>;
    /** The scroll box the transcript sits in, if any. */
    scrollRef?: RefObject<HTMLElement | null>;
    playback?: TranscriptPlayback;
    /** When each rendered sentence starts playing, by sentence index. */
    startsMs: readonly number[];
    /** Another scroll is in flight (a topic or speaker jump): do not follow. */
    holdScroll: boolean;
}): { active: number | null; playing: boolean } {
    const [state, setState] = useState<{
        active: number | null;
        playing: boolean;
    }>({ active: null, playing: false });
    const playbackRef = useRef(playback);
    playbackRef.current = playback;
    const startsRef = useRef(startsMs);
    startsRef.current = startsMs;
    const holdRef = useRef(holdScroll);
    holdRef.current = holdScroll;
    const activeRef = useRef<number | null>(null);
    activeRef.current = state.active;
    const readerScrollingRef = useRef(false);
    const subscribed = playback !== undefined;

    useEffect(() => {
        if (!subscribed) return;
        let touched = false;
        return playbackRef.current?.subscribe(({ ms, playing }) => {
            touched ||= playing || ms > 0;
            const index = touched ? sentenceIndexAt(startsRef.current, ms) : -1;
            const active = index >= 0 ? index : null;
            setState((current) =>
                current.active === active && current.playing === playing
                    ? current
                    : { active, playing },
            );
        });
    }, [subscribed]);

    useEffect(() => {
        const root = rootRef.current;
        const box = scrollRef?.current;
        if (
            state.active === null ||
            !root ||
            !box ||
            holdRef.current ||
            readerScrollingRef.current
        ) {
            return;
        }
        const element = sentenceElement(root, state.active);
        const first = element?.getClientRects()[0];
        if (!first) return;
        const boxRect = box.getBoundingClientRect();
        if (
            first.top >= boxRect.top &&
            first.bottom <= boxRect.top + box.clientHeight * FOLLOW_BOTTOM
        ) {
            return;
        }
        const reduce = window.matchMedia?.(
            "(prefers-reduced-motion: reduce)",
        ).matches;
        box.scrollTo({
            top:
                box.scrollTop +
                (first.top - boxRect.top) -
                box.clientHeight * READING_LINE,
            behavior: reduce ? "auto" : "smooth",
        });
    }, [state.active, rootRef, scrollRef]);

    useEffect(() => {
        const box = scrollRef?.current;
        if (!subscribed || !box) return;
        let intentUntil = 0;
        let dragging = false;
        let settle: ReturnType<typeof setTimeout> | undefined;
        const intend = () => {
            intentUntil = Date.now() + INTENT_MS;
        };
        const onKey = (event: KeyboardEvent) => {
            if (SCROLL_KEYS.has(event.key)) intend();
        };
        const onPointerDown = (event: PointerEvent) => {
            // The scrollbar is the box itself; its content is not.
            if (event.target === box) dragging = true;
        };
        const onPointerUp = () => {
            if (!dragging) return;
            dragging = false;
            intend();
        };
        const onScroll = () => {
            if (!dragging && Date.now() > intentUntil) return;
            readerScrollingRef.current = true;
            clearTimeout(settle);
            settle = setTimeout(() => {
                readerScrollingRef.current = false;
                const root = rootRef.current;
                if (!root) return;
                const index = sentenceOnReadingLine(root, box);
                if (index === null || index === activeRef.current) return;
                const ms = startsRef.current[index];
                if (Number.isFinite(ms)) playbackRef.current?.seek(ms);
            }, SETTLE_MS);
        };
        box.addEventListener("wheel", intend, { passive: true });
        box.addEventListener("touchmove", intend, { passive: true });
        box.addEventListener("keydown", onKey);
        box.addEventListener("pointerdown", onPointerDown);
        window.addEventListener("pointerup", onPointerUp);
        box.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            clearTimeout(settle);
            readerScrollingRef.current = false;
            box.removeEventListener("wheel", intend);
            box.removeEventListener("touchmove", intend);
            box.removeEventListener("keydown", onKey);
            box.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("pointerup", onPointerUp);
            box.removeEventListener("scroll", onScroll);
        };
    }, [subscribed, rootRef, scrollRef]);

    return state;
}
