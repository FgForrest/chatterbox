/**
 * A lecture: one speaker's single turn, minutes long. It reads in timed
 * paragraphs, its topics head the paragraphs they start in, and its lone
 * speaker is not named on every one of them.
 */

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptView } from "@/components/dashboard/transcript-view";

// Twenty sentences of 21 characters with their space, 20 s each.
const sentence = (i: number) =>
    `s${String(i).padStart(2, "0")} lorem ipsum dol. `;
const TEXT = Array.from({ length: 20 }, (_, i) => sentence(i)).join("");
const LECTURE = [
    { speaker: "speaker_1", startMs: 0, endMs: 400_000, text: TEXT },
];
const TOPICS = [
    { title: "Úvod", fromMs: 0, toMs: 140_000 },
    { title: "Experiment", fromMs: 140_000, toMs: 400_000 },
];

const paragraphTexts = (container: HTMLElement) =>
    [...container.querySelectorAll("p")].map((p) => p.textContent ?? "");

describe("TranscriptView for a lecture", () => {
    afterEach(cleanup);

    it("reads in timed paragraphs without naming the lone speaker", () => {
        const onSeekToTurn = vi.fn();
        const { container } = render(
            <TranscriptView
                text={`speaker_1: ${TEXT}`}
                source="speechmatics"
                model="enhanced+diarize"
                storedTurns={LECTURE}
                onSeekToTurn={onSeekToTurn}
            />,
        );

        expect(screen.queryByText("Speaker 1")).toBeNull();
        expect(paragraphTexts(container)).toHaveLength(10);
        expect(paragraphTexts(container)[1]).toMatch(/^s02 /);

        fireEvent.click(
            screen.getByRole("button", { name: "Seek audio to 00:40" }),
        );
        expect(onSeekToTurn).toHaveBeenCalledWith(40_000);
    });

    it("puts each topic heading above the paragraph it starts in", () => {
        const { container } = render(
            <TranscriptView
                text={`speaker_1: ${TEXT}`}
                source="speechmatics"
                model="enhanced+diarize"
                storedTurns={LECTURE}
                topics={TOPICS}
            />,
        );

        const heading = container.querySelector('[data-topic-index="1"]');
        expect(heading?.textContent).toContain("Experiment");
        expect(heading?.nextElementSibling?.textContent).toMatch(/^s07 /);
    });

    it("keeps corrected words whole where a paragraph would cut them", () => {
        const { container } = render(
            <TranscriptView
                text={`speaker_1: ${TEXT}`}
                source="speechmatics"
                model="enhanced+diarize"
                storedTurns={LECTURE}
                corrections={{
                    list: [
                        {
                            turnIndex: 0,
                            charStart: 37,
                            charEnd: 45,
                            heard: "dol. s02",
                            kind: "correct",
                            replacement: "dolor. S02",
                            meaning: "dolor. S02",
                        },
                    ],
                    canUndo: false,
                }}
            />,
        );

        const texts = paragraphTexts(container);
        expect(texts[0]).toMatch(/lorem ipsum dolor\. S02$/);
        expect(texts[1]).toMatch(/^lorem ipsum dol\. s03 /);
    });

    it("still names a lone speaker while a review proposes a name", () => {
        render(
            <TranscriptView
                text={`speaker_1: ${TEXT}`}
                source="speechmatics"
                model="enhanced+diarize"
                storedTurns={LECTURE}
                learnMarks={{
                    speakers: {
                        speaker_1: {
                            itemId: "i-1",
                            label: "speaker_1",
                            name: "Jan",
                            ticked: false,
                            declined: false,
                            answer: { displayName: "Jan" },
                            evidenceMs: [],
                            onlyFirstName: false,
                            recorder: false,
                        },
                    },
                    corrections: [],
                    decide: vi.fn(),
                    track: (work) => work,
                }}
            />,
        );

        expect(screen.getAllByText("Jan?")).toHaveLength(1);
    });
});
