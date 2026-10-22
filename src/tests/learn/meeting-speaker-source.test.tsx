// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { learnMarksFrom } from "@/components/learn/learn-marks";
import { ReviewSpeaker } from "@/components/learn/review-speaker";
import { SpeakerGuesses } from "@/components/learn/speaker-guesses";
import { speakerAccent } from "@/components/people/speaker-accents";
import {
    SpeakerTags,
    suggestedSpeakers,
} from "@/components/people/speaker-tags";
import type { SpeakerProposalContext } from "@/lib/learn/output";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted:
        () => (message: string, values?: Record<string, string | number>) =>
            message.replace(/\{(\w+)\}/g, (_, key: string) =>
                String(values?.[key] ?? key),
            ),
}));
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
const guess = {
    confidence: 0.6,
    clues: ["meet"],
} satisfies SpeakerProposalContext["guess"];

describe("speaker proposal provenance", () => {
    it.each([
        ["calendar", "Invited in Calendar"],
        ["meet", "Joined in Google Meet"],
        ["transcript", "Named in the transcript"],
    ] as const)("shows %s in the review", (source, text) => {
        const onTick = vi.fn();
        render(
            <ReviewSpeaker
                label="speaker_0"
                person={{ name: "Nera Veln" }}
                accent={speakerAccent(0)}
                ticked={false}
                blocked={false}
                disabled={false}
                recorder={false}
                onlyFirstName={false}
                reason="A short reason."
                source={source}
                evidence={null}
                waits={null}
                onTick={onTick}
                onPick={vi.fn()}
                onUnknown={vi.fn()}
            />,
        );
        expect(screen.getByText(text)).toBeTruthy();
        const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
        expect(checkbox.checked).toBe(false);
        fireEvent.click(checkbox);
        expect(onTick).toHaveBeenCalledWith(true);
    });
    it("keeps guesses unticked and puts their source and reason on the transcript chip", () => {
        const marks = learnMarksFrom(
            {
                run: { status: "ready" },
                names: { p1: "Nera Veln" },
                items: [
                    {
                        id: "speaker-item",
                        kind: "speaker",
                        preTicked: false,
                        decision: null,
                        payload: {
                            label: "speaker_0",
                            personId: "p1",
                            source: "meet",
                            guess,
                            reason: "Role matches the discussion.",
                            evidenceMs: [],
                        },
                    },
                ],
            },
            vi.fn(),
        );
        if (!marks) throw new Error("Marks missing");
        expect(marks.speakers.speaker_0?.ticked).toBe(false);
        render(
            <SpeakerGuesses
                recordingId="recording"
                source="riffado"
                marks={marks}
                answeredLabels={new Set()}
                onAccepted={vi.fn()}
            />,
        );
        expect(screen.getByText("Nera Veln?")).toBeTruthy();
        expect(
            screen.getByTitle(
                "Joined in Google Meet · Guess · Role matches the discussion.",
            ),
        ).toBeTruthy();
    });
    it.each([
        ["calendar", "Invited in Calendar"],
        ["meet", "Joined in Google Meet"],
    ] as const)("keeps an evidence-backed %s proposal's reason on the transcript chip", (source, origin) => {
        const marks = learnMarksFrom(
            {
                run: { status: "ready" },
                names: { p1: "Nera Veln" },
                items: [
                    {
                        id: "speaker-item",
                        kind: "speaker",
                        preTicked: true,
                        decision: null,
                        payload: {
                            label: "speaker_0",
                            personId: "p1",
                            source,
                            reason: "Introduces herself at the start.",
                            evidenceMs: [2_000],
                        },
                    },
                ],
            },
            vi.fn(),
        );
        if (!marks) throw new Error("Marks missing");
        expect(marks.speakers.speaker_0).toMatchObject({
            source,
            reason: "Introduces herself at the start.",
            ticked: true,
        });
        expect(marks.speakers.speaker_0?.guess).toBeUndefined();
        render(
            <SpeakerGuesses
                recordingId="recording"
                source="riffado"
                marks={marks}
                answeredLabels={new Set()}
                onAccepted={vi.fn()}
            />,
        );
        expect(screen.getByText("Nera Veln")).toBeTruthy();
        expect(
            screen.getByTitle(`${origin} · Introduces herself at the start.`),
        ).toBeTruthy();
    });
    it("shows the stored suggestion's source and reason on the transcript speaker chip", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    transcriptionId: "transcript",
                    revision: 0,
                    speakers: [
                        {
                            label: "speaker_0",
                            personId: "p1",
                            personName: "Nera Veln",
                            status: "suggested",
                            source: "meet",
                            confidence: 0.49,
                            proposal: {
                                source: "meet",
                                guess,
                                reason: "Role matches the discussion.",
                            },
                        },
                    ],
                }),
            ),
        );
        const onAttributionsChange = vi.fn();
        render(
            <SpeakerTags
                recordingId="recording"
                source="riffado"
                speakers={[{ speaker: "speaker_0", label: "Speaker 0" }]}
                attributions={{}}
                onAttributionsChange={onAttributionsChange}
            />,
        );
        expect(await screen.findByText("Nera Veln?")).toBeTruthy();
        expect(
            screen.getByTitle(
                "Joined in Google Meet · Guess · Role matches the discussion. Pick someone else",
            ),
        ).toBeTruthy();
        expect(onAttributionsChange).toHaveBeenCalledWith({});
    });

    it("shows a guess and its reason in the review", () => {
        render(
            <ReviewSpeaker
                label="speaker_0"
                person={{ name: "Nera Veln" }}
                accent={speakerAccent(0)}
                ticked={false}
                blocked={false}
                disabled={false}
                recorder={false}
                onlyFirstName={false}
                reason="Role matches the discussion."
                source="meet"
                guess={guess}
                evidence={null}
                waits={null}
                onTick={vi.fn()}
                onPick={vi.fn()}
                onUnknown={vi.fn()}
            />,
        );
        expect(screen.getByText("Joined in Google Meet · Guess")).toBeTruthy();
        expect(
            screen.getByText("Role matches the discussion.", { exact: false }),
        ).toBeTruthy();
        expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
            false,
        );
    });
});

it("Accept all confirms evidence-backed proposals and leaves guesses for individual confirmation", async () => {
    const decide = vi.fn();
    const accepted = vi.fn();
    const fetchImpl = vi.fn(async () => Response.json({ speakers: [] }));
    vi.stubGlobal("fetch", fetchImpl);
    const marks = learnMarksFrom(
        {
            run: { status: "ready" },
            names: { p0: "Nera Veln", p1: "Míra Luvin", p2: "Tera Vosk" },
            items: [0, 1, 2].map((index) => ({
                id: `item-${index}`,
                kind: "speaker",
                preTicked: false,
                decision: null,
                payload: {
                    label: `speaker_${index}`,
                    personId: `p${index}`,
                    evidenceMs: [],
                    ...(index === 2 ? { guess, source: "meet" } : {}),
                },
            })),
        },
        decide,
    );
    if (!marks) throw new Error("Missing marks");
    render(
        <SpeakerGuesses
            recordingId="recording"
            source="riffado"
            marks={marks}
            shownVersion={{ transcriptionId: "transcript", revision: 0 }}
            answeredLabels={new Set()}
            onAccepted={accepted}
        />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(decide).toHaveBeenCalledWith("item-0", "accepted");
    expect(decide).toHaveBeenCalledWith("item-1", "accepted");
    expect(decide).not.toHaveBeenCalledWith("item-2", "accepted");
    expect(screen.getByText("Tera Vosk?")).toBeTruthy();
});

it("appends first-name and recorder notes to the strip source", () => {
    const marks = learnMarksFrom(
        {
            run: { status: "ready" },
            names: { p1: "Nera Veln" },
            items: [
                {
                    id: "item",
                    kind: "speaker",
                    preTicked: false,
                    decision: null,
                    payload: {
                        label: "speaker_0",
                        personId: "p1",
                        evidenceMs: [],
                        onlyFirstName: true,
                        recorder: true,
                    },
                },
            ],
        },
        vi.fn(),
    );
    if (!marks) throw new Error("Missing marks");
    render(
        <SpeakerGuesses
            recordingId="recording"
            source="riffado"
            marks={marks}
            answeredLabels={new Set()}
            onAccepted={vi.fn()}
        />,
    );
    expect(
        screen.getByTitle(
            "Named in the transcript Only the first name was heard: someone else of that name may be speaking. You made this recording, and this speaker leads it.",
        ),
    ).toBeTruthy();
});

it.each([
    null,
    undefined,
])("shows a carried name without a guess label (confidence: %s)", async (confidence) => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json({
                transcriptionId: "transcript",
                revision: 0,
                speakers: [
                    {
                        label: "speaker_0",
                        personId: "p1",
                        personName: "Nera Veln",
                        status: "suggested",
                        source: "heuristic",
                        confidence,
                    },
                ],
            }),
        ),
    );
    render(
        <SpeakerTags
            recordingId="recording"
            source="riffado"
            speakers={[{ speaker: "speaker_0", label: "Speaker 0" }]}
            attributions={{}}
            onAttributionsChange={vi.fn()}
        />,
    );
    expect(await screen.findByText("Nera Veln")).toBeTruthy();
    expect(
        screen.getByTitle(
            "Suggested from the previous transcript. Pick someone else",
        ),
    ).toBeTruthy();
});

it.each([
    ["calendar", "Invited in Calendar"],
    ["meet", "Joined in Google Meet"],
    ["transcript", ""],
] as const)("shows a low-confidence %s suggestion as a guess without stored proposal metadata", async (source, origin) => {
    const speaker = {
        label: "speaker_0",
        personId: "p1",
        personName: "Nera Veln",
        status: "suggested",
        source,
        confidence: 0.3,
    };
    expect(suggestedSpeakers([speaker]).speaker_0?.proposal).toEqual({
        source,
        guess: { confidence: 0.3, clues: [] },
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ speakers: [speaker] })),
    );
    render(
        <SpeakerTags
            recordingId="recording"
            source="riffado"
            speakers={[{ speaker: "speaker_0", label: "Speaker 0" }]}
            attributions={{}}
            onAttributionsChange={vi.fn()}
        />,
    );
    expect(await screen.findByText("Nera Veln?")).toBeTruthy();
    expect(
        screen.getByTitle(
            `${origin ? `${origin} · ` : ""}Guess Pick someone else`,
        ),
    ).toBeTruthy();
});
