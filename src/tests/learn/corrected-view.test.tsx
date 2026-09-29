// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptView } from "@/components/dashboard/transcript-view";

const TURNS = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 5_000,
        text: "Great, Honza, Tavesy joined.",
    },
];

const CORRECTIONS = [
    {
        id: "c-link",
        turnIndex: 0,
        charStart: 7,
        charEnd: 12,
        heard: "Honza",
        kind: "link" as const,
        replacement: null,
        meaning: "Jan Novotný",
    },
    {
        id: "c-tavesi",
        turnIndex: 0,
        charStart: 14,
        charEnd: 20,
        heard: "Tavesy",
        kind: "correct" as const,
        replacement: "Tavesi",
        meaning: "Tavesi",
    },
];

describe("the corrected transcript", () => {
    afterEach(cleanup);

    it("reads edited: replacements applied, a link kept as spoken with its meaning on hover", () => {
        render(
            <TranscriptView
                text=""
                storedTurns={TURNS}
                corrections={{ list: CORRECTIONS, canUndo: false }}
            />,
        );
        expect(screen.getByText("Tavesi").getAttribute("title")).toBe(
            "Heard as Tavesy",
        );
        expect(screen.getByText("Honza").getAttribute("title")).toBe(
            "Jan Novotný",
        );
        expect(screen.queryByText("Tavesy")).toBeNull();
        expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
    });

    it("undoes a correction in two steps, for whoever may", () => {
        const onUndo = vi.fn();
        render(
            <TranscriptView
                text=""
                storedTurns={TURNS}
                corrections={{ list: CORRECTIONS, canUndo: true, onUndo }}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", {
                name: "Tavesi, heard as Tavesy: show undo",
            }),
        );
        expect(onUndo).not.toHaveBeenCalled();
        fireEvent.click(
            screen.getByRole("button", {
                name: "Undo: read Tavesy here again",
            }),
        );
        expect(onUndo).toHaveBeenCalledWith("c-tavesi");
    });

    it("reads as heard without corrections", () => {
        render(<TranscriptView text="" storedTurns={TURNS} />);
        expect(screen.getByText("Great, Honza, Tavesy joined.")).toBeTruthy();
    });
});
