"use client";

import { Pause, Play } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useState } from "react";
import { speakerAccent } from "@/components/people/speaker-accents";
import { sentenceElement } from "@/hooks/use-transcript-follow";

/** The marker's size, `size-5`. */
const MARKER_PX = 20;

/**
 * The play button in a transcript's left gutter, on the first line of the
 * sentence under the pointer, else of the sentence being played. It is a
 * pointer shortcut: clicks on it reach the transcript's own sentence click
 * handler through its `data-sentence`, and each paragraph's play button is
 * the keyboard path.
 */
export function TranscriptPlayMarker({
    rootRef,
    active,
    playing,
}: {
    rootRef: RefObject<HTMLElement | null>;
    active: number | null;
    playing: boolean;
}) {
    const [hovered, setHovered] = useState<number | null>(null);
    const [place, setPlace] = useState<{
        top: number;
        left: number;
        accent: number;
    } | null>(null);
    const target = hovered ?? active;

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const onOver = (event: MouseEvent) => {
            const sentence =
                event.target instanceof Element
                    ? event.target.closest<HTMLElement>("[data-sentence]")
                    : null;
            setHovered(sentence ? Number(sentence.dataset.sentence) : null);
        };
        const onLeave = () => setHovered(null);
        root.addEventListener("mouseover", onOver);
        root.addEventListener("mouseleave", onLeave);
        return () => {
            root.removeEventListener("mouseover", onOver);
            root.removeEventListener("mouseleave", onLeave);
        };
    }, [rootRef]);

    useLayoutEffect(() => {
        const root = rootRef.current;
        if (!root || target === null) {
            setPlace(null);
            return;
        }
        const measure = () => {
            const sentence = sentenceElement(root, target);
            const paragraph = sentence?.closest<HTMLElement>("[data-accent]");
            const line = sentence?.getClientRects()[0];
            if (!paragraph || !line) {
                setPlace(null);
                return;
            }
            const rootRect = root.getBoundingClientRect();
            setPlace({
                top: line.top - rootRect.top + (line.height - MARKER_PX) / 2,
                left: paragraph.getBoundingClientRect().left - rootRect.left,
                accent: Number(paragraph.dataset.accent),
            });
        };
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(root);
        return () => observer.disconnect();
    }, [rootRef, target]);

    if (!place || target === null) return null;
    const accent = speakerAccent(place.accent);
    const pausing = playing && target === active;
    return (
        <span
            data-sentence={target}
            data-marker=""
            aria-hidden
            className={`absolute m-0 grid size-5 cursor-pointer place-items-center rounded-full transition-[top] duration-150 ease-out motion-reduce:transition-none ${pausing ? `${accent.dot} text-white` : `${accent.text} ${accent.soft}`}`}
            style={{ top: place.top, left: place.left }}
        >
            {pausing ? (
                <Pause className="size-3 fill-current" />
            ) : (
                <Play className="size-3 fill-current" />
            )}
        </span>
    );
}
