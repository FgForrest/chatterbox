// @vitest-environment jsdom

/**
 * Learn's speaker guesses above the transcript: named at once, one by one
 * or all together, and ticked in the review so finishing it agrees.
 */

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
    LearnMarks,
    LearnSpeakerMark,
} from "@/components/learn/learn-marks";
import { SpeakerGuesses } from "@/components/learn/speaker-guesses";

vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn() },
}));

const VERSION = { transcriptionId: "t-1", revision: 3 };

function guess(
    overrides: Partial<LearnSpeakerMark> & Pick<LearnSpeakerMark, "label">,
): LearnSpeakerMark {
    return {
        itemId: `item-${overrides.label}`,
        name: "Jan Novák",
        ticked: false,
        declined: false,
        answer: { personId: "p-jan" },
        evidenceMs: [1_000],
        onlyFirstName: false,
        recorder: false,
        ...overrides,
    };
}

function marksOf(...guesses: LearnSpeakerMark[]): LearnMarks {
    return {
        speakers: Object.fromEntries(guesses.map((one) => [one.label, one])),
        corrections: [],
        decide: vi.fn().mockResolvedValue(undefined),
        track: vi.fn((work) => work),
    };
}

function speakersAnswer(rows: { label: string; personId: string }[]) {
    return new Response(JSON.stringify({ speakers: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function renderGuesses(
    marks: LearnMarks,
    confirmed: string[] = [],
    onAccepted = vi.fn(),
) {
    render(
        <SpeakerGuesses
            recordingId="rec-1"
            source="riffado"
            shownVersion={VERSION}
            marks={marks}
            answeredLabels={new Set(confirmed)}
            onAccepted={onAccepted}
        />,
    );
    return onAccepted;
}

describe("SpeakerGuesses", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("names a speaker at once and ticks the guess in the review", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                speakersAnswer([{ label: "speaker_0", personId: "p-jan" }]),
            );
        vi.stubGlobal("fetch", fetchMock);
        const marks = marksOf(guess({ label: "speaker_0" }));
        const onAccepted = renderGuesses(marks);

        fireEvent.click(
            screen.getByRole("button", {
                name: "Confirm Jan Novák as Speaker 0",
            }),
        );

        await waitFor(() => expect(onAccepted).toHaveBeenCalled());
        const [url, init] = fetchMock.mock.calls[0] ?? [];
        expect(url).toBe("/api/recordings/rec-1/speakers?source=riffado");
        expect(init?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body))).toEqual({
            label: "speaker_0",
            personId: "p-jan",
            ...VERSION,
        });
        expect(marks.decide).toHaveBeenCalledWith("item-speaker_0", "accepted");
        // The review's Finish waits for the whole acceptance.
        expect(marks.track).toHaveBeenCalledTimes(1);
        // Named: the guess is gone.
        expect(screen.queryByText("Speaker guesses")).toBeNull();
    });

    it("links someone new the review adds to whoever the name made", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    speakersAnswer([{ label: "speaker_3", personId: "p-new" }]),
                ),
        );
        const marks = marksOf(
            guess({
                label: "speaker_3",
                name: "Ondřej Novák",
                answer: {
                    displayName: "Ondřej Novák",
                    recordItemId: "item-record",
                },
            }),
        );
        const onAccepted = renderGuesses(marks);

        fireEvent.click(
            screen.getByRole("button", {
                name: "Confirm Ondřej Novák as Speaker 3",
            }),
        );

        await waitFor(() => expect(onAccepted).toHaveBeenCalled());
        expect(marks.decide).toHaveBeenCalledWith("item-record", "accepted", {
            personId: "p-new",
        });
        expect(marks.decide).toHaveBeenCalledWith("item-speaker_3", "accepted");
    });

    it("accepts every guess not declined, and none already named", async () => {
        const fetchMock = vi
            .fn()
            .mockImplementation(async () => speakersAnswer([]));
        vi.stubGlobal("fetch", fetchMock);
        const marks = marksOf(
            guess({ label: "speaker_0" }),
            guess({
                label: "speaker_2",
                name: "Karel Dvořák",
                answer: { personId: "p-karel" },
            }),
            guess({ label: "speaker_4", name: "Eva", declined: true }),
            guess({ label: "speaker_5", name: "Věra" }),
        );
        const onAccepted = renderGuesses(marks, ["speaker_5"]);

        expect(screen.queryByText("Věra")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Accept all" }));

        await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
        const labels = fetchMock.mock.calls.map(
            (call) => JSON.parse(String(call[1]?.body)).label,
        );
        expect(labels).toEqual(["speaker_0", "speaker_2"]);
    });

    it("unticks a guess in the review when it is not them", () => {
        vi.stubGlobal("fetch", vi.fn());
        const marks = marksOf(guess({ label: "speaker_0" }));
        renderGuesses(marks);

        fireEvent.click(
            screen.getByRole("button", {
                name: "Speaker 0 is not Jan Novák",
            }),
        );

        expect(marks.decide).toHaveBeenCalledWith("item-speaker_0", "rejected");
        expect(fetch).not.toHaveBeenCalled();
    });

    it("leaves the review alone when the speaker could not be named", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ error: "nope" }), {
                    status: 409,
                }),
            ),
        );
        const marks = marksOf(guess({ label: "speaker_0" }));
        const onAccepted = renderGuesses(marks);

        fireEvent.click(
            screen.getByRole("button", {
                name: "Confirm Jan Novák as Speaker 0",
            }),
        );

        await waitFor(() => expect(screen.getByText("Jan Novák")).toBeTruthy());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(marks.decide).not.toHaveBeenCalled();
        expect(onAccepted).not.toHaveBeenCalled();
    });
});
