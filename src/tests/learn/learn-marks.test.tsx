// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptView } from "@/components/dashboard/transcript-view";
import {
    type LearnMarks,
    type LearnMarksSource,
    learnMarksFrom,
    markedSegments,
} from "@/components/learn/learn-marks";

type Item = LearnMarksSource["items"][number];

const TURNS = [
    { speaker: "speaker_0", startMs: 0, endMs: 5_000, text: "Máme tu Tavesy." },
    { speaker: "speaker_1", startMs: 5_000, endMs: 9_000, text: "Vedu Orion." },
];

const item = (
    overrides: Pick<Item, "id" | "kind" | "payload"> & Partial<Item>,
): Item => ({
    preTicked: false,
    decision: null,
    ...overrides,
});

const STATE: LearnMarksSource & { items: [Item, Item, Item] } = {
    run: { status: "ready" },
    names: { "e-tavesi": "Tavesi", "p-jan": "Jan Novotný" },
    items: [
        item({
            id: "i-correction",
            kind: "correction",
            preTicked: true,
            payload: {
                kind: "correct",
                heard: "Tavesy",
                target: { entityId: "e-tavesi" },
                replacement: "Tavesi",
                anchors: [{ turnIndex: 0, charStart: 8, charEnd: 14 }],
            },
        }),
        item({
            id: "i-speaker",
            kind: "speaker",
            payload: {
                label: "speaker_1",
                personId: "p-jan",
                evidenceMs: [5_000],
                reason: "introduces himself",
            },
        }),
        item({
            id: "i-nobody",
            kind: "speaker",
            payload: {
                label: "speaker_0",
                personId: null,
                evidenceMs: [],
                reason: "",
            },
        }),
    ],
};

describe("Learn marks", () => {
    afterEach(cleanup);

    it("are made only from a ready run's corrections and named speakers", () => {
        const decide = vi.fn();
        const marks = learnMarksFrom(STATE, decide);
        expect(marks?.corrections).toEqual([
            {
                itemId: "i-correction",
                turnIndex: 0,
                charStart: 8,
                charEnd: 14,
                heard: "Tavesy",
                suggestion: "Tavesi",
                ticked: true,
            },
        ]);
        expect(marks?.speakers).toEqual({
            speaker_1: {
                itemId: "i-speaker",
                name: "Jan Novotný",
                ticked: false,
            },
        });
        expect(
            learnMarksFrom({ ...STATE, run: { status: "running" } }, decide),
        ).toBeNull();
    });

    it("keep what was unticked, as unticked, and a link keeps its word", () => {
        const marks = learnMarksFrom(
            {
                ...STATE,
                items: [
                    { ...STATE.items[0], decision: "rejected" },
                    { ...STATE.items[1], decision: "rejected" },
                    item({
                        id: "i-link",
                        kind: "correction",
                        payload: {
                            kind: "link",
                            heard: "Honza",
                            target: { personId: "p-jan" },
                            replacement: null,
                            anchors: [
                                { turnIndex: 1, charStart: 0, charEnd: 4 },
                            ],
                        },
                    }),
                ],
            },
            vi.fn(),
        );
        expect(marks?.speakers).toEqual({
            speaker_1: {
                itemId: "i-speaker",
                name: "Jan Novotný",
                ticked: false,
            },
        });
        expect(marks?.corrections).toEqual([
            expect.objectContaining({
                itemId: "i-correction",
                suggestion: "Tavesi",
                ticked: false,
            }),
            expect.objectContaining({
                itemId: "i-link",
                suggestion: "Jan Novotný",
                ticked: false,
            }),
        ]);
    });

    it("split a turn's text at the marks that still quote it, in order", () => {
        const mark = (charStart: number, charEnd: number, heard: string) => ({
            itemId: `${charStart}`,
            turnIndex: 0,
            charStart,
            charEnd,
            heard,
            suggestion: "x",
            ticked: false,
        });
        expect(
            markedSegments("Máme tu Tavesy a Orijon.", [
                mark(17, 23, "Orijon"),
                mark(8, 14, "Tavesy"),
                // Overlaps the first: left out.
                mark(10, 16, "nesy a"),
                // No longer what the text says there: left out.
                mark(0, 4, "Nope"),
            ]),
        ).toEqual([
            { text: "Máme tu " },
            { text: "Tavesy", mark: mark(8, 14, "Tavesy") },
            { text: " a " },
            { text: "Orijon", mark: mark(17, 23, "Orijon") },
            { text: "." },
        ]);
    });

    it("show a provisional name and underlined words the reviewer can tick in place", () => {
        const decide = vi.fn();
        const marks = learnMarksFrom(STATE, decide) as LearnMarks;
        render(
            <TranscriptView text="" storedTurns={TURNS} learnMarks={marks} />,
        );
        expect(screen.getByText("Jan Novotný?")).toBeTruthy();
        const ticked = screen.getByRole("button", {
            name: "Tavesy → Tavesi, ticked in the review: untick",
        });
        fireEvent.click(ticked);
        expect(decide).toHaveBeenCalledWith("i-correction", "rejected");
        fireEvent.click(
            screen.getByRole("button", {
                name: "Accept Jan Novotný for this speaker in the review",
            }),
        );
        expect(decide).toHaveBeenCalledWith("i-speaker", "accepted");
    });

    it("leave a confirmed speaker's name alone", () => {
        const marks = learnMarksFrom(STATE, vi.fn()) as LearnMarks;
        render(
            <TranscriptView
                text=""
                storedTurns={TURNS}
                speakerAttributions={{
                    speaker_1: { name: "Jana", personId: "p-jana" },
                }}
                learnMarks={marks}
            />,
        );
        expect(screen.queryByText("Jan Novotný?")).toBeNull();
        expect(screen.getByText("Jana")).toBeTruthy();
    });
});
