// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    renderHook,
    screen,
    within,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingPlayer } from "@/components/dashboard/recording-player";
import { TranscriptView } from "@/components/dashboard/transcript-view";
import { PlaybackProvider } from "@/components/playback/playback-context";
import { EraseRecordingMenu } from "@/components/recordings/erase-recording-menu";
import {
    CutPreviewOverlay,
    RecordingCutBar,
    RecordingCutButton,
    RecordingCutProvider,
} from "@/components/recordings/recording-cut";
import { useWaveform } from "@/hooks/use-waveform";
import type { Recording } from "@/types/recording";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("@/hooks/use-playback-engine", () => ({
    usePlaybackEngine: () => ({
        audioRef: { current: null },
        currentTime: 0,
        duration: 10,
    }),
}));
vi.mock("@/hooks/use-playback-keyboard", () => ({
    usePlaybackKeyboard: () => {},
}));
vi.mock("@/components/dashboard/recording-player-controls", () => ({
    RecordingPlayerControls: ({
        waveformPeaks,
    }: {
        waveformPeaks: number[] | null;
    }) => (
        <output data-testid="waveform-peaks">
            {JSON.stringify(waveformPeaks)}
        </output>
    ),
}));

const turns = [
    { speaker: "S1", startMs: 0, endMs: 2000, text: "Private beginning." },
    { speaker: "S2", startMs: 3000, endMs: 6000, text: "Keep the middle." },
    { speaker: "S1", startMs: 7000, endMs: 10000, text: "Private end." },
];
const recording: Recording = {
    id: "recording",
    duration: 10000,
    filesize: 100,
    filename: "Meeting",
    startTime: "2026-10-01T10:00:00Z",
    deviceSn: "SN-test",
};
const fetchMock = vi.fn();
const changed = vi.fn();
const playback = {
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    subscribe: (
        listener: (state: { ms: number; playing: boolean }) => void,
    ) => {
        listener({ ms: 4500, playing: false });
        return () => {};
    },
};

function view(
    overrides: Partial<Recording> = {},
    transcribing = false,
    timed = true,
    shared = false,
) {
    return render(
        <PlaybackProvider playback={playback}>
            <RecordingCutProvider
                recording={{ ...recording, ...overrides }}
                transcripts={[{ turns: timed ? turns : null }]}
                transcribing={transcribing}
                shared={shared}
                onChanged={changed}
            >
                <RecordingCutBar />
                <div data-testid="player">
                    <RecordingCutButton />
                </div>
                <div data-testid="transcript">
                    <RecordingCutButton />
                </div>
                <div className="relative">
                    <CutPreviewOverlay />
                </div>
                <TranscriptView
                    text="Private beginning. Keep the middle. Private end."
                    source="riffado"
                    model="test"
                    storedTurns={timed ? turns : null}
                />
            </RecordingCutProvider>
        </PlaybackProvider>,
    );
}

describe("shared recording cut mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fetchMock.mockImplementation(
            async (url: string) =>
                new Response(
                    JSON.stringify(
                        url.includes("withdraw-preview")
                            ? { due: [] }
                            : { job: null },
                    ),
                    { status: 200 },
                ),
        );
        vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });
    it.each([
        { isOwn: false },
        { view: "org" as const, isOwn: true },
        { view: "received" as const },
    ])("hides scissors for a reader %j", (overrides) => {
        view(overrides);
        expect(
            screen.queryByRole("button", { name: "Cut the start and end" }),
        ).toBeNull();
    });
    it("both buttons toggle one mode and only take colour while it is open", () => {
        view();
        const player = within(screen.getByTestId("player"));
        const transcript = within(screen.getByTestId("transcript"));
        expect(player.getByRole("button").getAttribute("aria-pressed")).toBe(
            "false",
        );
        fireEvent.click(player.getByRole("button"));
        expect(
            screen.getByRole("region", { name: "Cut recording" }),
        ).toBeTruthy();
        expect(player.getByRole("button").className).toContain("text-primary");
        expect(
            transcript.getByRole("button").getAttribute("aria-pressed"),
        ).toBe("true");
        fireEvent.click(transcript.getByRole("button"));
        expect(
            screen.queryByRole("region", { name: "Cut recording" }),
        ).toBeNull();
        expect(player.getByRole("button").getAttribute("aria-pressed")).toBe(
            "false",
        );
    });
    it("snaps the playback controls to a turn and previews the removed text", () => {
        view();
        fireEvent.click(
            within(screen.getByTestId("player")).getByRole("button"),
        );
        const bar = within(
            screen.getByRole("region", { name: "Cut recording" }),
        );
        fireEvent.click(bar.getByRole("button", { name: "Start here" }));
        fireEvent.click(bar.getByRole("button", { name: "End here" }));
        expect(bar.getByText("Start 00:03")).toBeTruthy();
        expect(bar.getByText("End 00:06")).toBeTruthy();
        expect(bar.getByText("00:03 of 00:10 stays")).toBeTruthy();
        expect(
            screen.getByText("Private beginning.").closest(".group\\/para")
                ?.className,
        ).toContain("line-through");
        expect(
            screen.getByText("Private end.").closest(".group\\/para")
                ?.className,
        ).toContain("line-through");
        expect(
            screen.getByText("Keep the middle.").closest(".group\\/para")
                ?.className,
        ).not.toContain("line-through");
        fireEvent.click(bar.getByRole("button", { name: "Reset start" }));
        expect(bar.getByText("Start 00:00")).toBeTruthy();
    });
    it("turn buttons set boundaries without seeking and Cancel changes nothing", async () => {
        view();
        fireEvent.click(
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        const middle = screen
            .getByText("Keep the middle.")
            .closest(".group\\/para") as HTMLElement;
        fireEvent.click(
            within(middle).getByRole("button", { name: "Start here" }),
        );
        fireEvent.click(
            within(middle).getByRole("button", { name: "End here" }),
        );
        expect(playback.seek).not.toHaveBeenCalled();
        expect(playback.play).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Cut…" }));
        expect(screen.getByRole("alertdialog")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await act(async () => {});
        expect(
            fetchMock.mock.calls.every((call) => call[1]?.method !== "POST"),
        ).toBe(true);
        expect(changed).not.toHaveBeenCalled();
    });
    it.each([
        true,
        false,
    ])("confirmation describes the deletion and original copies (Plaud=%s)", (plaud) => {
        view({ deviceSn: plaud ? "SN-test" : "local" });
        fireEvent.click(
            within(screen.getByTestId("player")).getByRole("button"),
        );
        const bar = within(
            screen.getByRole("region", { name: "Cut recording" }),
        );
        fireEvent.click(bar.getByRole("button", { name: "Start here" }));
        fireEvent.click(bar.getByRole("button", { name: "End here" }));
        fireEvent.click(bar.getByRole("button", { name: "Cut…" }));
        const dialog = within(screen.getByRole("alertdialog"));
        expect(
            dialog.getByText(
                "00:03 at the start and 00:04 at the end are deleted from the audio and the transcript. The recording will then be 00:03 long.",
            ),
        ).toBeTruthy();
        expect(dialog.getByText("This cannot be undone.")).toBeTruthy();
        expect(
            dialog.getByText(
                plaud
                    ? "The original recording stays in the Plaud app and in exports and backups made before."
                    : "Exports and backups made before keep the original.",
            ),
        ).toBeTruthy();
    });
    it.each([
        [true, true],
        [false, false],
    ])("disables scissors during transcription or without turn times %s/%s", (transcribing, timed) => {
        view({}, transcribing, timed);
        expect(
            (
                within(screen.getByTestId("player")).getByRole(
                    "button",
                ) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        fireEvent.click(
            within(screen.getByTestId("player")).getByRole("button"),
        );
        expect(screen.queryByRole("region")).toBeNull();
    });
    it("cuts transcripts without playback buttons when audio is gone", () => {
        view({ audioReaped: true });
        fireEvent.click(
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        const bar = within(
            screen.getByRole("region", { name: "Cut recording" }),
        );
        expect(bar.queryByRole("button", { name: "Start here" })).toBeNull();
        const middle = screen
            .getByText("Keep the middle.")
            .closest(".group\\/para") as HTMLElement;
        fireEvent.click(
            within(middle).getByRole("button", { name: "Start here" }),
        );
        fireEvent.click(bar.getByRole("button", { name: "Cut…" }));
        expect(
            screen.getByText(
                "00:03 at the start is deleted from the transcript. The recording will then be 00:07 long.",
            ),
        ).toBeTruthy();
    });
    it("explains the shared cut without withdrawal or retention warnings", async () => {
        view({}, false, true, true);
        fireEvent.click(
            within(screen.getByTestId("player")).getByRole("button"),
        );
        const bar = within(
            screen.getByRole("region", { name: "Cut recording" }),
        );
        fireEvent.click(bar.getByRole("button", { name: "Start here" }));
        fireEvent.click(bar.getByRole("button", { name: "Cut…" }));
        expect(
            screen.getByText(
                "This recording is shared with the Organization. Colleagues will see the cut version, and its summary in the Organization is generated again.",
            ),
        ).toBeTruthy();
        await act(async () => {});
        expect(
            fetchMock.mock.calls.some(([url]) =>
                url.includes("withdraw-preview"),
            ),
        ).toBe(false);
        expect(screen.queryByText(/retention/i)).toBeNull();
    });
    it.each([
        "completed",
        "failed",
    ])("submits the destructive cut and clears progress after the job %s", async (status) => {
        vi.useFakeTimers();
        const post = Promise.withResolvers<Response>();
        let polls = 0;
        fetchMock.mockImplementation(
            async (url: string, init?: RequestInit) => {
                if (init?.method === "POST") return post.promise;
                if (url === "/api/jobs/cut-job") {
                    polls++;
                    return Response.json(
                        polls === 1
                            ? { status: "processing" }
                            : {
                                  status,
                                  error: "The recording or transcript changed. Reload it and choose the cut again.",
                              },
                    );
                }
                return Response.json({ job: null });
            },
        );
        view();
        await act(async () => {});
        fireEvent.click(
            within(screen.getByTestId("player")).getByRole("button"),
        );
        const bar = within(
            screen.getByRole("region", { name: "Cut recording" }),
        );
        fireEvent.click(bar.getByRole("button", { name: "Start here" }));
        fireEvent.click(bar.getByRole("button", { name: "End here" }));
        fireEvent.click(bar.getByRole("button", { name: "Cut…" }));
        fireEvent.click(screen.getByRole("button", { name: "Delete and cut" }));
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/recordings/recording/cut",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ startMs: 3000, endMs: 6000 }),
            },
        );
        expect(playback.pause).toHaveBeenCalledOnce();
        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(
            screen.queryByRole("region", { name: "Cut recording" }),
        ).toBeNull();
        expect(screen.getByRole("status").textContent).toBe("Cutting…");
        await act(async () => {
            post.resolve(Response.json({ jobId: "cut-job" }, { status: 202 }));
        });
        expect(polls).toBe(1);
        expect(screen.getByRole("status").textContent).toBe("Cutting…");
        for (const widget of ["player", "transcript"])
            expect(
                (
                    within(screen.getByTestId(widget)).getByRole("button", {
                        name: "Cutting…",
                    }) as HTMLButtonElement
                ).disabled,
            ).toBe(true);
        expect(changed).not.toHaveBeenCalled();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });
        expect(polls).toBe(2);
        expect(screen.queryByRole("status")).toBeNull();
        if (status === "failed") {
            expect(screen.getByRole("alert").textContent).toBe(
                "The recording or transcript changed. Reload it and choose the cut again.",
            );
            const reopened = within(
                screen.getByRole("region", { name: "Cut recording" }),
            );
            expect(reopened.getByText("Start 00:03")).toBeTruthy();
            expect(reopened.getByText("End 00:06")).toBeTruthy();
            expect(changed).not.toHaveBeenCalled();
        } else {
            expect(
                screen.queryByRole("region", { name: "Cut recording" }),
            ).toBeNull();
            expect(changed).toHaveBeenCalledOnce();
        }
        expect(toast.error).not.toHaveBeenCalled();
    });

    it.each([
        [
            403,
            "Only the recording owner may cut it",
            "Only the recording's owner can cut it.",
        ],
        [404, "Recording not found", "This recording no longer exists."],
        [
            400,
            "There is no audio or transcript to cut",
            "There is nothing left to cut: the recording has no audio or transcript.",
        ],
    ])("explains a rejected cut (%s)", async (status, error, message) => {
        fetchMock.mockImplementation(
            async (_url: string, init?: RequestInit) =>
                init?.method === "POST"
                    ? Response.json(
                          { error, code: "CUT_ERROR" },
                          { status: Number(status) },
                      )
                    : Response.json({ job: null }),
        );
        view();
        await act(async () => {});
        fireEvent.click(
            within(screen.getByTestId("player")).getByRole("button"),
        );
        const bar = within(
            screen.getByRole("region", { name: "Cut recording" }),
        );
        fireEvent.click(bar.getByRole("button", { name: "Start here" }));
        fireEvent.click(bar.getByRole("button", { name: "Cut…" }));
        await act(async () => {
            fireEvent.click(
                screen.getByRole("button", { name: "Delete and cut" }),
            );
        });
        expect(screen.getByRole("alert").textContent).toBe(message);
        expect(
            within(
                screen.getByRole("region", { name: "Cut recording" }),
            ).getByText("Start 00:03"),
        ).toBeTruthy();
        expect(toast.error).not.toHaveBeenCalled();
        expect(screen.queryByRole("status")).toBeNull();
        expect(changed).not.toHaveBeenCalled();
    });

    it("resumes a pending cut with disabled scissors and visible progress", async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({ job: { id: "job", status: "pending" } }),
                { status: 200 },
            ),
        );
        view();
        await act(async () => {});
        expect(screen.getByRole("status").textContent).toBe("Cutting…");
        expect(
            screen.queryByRole("region", { name: "Cut recording" }),
        ).toBeNull();
        const button = within(screen.getByTestId("player")).getByRole(
            "button",
            { name: "Cutting…" },
        ) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
    });
    it.each([
        true,
        false,
    ])("only offers Plaud audio restoration before a cut (cut=%s)", async (cut) => {
        render(
            <EraseRecordingMenu
                recording={{
                    ...recording,
                    audioReaped: true,
                    cutAt: cut ? "2026-11-03T07:00:00Z" : null,
                }}
                onChanged={changed}
            />,
        );
        fireEvent.keyDown(
            screen.getByRole("button", { name: "Erase recording artifacts" }),
            { key: "ArrowDown" },
        );
        await act(async () => {});
        expect(
            screen.queryByRole("menuitem", {
                name: "Restore audio from Plaud",
            }) !== null,
        ).toBe(!cut);
    });
    it("refreshes the player's peaks when the same recording's cut identity changes", () => {
        const { rerender } = render(
            <RecordingPlayer
                recording={{
                    ...recording,
                    waveformPeaks: [0.1, 1],
                    cutAt: null,
                }}
            />,
        );
        expect(screen.getByTestId("waveform-peaks").textContent).toBe(
            "[0.1,1]",
        );
        rerender(
            <RecordingPlayer
                recording={{
                    ...recording,
                    duration: 5000,
                    waveformPeaks: [0.8, 0.4],
                    cutAt: "2026-11-03T12:00:00Z",
                }}
            />,
        );
        expect(screen.getByTestId("waveform-peaks").textContent).toBe(
            "[0.8,0.4]",
        );
    });
    it("aborts old waveform fetches on a cut while ignoring same-identity peak props", async () => {
        const pending = Promise.withResolvers<Response>();
        fetchMock.mockReturnValue(pending.promise);
        const { result, rerender } = renderHook(
            ({
                audioIdentity,
                initialPeaks,
            }: {
                audioIdentity: string;
                initialPeaks: number[] | null;
            }) =>
                useWaveform({
                    recordingId: "recording",
                    audioIdentity,
                    durationMs: 10000,
                    initialPeaks,
                    autoStart: false,
                }),
            {
                initialProps: {
                    audioIdentity: "original",
                    initialPeaks: null as number[] | null,
                },
            },
        );
        act(() => {
            result.current.decode();
        });
        const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
        rerender({ audioIdentity: "cut", initialPeaks: [0.2, 0.9] });
        expect(signal.aborted).toBe(true);
        expect(result.current.peaks).toEqual([0.2, 0.9]);
        rerender({ audioIdentity: "cut", initialPeaks: [0.5] });
        expect(result.current.peaks).toEqual([0.2, 0.9]);
        await act(async () => {
            pending.resolve(new Response(new ArrayBuffer(8)));
        });
        expect(result.current.peaks).toEqual([0.2, 0.9]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
