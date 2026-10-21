// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptView } from "@/components/dashboard/transcript-view";
import { NewRecordItem } from "@/components/learn/new-record-item";
import { ReviewSpeaker } from "@/components/learn/review-speaker";
import { SpeakerGuesses } from "@/components/learn/speaker-guesses";
import { speakerAccent } from "@/components/people/speaker-accents";
import { PlayAtButton } from "@/components/playback/play-at-button";
import { PlayTurnButton } from "@/components/playback/play-turn-button";
import { PlaybackProvider } from "@/components/playback/playback-context";
import { TaskEvidenceLink } from "@/components/tasks/task-evidence-link";
import { TaskRow } from "@/components/tasks/task-row";
import type { TaskListItem, TaskView } from "@/lib/tasks/tasks";
import { createTestPlayback } from "@/tests/helpers/playback";

const task: TaskView = {
    id: "task",
    recordingId: "recording",
    evidenceItemId: "recording",
    evidenceItemKind: "audio",
    evidenceAudioAvailable: true,
    status: "open",
    text: "Send the sketch",
    assignee: null,
    assigneeHasEmail: false,
    assigneeHint: null,
    assigneeCheck: false,
    dueDate: null,
    duePhrase: null,
    quote: "Send the sketch",
    evidenceStartMs: 5000,
    evidenceText: null,
    evidenceProvenance: null,
    source: "manual",
    ticked: true,
    version: 1,
    createdAt: "2026-10-21T00:00:00Z",
    acceptedAt: null,
    statusChangedAt: null,
    canEdit: false,
    canClose: false,
    canUndoMatch: false,
};

afterEach(cleanup);

describe("shared play shortcuts", () => {
    it("uses the explicit accessible play label for text controls", () => {
        const { playback } = createTestPlayback();
        render(
            <PlaybackProvider playback={playback}>
                <PlayAtButton
                    ms={5000}
                    label="Evidence"
                    playLabel="Play the quoted evidence"
                />
            </PlaybackProvider>,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Play the quoted evidence" }),
        );
        expect(screen.getByRole("button", { name: "Pause" }).textContent).toBe(
            "Evidence",
        );
    });

    it("keeps audio running past a speaker turn, resets its chip, and advances on the next click", () => {
        const { playback, emit } = createTestPlayback();
        const nextTurn = vi
            .fn()
            .mockReturnValueOnce({ ms: 1000, endMs: 2000 })
            .mockReturnValueOnce({ ms: 5000, endMs: 6000 });
        render(
            <PlaybackProvider playback={playback}>
                <PlayTurnButton
                    label="Play the next turn"
                    nextTurn={nextTurn}
                />
            </PlaybackProvider>,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Play the next turn" }),
        );
        const owner = vi.mocked(playback.play).mock.calls[0][1];
        expect(playback.play).toHaveBeenLastCalledWith(1000, owner, undefined);
        act(() => emit({ ms: 1999, playing: true, owner }));
        expect(
            screen.getByRole("button", { name: "Pause", pressed: true }),
        ).toBeTruthy();
        act(() => emit({ ms: 2000, playing: true, owner }));
        expect(
            screen.getByRole("button", {
                name: "Play the next turn",
                pressed: false,
            }),
        ).toBeTruthy();
        expect(playback.pause).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button"));
        expect(playback.play).toHaveBeenLastCalledWith(5000, owner, undefined);
        expect(nextTurn).toHaveBeenCalledTimes(2);
    });

    it("uses one subscription for a long transcript's paragraph controls", () => {
        const { playback } = createTestPlayback();
        const subscribe = vi.spyOn(playback, "subscribe");
        const turns = Array.from({ length: 120 }, (_, index) => ({
            speaker: "speaker_0",
            startMs: index * 5000,
            endMs: (index + 1) * 5000,
            text: `Sentence ${index}.`,
        }));
        render(
            <PlaybackProvider playback={playback}>
                <TranscriptView
                    text={turns.map((turn) => turn.text).join(" ")}
                    storedTurns={turns}
                />
            </PlaybackProvider>,
        );
        expect(
            screen.getAllByRole("button", { name: /^Play from/ }),
        ).toHaveLength(120);
        expect(subscribe).toHaveBeenCalledOnce();
    });

    it("uses the same hour timestamp for a paragraph's seek and play controls", () => {
        const { playback } = createTestPlayback();
        render(
            <PlaybackProvider playback={playback}>
                <TranscriptView
                    text="A late sentence."
                    storedTurns={[
                        {
                            speaker: "",
                            startMs: 3_661_000,
                            endMs: 3_666_000,
                            text: "A late sentence.",
                        },
                    ]}
                />
            </PlaybackProvider>,
        );
        const seek = screen.getByRole("button", {
            name: "Seek audio to 01:01:01",
        });
        expect(seek.textContent).toBe("01:01:01");
        expect(seek.className).toContain("focus-visible:ring-2");
        expect(
            screen.getByRole("button", { name: "Play from 01:01:01" }),
        ).toBeTruthy();
    });

    it("owns a span, pauses it, and clears ownership when another control or ordinary playback starts", () => {
        const { playback, emit } = createTestPlayback();
        render(
            <PlaybackProvider playback={playback}>
                <PlayAtButton ms={5000} untilMs={7000} />
                <PlayAtButton ms={9000} />
            </PlaybackProvider>,
        );
        const first = screen.getByRole("button", { name: "Play from 00:05" });
        fireEvent.click(first);
        expect(playback.play).toHaveBeenCalledWith(
            5000,
            expect.any(String),
            7000,
        );
        expect(first.getAttribute("aria-pressed")).toBe("true");
        expect(first.querySelector(".lucide-pause.fill-current")).toBeTruthy();
        fireEvent.click(
            screen.getByRole("button", { name: "Play from 00:09" }),
        );
        expect(first.getAttribute("aria-pressed")).toBe("false");
        expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(
            1,
        );
        fireEvent.click(screen.getByRole("button", { name: "Pause at 00:09" }));
        expect(playback.pause).toHaveBeenCalledOnce();
        fireEvent.click(first);
        act(() => playback.play(1000));
        expect(first.getAttribute("aria-pressed")).toBe("false");
        act(() => emit({ ms: 5000, playing: false, owner: "another-control" }));
        expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(
            0,
        );
    });

    it("requires running playback as well as its own owner, and unsubscribes", () => {
        const { playback, emit } = createTestPlayback();
        const view = render(
            <PlaybackProvider playback={playback}>
                <PlayAtButton ms={5000} />
            </PlaybackProvider>,
        );
        fireEvent.click(screen.getByRole("button"));
        const call = vi.mocked(playback.play).mock.calls[0];
        act(() => emit({ ms: 5000, playing: false, owner: call?.[1] }));
        expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
            "false",
        );
        view.rerender(
            <PlaybackProvider playback={null}>
                <PlayAtButton ms={5000} />
            </PlaybackProvider>,
        );
        expect(screen.queryByRole("button")).toBeNull();
        act(() => emit({ ms: 5000, playing: true, owner: call?.[1] }));
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("renders nothing or a plain tabular timestamp without audio", () => {
        render(
            <PlaybackProvider playback={null}>
                <PlayAtButton ms={5000} />
                <PlayAtButton ms={9000} withoutAudio="label" />
            </PlaybackProvider>,
        );
        expect(screen.queryByRole("button")).toBeNull();
        expect(screen.queryByText("00:05")).toBeNull();
        expect(screen.getByText("00:09").className).toContain("tabular-nums");
        expect(document.querySelector("svg")).toBeNull();
    });

    it("shares task-row and current evidence ownership and hides both without audio", () => {
        const { playback } = createTestPlayback();
        const controls = (
            <>
                <TaskRow
                    task={task}
                    currentItemId="recording"
                    organizationOnly={false}
                    onChange={vi.fn()}
                />
                <TaskEvidenceLink
                    currentItemId="recording"
                    evidence={{
                        itemId: "recording",
                        itemKind: "audio",
                        audioAvailable: true,
                        startMs: 9000,
                        text: null,
                    }}
                />
            </>
        );
        const view = render(
            <PlaybackProvider playback={playback}>{controls}</PlaybackProvider>,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Play where it was said" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Pause" }));
        expect(playback.pause).toHaveBeenCalledOnce();
        fireEvent.click(
            screen.getByRole("button", { name: "Play from 00:09" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Pause at 00:09" }));
        expect(playback.pause).toHaveBeenCalledTimes(2);
        view.rerender(
            <PlaybackProvider playback={null}>{controls}</PlaybackProvider>,
        );
        expect(screen.queryByRole("button", { name: /Play|Pause/ })).toBeNull();
        expect(screen.queryByRole("link")).toBeNull();
    });

    it("cycles a speaker only on play, pauses without advancing, and disappears without audio", () => {
        const { playback } = createTestPlayback();
        const nextTurn = vi
            .fn()
            .mockReturnValueOnce({ ms: 1000, untilMs: 2000 })
            .mockReturnValue({ ms: 5000, untilMs: 6000 });
        const control = (
            <PlayTurnButton label="Play the next turn" nextTurn={nextTurn} />
        );
        const view = render(
            <PlaybackProvider playback={playback}>{control}</PlaybackProvider>,
        );
        fireEvent.click(screen.getByRole("button"));
        expect(playback.play).toHaveBeenLastCalledWith(
            1000,
            expect.any(String),
            2000,
        );
        fireEvent.click(screen.getByRole("button", { name: "Pause" }));
        expect(nextTurn).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("button"));
        expect(playback.play).toHaveBeenLastCalledWith(
            5000,
            expect.any(String),
            6000,
        );
        view.rerender(
            <PlaybackProvider playback={null}>{control}</PlaybackProvider>,
        );
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("gives Listen and Learn's bounded speaker turn the same pause and no-audio behaviour", () => {
        const { playback } = createTestPlayback();
        const controls = (
            <>
                <SpeakerGuesses
                    recordingId="recording"
                    source="riffado"
                    marks={{
                        speakers: {
                            speaker_0: {
                                itemId: "speaker",
                                label: "speaker_0",
                                name: "Neri Vosk",
                                ticked: false,
                                declined: false,
                                answer: { personId: "person" },
                                evidenceMs: [5000],
                                onlyFirstName: false,
                                recorder: false,
                            },
                            speaker_1: {
                                itemId: "speaker-other",
                                label: "speaker_1",
                                name: "Luma Veln",
                                ticked: false,
                                declined: false,
                                answer: { personId: "person-other" },
                                evidenceMs: [9000],
                                onlyFirstName: false,
                                recorder: false,
                            },
                        },
                        corrections: [],
                        decide: vi.fn(),
                        track: (work) => work,
                    }}
                    answeredLabels={new Set()}
                    onAccepted={vi.fn()}
                />
                <ReviewSpeaker
                    label="speaker_0"
                    person={{ name: "Neri Vosk" }}
                    accent={speakerAccent(0)}
                    ticked={false}
                    blocked={false}
                    disabled={false}
                    recorder={false}
                    onlyFirstName={false}
                    reason=""
                    evidence={null}
                    waits={null}
                    onTick={vi.fn()}
                    onPick={vi.fn()}
                    onUnknown={vi.fn()}
                    nextTurn={() => ({ ms: 5000, untilMs: 7000 })}
                />
            </>
        );
        const view = render(
            <PlaybackProvider playback={playback}>{controls}</PlaybackProvider>,
        );
        const otherGuess = screen.getByRole("button", {
            name: "Play where Speaker 1 speaks",
        });
        expect(otherGuess.textContent).toBe("");
        expect(otherGuess.title).toBe("Listen");
        expect(otherGuess.className).toContain("px-2");
        expect(otherGuess.className).toContain("border-r");
        fireEvent.click(
            screen.getByRole("button", { name: "Play where Speaker 0 speaks" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Pause" }));
        expect(playback.pause).toHaveBeenCalledOnce();
        fireEvent.click(
            screen.getByRole("button", { name: "Play a turn of Speaker 0" }),
        );
        expect(playback.play).toHaveBeenLastCalledWith(
            5000,
            expect.any(String),
            7000,
        );
        fireEvent.click(screen.getByRole("button", { name: "Pause" }));
        expect(playback.pause).toHaveBeenCalledTimes(2);
        view.rerender(
            <PlaybackProvider playback={null}>{controls}</PlaybackProvider>,
        );
        expect(
            screen.queryByRole("button", { name: /Play|Listen|Pause/ }),
        ).toBeNull();
    });

    it("deduplicates Learn's new-record times by displayed second and leaves plain times without audio", () => {
        const { playback } = createTestPlayback();
        const control = (
            <NewRecordItem
                payload={{
                    ref: "n1",
                    kind: "entity",
                    typeKey: "project",
                    name: "Cloudfern",
                    reason: "A project",
                    evidenceMs: [5000, 5100, 5999, 6000],
                }}
                choice={null}
                ticked={false}
                rejected={false}
                disabled={false}
                names={{}}
                entityTypes={[]}
                onDecide={vi.fn()}
                onLinked={vi.fn()}
            />
        );
        const view = render(
            <PlaybackProvider playback={playback}>{control}</PlaybackProvider>,
        );
        expect(
            screen.getAllByRole("button", { name: "Play from 00:05" }),
        ).toHaveLength(1);
        fireEvent.click(
            screen.getByRole("button", { name: "Play from 00:05" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Pause at 00:05" }));
        expect(playback.pause).toHaveBeenCalledOnce();
        view.rerender(
            <PlaybackProvider playback={null}>{control}</PlaybackProvider>,
        );
        expect(screen.queryByRole("button", { name: /Play|Pause/ })).toBeNull();
        expect(screen.getAllByText("00:05")).toHaveLength(1);
    });

    it("pauses a paragraph while any of its sentences is playing and removes every transcript play affordance without audio", () => {
        const { playback, emit } = createTestPlayback();
        const controls = (
            <TranscriptView
                text="First sentence. Second sentence."
                storedTurns={[
                    {
                        speaker: "speaker_0",
                        startMs: 1000,
                        endMs: 9000,
                        text: "First sentence. Second sentence.",
                    },
                ]}
            />
        );
        const view = render(
            <PlaybackProvider playback={playback}>{controls}</PlaybackProvider>,
        );
        act(() => emit({ ms: 6000, playing: true }));
        const paragraph = screen.getByRole("button", {
            name: "Pause at 00:01",
        });
        expect(paragraph.getAttribute("aria-pressed")).toBe("true");
        fireEvent.click(paragraph);
        expect(playback.pause).toHaveBeenCalledOnce();
        view.rerender(
            <PlaybackProvider playback={null}>{controls}</PlaybackProvider>,
        );
        expect(screen.queryByRole("button")).toBeNull();
        expect(
            document.querySelector("[data-sentence], [data-marker]"),
        ).toBeNull();
    });
});

describe("evidence navigation", () => {
    it.each([
        true,
        false,
    ])("navigates from a recording's task row to other evidence with audioAvailable=%s", (audioAvailable) => {
        const { playback } = createTestPlayback();
        render(
            <PlaybackProvider playback={playback}>
                <TaskRow
                    task={{
                        ...task,
                        evidenceItemId: "other",
                        evidenceAudioAvailable: audioAvailable,
                    }}
                    currentItemId="recording"
                    organizationOnly={false}
                    onChange={vi.fn()}
                />
            </PlaybackProvider>,
        );
        const link = screen.getByRole("link", { name: "Show in recording" });
        expect(link.getAttribute("href")).toContain("recording=other");
        expect(link.getAttribute("href")?.includes("playFrom=5000")).toBe(
            audioAvailable,
        );
        expect(screen.queryByRole("button", { name: /Play|Pause/ })).toBeNull();
        expect(playback.play).not.toHaveBeenCalled();
    });

    it("shows a plain time for the current recording's evidence once its audio is gone", () => {
        render(
            <PlaybackProvider playback={null}>
                <TaskRow
                    task={{ ...task, evidenceAudioAvailable: false }}
                    currentItemId="recording"
                    organizationOnly={false}
                    onChange={vi.fn()}
                />
            </PlaybackProvider>,
        );
        expect(screen.queryByRole("button", { name: /Play|Pause/ })).toBeNull();
        expect(screen.queryByRole("link")).toBeNull();
        const time = screen.getByText("00:05");
        expect(time.className).toContain("tabular-nums");
        expect(time.title).toBe("Send the sketch");
    });

    it("labels off-item audio navigation when there is no time offset", () => {
        render(
            <TaskEvidenceLink
                evidence={{
                    itemId: "other",
                    itemKind: "audio",
                    audioAvailable: true,
                    startMs: null,
                    text: { segmentIndex: 0, charStart: 0, charEnd: 4 },
                }}
            />,
        );
        expect(
            screen.getByRole("link", { name: "Show in recording" }).textContent,
        ).toBe("Show in recording");
    });

    it.each([
        true,
        false,
    ])("uses navigation with audioAvailable=%s", (audioAvailable) => {
        const evidence: TaskListItem["evidence"] = {
            id: "other",
            kind: "audio",
            title: "Sketch review",
            view: "private",
            startTime: "2026-10-21T00:00:00Z",
            audioAvailable,
        };
        render(
            <>
                <TaskRow
                    task={task}
                    evidence={evidence}
                    organizationOnly={false}
                    onChange={vi.fn()}
                />
                <TaskEvidenceLink
                    evidence={{
                        itemId: "other",
                        itemKind: "audio",
                        audioAvailable,
                        startMs: 5000,
                        text: null,
                    }}
                />
            </>,
        );
        const links = screen.getAllByRole("link");
        expect(links).toHaveLength(2);
        for (const link of links) {
            expect(link.getAttribute("href")?.includes("playFrom=5000")).toBe(
                audioAvailable,
            );
            expect(link.querySelector(".lucide-arrow-up-right")).toBeTruthy();
            expect(link.getAttribute("aria-label") ?? "").not.toMatch(
                /Play|Pause/,
            );
        }
        expect(screen.queryByRole("button", { name: /Play/ })).toBeNull();
    });
});
