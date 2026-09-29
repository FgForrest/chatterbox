"use client";

import { useExtracted } from "next-intl";
import { Fragment } from "react";
import {
    type LearnCorrectionMark,
    type LearnMarks,
    markedSegments,
} from "@/components/learn/learn-marks";

/**
 * A turn's text with a ready review's corrections underlined in place,
 * each ticked or unticked in the review from here.
 */
export function MarkedText({
    text,
    marks,
    decide,
}: {
    text: string;
    marks: readonly LearnCorrectionMark[];
    decide: LearnMarks["decide"];
}) {
    const i18n = useExtracted();
    return markedSegments(text, marks).map((segment, index) => {
        const mark = segment.mark;
        if (!mark) {
            return (
                // Segments are fixed by the text and its marks.
                // biome-ignore lint/suspicious/noArrayIndexKey: stable order
                <Fragment key={index}>{segment.text}</Fragment>
            );
        }
        const words = { heard: segment.text, suggestion: mark.suggestion };
        return (
            <button
                // biome-ignore lint/suspicious/noArrayIndexKey: stable order
                key={index}
                type="button"
                className={`rounded-sm underline decoration-amber-500 decoration-2 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${mark.ticked ? "bg-amber-500/15" : "decoration-dotted"}`}
                aria-pressed={mark.ticked}
                title={i18n(
                    "Learn suggests {suggestion}. Applied when you finish the review.",
                    { suggestion: mark.suggestion },
                )}
                aria-label={
                    mark.ticked
                        ? i18n(
                              "{heard} → {suggestion}, ticked in the review: untick",
                              words,
                          )
                        : i18n(
                              "{heard} → {suggestion}: accept in the review",
                              words,
                          )
                }
                onClick={() =>
                    decide(mark.itemId, mark.ticked ? "rejected" : "accepted")
                }
            >
                {segment.text}
            </button>
        );
    });
}
