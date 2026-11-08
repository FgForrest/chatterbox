// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnReview } from "@/components/learn/learn-review";
import { ReviewSpeaker } from "@/components/learn/review-speaker";
import { speakerAccent } from "@/components/people/speaker-accents";
import {
    SpeakerTags,
    suggestedSpeakers,
} from "@/components/people/speaker-tags";
import type { SpeakerProposalContext } from "@/lib/learn/output";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
const guess = {
    confidence: 0.6,
    clues: ["meet"],
} satisfies SpeakerProposalContext["guess"];

function renderReview(payload: Record<string, unknown>, preTicked = false) {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json({
                run: { id: "run-1", status: "ready" },
                available: true,
                names: { p1: "Nera Veln" },
                types: {},
                relations: {},
                items: [
                    {
                        id: "speaker-item",
                        kind: "speaker",
                        preTicked,
                        decision: null,
                        choice: null,
                        version: 0,
                        dependsOnLabel: null,
                        payload: {
                            label: "speaker_0",
                            personId: "p1",
                            evidenceMs: [],
                            ...payload,
                        },
                    },
                ],
            }),
        ),
    );
    render(
        <LearnReview
            recordingId="recording"
            source="riffado"
            turns={[]}
            showTrigger={false}
        />,
    );
}

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
    it("keeps guesses unticked and puts their source and reason in the review", async () => {
        renderReview({
            source: "meet",
            guess,
            reason: "Role matches the discussion.",
        });
        expect(await screen.findByText("Nera Veln?")).toBeTruthy();
        expect(screen.getByText("Joined in Google Meet · Guess")).toBeTruthy();
        expect(
            screen.getByText("Role matches the discussion.", { exact: false }),
        ).toBeTruthy();
        expect(
            screen.getByRole("checkbox", {
                name: "Accept Speaker 0 as Nera Veln",
            }),
        ).toHaveProperty("checked", false);
    });
    it.each([
        ["calendar", "Invited in Calendar"],
        ["meet", "Joined in Google Meet"],
    ] as const)("keeps an evidence-backed %s proposal's reason in the review", async (source, origin) => {
        renderReview(
            {
                source,
                reason: "Introduces herself at the start.",
                evidenceMs: [2_000],
            },
            true,
        );
        expect(await screen.findByText("Nera Veln")).toBeTruthy();
        expect(
            screen.getByRole("checkbox", {
                name: "Accept Speaker 0 as Nera Veln",
            }),
        ).toHaveProperty("checked", true);
        expect(screen.getByText(origin)).toBeTruthy();
        expect(
            screen.getByText("Introduces herself at the start.", {
                exact: false,
            }),
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

it("shows first-name and recorder notes in the review", () => {
    render(
        <ReviewSpeaker
            label="speaker_0"
            person={{ name: "Nera Veln" }}
            accent={speakerAccent(0)}
            ticked={false}
            blocked={false}
            disabled={false}
            recorder
            onlyFirstName
            reason="Leads the discussion."
            evidence={null}
            waits={null}
            onTick={vi.fn()}
            onPick={vi.fn()}
            onUnknown={vi.fn()}
        />,
    );
    expect(screen.getByText("Nera Veln?")).toBeTruthy();
    expect(screen.getByText("Named in the transcript")).toBeTruthy();
    expect(
        screen.getByText(
            "Only the first name was heard: someone else of that name may be speaking.",
        ),
    ).toBeTruthy();
    expect(
        screen.getByTitle("You made this recording, and this speaker leads it.")
            .textContent,
    ).toBe("you");
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
