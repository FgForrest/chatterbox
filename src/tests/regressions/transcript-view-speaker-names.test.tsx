/** Speaker names are a render-time overlay and never rewrite transcript text. */

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptView } from "@/components/dashboard/transcript-view";

// Two speakers: a lone speaker is not named at all.
const TURNS = [
    { speaker: "speaker_0", startMs: 0, endMs: 2000, text: "Ahoj." },
    { speaker: "speaker_1", startMs: 2000, endMs: 4000, text: "Nazdar." },
];
const TEXT = "speaker_0: Ahoj.\nspeaker_1: Nazdar.";

describe("TranscriptView speaker names", () => {
    afterEach(cleanup);

    it("projects a confirmed name over the raw speaker label", () => {
        render(
            <TranscriptView
                text={TEXT}
                source="riffado"
                model="gpt-4o-transcribe-diarize"
                storedTurns={TURNS}
                speakerAttributions={{
                    speaker_0: { personId: "p-1", name: "Jan" },
                }}
            />,
        );

        expect(screen.getByText("Jan")).toBeDefined();
        expect(screen.getByText("Ahoj.")).toBeDefined();
        expect(screen.queryByText("Speaker 0")).toBeNull();
    });

    it("returns to the raw label when the overlay is removed", () => {
        const view = render(
            <TranscriptView
                text={TEXT}
                source="riffado"
                model="gpt-4o-transcribe-diarize"
                storedTurns={TURNS}
                speakerAttributions={{
                    speaker_0: { personId: "p-1", name: "Jan" },
                }}
            />,
        );

        view.rerender(
            <TranscriptView
                text={TEXT}
                source="riffado"
                model="gpt-4o-transcribe-diarize"
                storedTurns={TURNS}
                speakerAttributions={{}}
            />,
        );

        expect(screen.getByText("Speaker 0")).toBeDefined();
        expect(screen.queryByText("Jan")).toBeNull();
    });

    it("seeks to the provider-reported turn when its speaker is clicked", () => {
        const onSeekToTurn = vi.fn();
        render(
            <TranscriptView
                text={TEXT}
                source="riffado"
                model="gpt-4o-transcribe-diarize"
                storedTurns={[{ ...TURNS[0], startMs: 1250 }, TURNS[1]]}
                onSeekToTurn={onSeekToTurn}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", {
                name: "Seek audio to 00:01, Speaker 0",
            }),
        );

        expect(onSeekToTurn).toHaveBeenCalledWith(1250);
    });

    it("does not offer seeking for legacy turns without timestamps", () => {
        render(
            <TranscriptView
                text={TEXT}
                source="plaud"
                onSeekToTurn={vi.fn()}
            />,
        );

        expect(screen.queryByRole("button", { name: /Seek audio/ })).toBeNull();
        expect(screen.getByText("Speaker 0")).toBeDefined();
    });
});
