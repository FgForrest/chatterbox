"use client";

import { useExtracted } from "next-intl";
import { Fragment, useState } from "react";
import type { RenderedSegment } from "@/lib/learn/render";

/**
 * A turn's text as people read it: replacements applied (what was heard on
 * hover; the correction pass's in their own colour), a link kept as spoken
 * (what it means on hover). Whoever may
 * change the recording undoes a correction in two steps: the words, then
 * "Undo".
 */
export function CorrectedText({
    segments,
    onUndo,
}: {
    segments: readonly RenderedSegment[];
    /** Absent for a reader who may not undo. */
    onUndo?: (correctionId: string) => void;
}) {
    const i18n = useExtracted();
    const [open, setOpen] = useState<number | null>(null);
    return segments.map((segment, index) => {
        const correction = segment.correction;
        if (!correction) {
            return (
                // Segments are fixed by the text and its corrections.
                // biome-ignore lint/suspicious/noArrayIndexKey: stable order
                <Fragment key={index}>{segment.text}</Fragment>
            );
        }
        let title = i18n("Heard as {heard}", { heard: correction.heard });
        let colour = "decoration-emerald-500/70";
        if (correction.kind === "link") {
            title = correction.meaning;
            colour = "decoration-sky-500/70";
        } else if (correction.kind === "fix") {
            title = i18n("Corrected automatically. Heard as {heard}", {
                heard: correction.heard,
            });
            colour = "decoration-amber-500/70";
        }
        const style = `underline ${colour} decoration-dotted underline-offset-4`;
        if (!onUndo || !correction.id) {
            return (
                // biome-ignore lint/suspicious/noArrayIndexKey: stable order
                <span key={index} className={style} title={title}>
                    {segment.text}
                </span>
            );
        }
        const id = correction.id;
        return (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable order
            <Fragment key={index}>
                <button
                    type="button"
                    className={`rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${style}`}
                    title={title}
                    aria-expanded={open === index}
                    aria-label={
                        correction.kind === "link"
                            ? i18n("{words}, meaning {meaning}: show undo", {
                                  words: segment.text,
                                  meaning: correction.meaning,
                              })
                            : i18n("{words}, heard as {heard}: show undo", {
                                  words: segment.text,
                                  heard: correction.heard,
                              })
                    }
                    onClick={() => setOpen(open === index ? null : index)}
                >
                    {segment.text}
                </button>
                {open === index && (
                    <button
                        type="button"
                        className="ml-1 rounded-sm border px-1 text-[11px] leading-4 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={i18n("Undo: read {heard} here again", {
                            heard: correction.heard,
                        })}
                        onClick={() => {
                            setOpen(null);
                            onUndo(id);
                        }}
                    >
                        {i18n("Undo")}
                    </button>
                )}
            </Fragment>
        );
    });
}
