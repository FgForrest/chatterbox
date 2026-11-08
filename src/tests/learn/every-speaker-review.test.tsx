// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnReview } from "@/components/learn/learn-review";
import { PlaybackProvider } from "@/components/playback/playback-context";
import * as speechSamples from "@/lib/transcript/speech-samples";
import { createTestPlayback } from "@/tests/helpers/playback";

vi.mock("@/components/people/speaker-picker", () => ({
    SpeakerPicker: ({
        onPick,
        onClose,
    }: {
        onPick: (choice: { personId: string }) => Promise<boolean>;
        onClose: () => void;
    }) => (
        <button
            type="button"
            onClick={() => void onPick({ personId: "p2" }).then(onClose)}
        >
            Pick Jitka
        </button>
    ),
}));

const text =
    "The meeting has enough words for a useful uninterrupted speech sample today.";
const turns = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 8000,
        text: `Jitka Dvořáková can answer. ${text}`,
    },
    { speaker: "speaker_2", startMs: 10000, endMs: 30000, text },
    {
        speaker: "speaker_3",
        startMs: 40000,
        endMs: 42000,
        text: "Yes, agreed.",
    },
    { speaker: "speaker_1", startMs: 50000, endMs: 51000, text: "Thanks." },
    { speaker: "speaker_4", startMs: 60000, endMs: 61000, text: "Good." },
];
function item(label: string, payload: Record<string, unknown> = {}) {
    return {
        id: label,
        kind: "speaker",
        decision: null as "accepted" | "rejected" | null,
        choice: null as Record<string, unknown> | null,
        preTicked: false,
        version: 0,
        dependsOnLabel: null,
        payload: {
            label,
            personId: null,
            evidenceMs: [],
            reason: "Nobody known.",
            ...payload,
        },
    };
}
function review(frame: "inline" | "dialog") {
    let items = [
        item("speaker_0", {
            personId: "p1",
            evidenceMs: [0],
            reason: "Answers to her name.",
        }),
        item("speaker_3", { unmentioned: true, reason: "" }),
        item("speaker_2"),
    ];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
            const input = JSON.parse(String(init.body));
            items = items.map((row) =>
                url.includes(`/items/${row.id}`)
                    ? {
                          ...row,
                          decision: input.decision,
                          choice: input.choice,
                          version: row.version + 1,
                      }
                    : row,
            );
            return Response.json({ version: 1 });
        }
        return Response.json({
            run: { id: "run", status: "ready" },
            available: true,
            quickFinish: { automaticSummary: true, skipTasks: false },
            names: { p1: "Petr Malý", p2: "Jitka Dvořáková" },
            types: {},
            relations: {},
            items,
        });
    });
    vi.stubGlobal("fetch", fetch);
    const player = createTestPlayback();
    render(
        <PlaybackProvider playback={player.playback}>
            <LearnReview
                recordingId="recording"
                source="riffado"
                turns={turns}
                frame={frame}
                initialOpen
                showTrigger={false}
                confirmedAttributions={{
                    speaker_1: { personId: "p3", name: "Eva Králová" },
                }}
                unknownLabels={new Set(["speaker_4"])}
                nextSpeakerTurn={() => ({ ms: 10000, untilMs: 30000 })}
            />
        </PlaybackProvider>,
    );
    return { ...player, fetch };
}
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe.each([
    "inline",
    "dialog",
] as const)("every speaker in the %s review", (frame) => {
    it("orders by speaking time, shows stats, named labels, optional copy, samples and fallback", async () => {
        review(frame);
        await screen.findByRole("checkbox", { name: "Accept Speaker 2 as ?" });
        const rows = screen.getAllByRole("checkbox", { name: /^Accept/ });
        expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
            "Accept Speaker 2 as ?",
            "Accept Speaker 0 as Petr Malý",
            "Accept Speaker 3 as ?",
        ]);
        expect(screen.getByText("speaks 0:20 · 1 reply")).toBeTruthy();
        expect(screen.getByText("Already named:")).toBeTruthy();
        expect(screen.getByText("Speaker 1 · Eva Králová")).toBeTruthy();
        expect(screen.getByText("Speaker 4 · unknown")).toBeTruthy();
        expect(screen.getByText("Change them in the transcript.")).toBeTruthy();
        expect(
            screen.getByText(
                "Learn did not recognise this speaker. Listen and choose who it is.",
            ),
        ).toBeTruthy();
        expect(screen.getAllByText("Speech samples")).toHaveLength(3);
        expect(
            screen.getByText("Only short replies; the longest is 2 s."),
        ).toBeTruthy();
        expect(screen.getByText("Where the name was heard")).toBeTruthy();
        expect(screen.getByText(/2 without a name/)).toBeTruthy();
    });
    it("excludes unanswered rows from totals and tick-all, then enables and ticks a chosen row", async () => {
        const { fetch } = review(frame);
        const noName = await screen.findByRole("checkbox", {
            name: "Accept Speaker 2 as ?",
        });
        expect(noName).toHaveProperty("disabled", true);
        expect(screen.getByText("0 of 1 speakers confirmed")).toBeTruthy();
        expect(screen.getByText("0 of 1 will be applied")).toBeTruthy();
        fireEvent.click(
            screen.getByRole("checkbox", { name: "Tick all: Speakers" }),
        );
        await waitFor(() =>
            expect(
                screen.getByRole("checkbox", {
                    name: "Accept Speaker 0 as Petr Malý",
                }),
            ).toHaveProperty("checked", true),
        );
        expect(
            fetch.mock.calls.filter(([, init]) => init?.method === "PATCH"),
        ).toHaveLength(1);
        const row = noName.closest(".grid") as HTMLElement;
        fireEvent.click(
            within(row).getByRole("button", { name: "Choose a person…" }),
        );
        fireEvent.click(screen.getByText("Pick Jitka"));
        const chosen = await screen.findByRole("checkbox", {
            name: "Accept Speaker 2 as Jitka Dvořáková",
        });
        expect(chosen).toHaveProperty("disabled", false);
        expect(chosen).toHaveProperty("checked", true);
        expect(screen.getByText("2 of 2 speakers confirmed")).toBeTruthy();
        expect(screen.getByText("2 of 2 will be applied")).toBeTruthy();
        const short = screen
            .getByRole("checkbox", { name: "Accept Speaker 3 as ?" })
            .closest(".grid") as HTMLElement;
        fireEvent.click(within(short).getByRole("button", { name: "Unknown" }));
        await waitFor(() =>
            expect(
                screen.getByRole("checkbox", {
                    name: "Accept Speaker 3 as unknown",
                }),
            ).toHaveProperty("checked", true),
        );
        expect(screen.getByText("3 of 3 speakers confirmed")).toBeTruthy();
    });
    it("plays bounded samples with progress, quote and pause, and bounds the name evidence", async () => {
        const { playback, emit } = review(frame);
        const sample = await screen.findByRole("button", {
            name: "Play from 00:09",
        });
        expect(sample.textContent).toBe("00:09 · 12 s");
        fireEvent.click(sample);
        const owner = vi.mocked(playback.play).mock.calls.at(-1)?.[1];
        expect(playback.play).toHaveBeenLastCalledWith(9700, owner, 21700);
        act(() => emit({ ms: 15700, owner, playing: true }));
        expect(sample.getAttribute("aria-pressed")).toBe("true");
        expect(
            sample.querySelector("[style]")?.getAttribute("style"),
        ).toContain("50%");
        expect(screen.getByText(/“The meeting has enough words/)).toBeTruthy();
        fireEvent.click(sample);
        expect(playback.pause).toHaveBeenCalledOnce();
        fireEvent.click(
            screen.getAllByRole("button", { name: "Play from 00:00" })[0],
        );
        expect(playback.play).toHaveBeenLastCalledWith(
            0,
            expect.any(String),
            8000,
        );
    });

    it("counts nobody-known findings in Review while selection totals exclude unanswered rows", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    available: true,
                    run: { id: "run", status: "ready" },
                    names: {},
                    types: {},
                    relations: {},
                    items: [
                        item("speaker_0"),
                        item("speaker_2", { unmentioned: true }),
                    ],
                }),
            ),
        );
        render(
            <LearnReview
                recordingId="recording"
                source="riffado"
                frame={frame}
                turns={turns}
            />,
        );
        const review = await screen.findByRole("button", {
            name: "Review (1)",
        });
        if (frame === "dialog") fireEvent.click(review);
        expect(screen.getByText("0 of 0 will be applied")).toBeTruthy();
        expect(screen.getByText("0 of 0 speakers confirmed")).toBeTruthy();
        expect(
            screen.getByRole("checkbox", { name: "Tick all: Speakers" }),
        ).toHaveProperty("disabled", true);
    });
    it("computes samples only for visible rows and reuses them across decisions", async () => {
        const sampleSpy = vi.spyOn(speechSamples, "speakerSpeechSamples");
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: string, init?: RequestInit) =>
                Response.json(
                    init?.method === "PATCH"
                        ? { version: 1 }
                        : {
                              available: true,
                              run: { id: "run", status: "ready" },
                              names: {},
                              types: {},
                              relations: {},
                              items: [
                                  item("speaker_0"),
                                  item("speaker_2", { unmentioned: true }),
                              ],
                          },
                ),
            ),
        );
        render(
            <LearnReview
                recordingId="recording"
                source="riffado"
                frame={frame}
                turns={turns}
                durationMs={90000}
                showTrigger={false}
                collapseReady
            />,
        );
        const trigger = await screen.findByRole("button", {
            name: "Review",
        });
        expect(
            screen.queryByRole("checkbox", { name: "Accept Speaker 0 as ?" }),
        ).toBeNull();
        expect(sampleSpy).not.toHaveBeenCalled();
        fireEvent.click(trigger);
        await screen.findByRole("checkbox", { name: "Accept Speaker 0 as ?" });
        expect(sampleSpy).toHaveBeenCalledTimes(2);
        expect(sampleSpy).toHaveBeenCalledWith(turns, "speaker_0", 90000);
        const row = screen
            .getByRole("checkbox", { name: "Accept Speaker 0 as ?" })
            .closest(".grid") as HTMLElement;
        fireEvent.click(within(row).getByRole("button", { name: "Unknown" }));
        await screen.findByRole("checkbox", {
            name: "Accept Speaker 0 as unknown",
        });
        expect(sampleSpy).toHaveBeenCalledTimes(2);
    });

    it("shows an applied coverage choice in finished results even though it was never a waiting finding", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    available: true,
                    run: { id: "run", status: "finished" },
                    names: {},
                    types: {},
                    relations: {},
                    items: [
                        {
                            ...item("speaker_0", { unmentioned: true }),
                            choice: { unknown: true },
                            decision: "accepted",
                            outcome: "applied",
                        },
                    ],
                }),
            ),
        );
        render(
            <LearnReview
                recordingId="recording"
                source="riffado"
                frame={frame}
                turns={turns}
            />,
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Learned (1)" }),
        );
        expect(await screen.findByText("Speaker 0 → unknown")).toBeTruthy();
    });
});
