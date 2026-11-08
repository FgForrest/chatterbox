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
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingPlayer } from "@/components/dashboard/recording-player";
import { TranscriptView } from "@/components/dashboard/transcript-view";
import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";
import { PlaybackProvider } from "@/components/playback/playback-context";
import { EraseRecordingMenu } from "@/components/recordings/erase-recording-menu";
import {
    CutEdgeChip,
    CutParagraphBoundary,
    CutPreviewOverlay,
    RecordingCutButton,
    RecordingCutPanel,
    RecordingCutProvider,
} from "@/components/recordings/recording-cut";
import { useWaveform } from "@/hooks/use-waveform";
import type { Recording } from "@/types/recording";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("@/components/summary/summary-widget", () => ({
    SummaryWidget: () => null,
}));
vi.mock("@/components/learn/learn-review", () => ({ LearnReview: () => null }));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));

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
        trailingAction,
    }: {
        trailingAction?: ReactNode;
        waveformPeaks: number[] | null;
    }) => (
        <>
            <div data-testid="waveform-peaks">
                {JSON.stringify(waveformPeaks)}
            </div>
            {trailingAction}
        </>
    ),
}));

const turns = [
    { speaker: "S1", startMs: 0, endMs: 2000, text: "Private beginning." },
    { speaker: "S2", startMs: 3000, endMs: 6000, text: "Keep the middle." },
    { speaker: "S1", startMs: 6000, endMs: 10000, text: "Private end." },
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
                <RecordingCutPanel />
                <div data-testid="player">
                    <RecordingPlayer
                        recording={{
                            ...recording,
                            ...overrides,
                            waveformPeaks: [0.1, 1],
                        }}
                    />
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

function typeTime(label: string, value: string, enter = false) {
    const field = screen.getByRole("textbox", { name: label });
    fireEvent.change(field, { target: { value } });
    if (enter) fireEvent.keyDown(field, { key: "Enter" });
    else fireEvent.blur(field);
}
function boundary(ms: number): HTMLElement {
    const element = document.querySelector<HTMLElement>(
        `[data-cut-boundary="${ms}"]`,
    );
    if (!element) throw new Error(`Missing boundary ${ms}`);
    return element;
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
    it.each([
        { isOwn: false },
        { view: "org" as const, isOwn: true },
        { view: "received" as const },
    ])("hides edge chips for a reader %j", (overrides) => {
        render(
            <RecordingCutProvider
                recording={{ ...recording, ...overrides }}
                transcripts={[{ turns }]}
                transcribing={false}
                shared={false}
                onChanged={changed}
            >
                <CutEdgeChip edge="start" />
                <CutEdgeChip edge="end" />
            </RecordingCutProvider>,
        );
        expect(screen.queryByText("Start 00:00")).toBeNull();
        expect(screen.queryByText("End 00:10")).toBeNull();
    });
    it("only the transcript scissors toggle the panel", () => {
        view();
        const transcript = within(screen.getByTestId("transcript"));
        expect(
            within(screen.getByTestId("player")).queryByRole("button", {
                name: "Cut the start and end",
            }),
        ).toBeNull();
        expect(
            transcript.getByRole("button").getAttribute("aria-pressed"),
        ).toBe("false");
        fireEvent.click(transcript.getByRole("button"));
        const panel = screen.getByRole("region", { name: "Cut recording" });
        expect(panel.className).not.toMatch(/sticky|fixed/);
        expect(transcript.getByRole("button").className).toContain(
            "text-primary",
        );
        expect(
            transcript.getByRole("button").getAttribute("aria-pressed"),
        ).toBe("true");
        fireEvent.click(transcript.getByRole("button"));
        expect(
            screen.queryByRole("region", { name: "Cut recording" }),
        ).toBeNull();
    });
    it("accepts typed boundaries and previews the removed text", () => {
        view();
        fireEvent.click(
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        const bar = within(
            screen.getByRole("region", { name: "Cut recording" }),
        );
        typeTime("From", "00:03");
        typeTime("To", "00:06");
        expect(
            (bar.getByRole("textbox", { name: "From" }) as HTMLInputElement)
                .value,
        ).toBe("00:03");
        expect(
            (bar.getByRole("textbox", { name: "To" }) as HTMLInputElement)
                .value,
        ).toBe("00:06");
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
        fireEvent.click(screen.getByRole("button", { name: "Reset start" }));
        expect(
            (screen.getByRole("textbox", { name: "From" }) as HTMLInputElement)
                .value,
        ).toBe("00:00");
    });
    it("turn buttons set boundaries without seeking and Cancel changes nothing", async () => {
        view();
        fireEvent.click(
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        fireEvent.click(
            within(boundary(3000)).getByRole("button", { name: "Start here" }),
        );
        fireEvent.click(
            within(boundary(6000)).getByRole("button", { name: "End here" }),
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
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        const bar = within(
            screen.getByRole("region", { name: "Cut recording" }),
        );
        typeTime("From", "00:03");
        typeTime("To", "00:06");
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
                within(screen.getByTestId("transcript")).getByRole(
                    "button",
                ) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        fireEvent.click(
            within(screen.getByTestId("transcript")).getByRole("button"),
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
        fireEvent.click(
            within(boundary(3000)).getByRole("button", { name: "Start here" }),
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
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        const bar = within(
            screen.getByRole("region", { name: "Cut recording" }),
        );
        typeTime("From", "00:03");
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
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        const bar = within(
            screen.getByRole("region", { name: "Cut recording" }),
        );
        typeTime("From", "00:03");
        typeTime("To", "00:06");
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
            screen.getByRole("region", { name: "Cut recording" }),
        ).toBeTruthy();
        expect(screen.getByRole("status").textContent).toMatch(/^Cutting /);
        await act(async () => {
            post.resolve(Response.json({ jobId: "cut-job" }, { status: 202 }));
        });
        expect(polls).toBe(1);
        expect(screen.getByRole("status").textContent).toMatch(/^Cutting /);
        for (const widget of ["transcript"])
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
            expect(
                (
                    reopened.getByRole("textbox", {
                        name: "From",
                    }) as HTMLInputElement
                ).value,
            ).toBe("00:03");
            expect(
                (
                    reopened.getByRole("textbox", {
                        name: "To",
                    }) as HTMLInputElement
                ).value,
            ).toBe("00:06");
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
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        const bar = within(
            screen.getByRole("region", { name: "Cut recording" }),
        );
        typeTime("From", "00:03");
        fireEvent.click(bar.getByRole("button", { name: "Cut…" }));
        await act(async () => {
            fireEvent.click(
                screen.getByRole("button", { name: "Delete and cut" }),
            );
        });
        expect(screen.getByRole("alert").textContent).toBe(message);
        expect(
            within(screen.getByRole("region", { name: "Cut recording" }))
                .getByRole("textbox", { name: "From" })
                .getAttribute("value"),
        ).toBe("00:03");
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
        expect(screen.getByRole("status").textContent).toMatch(/^Cutting /);
        expect(
            screen.getByRole("region", { name: "Cut recording" }),
        ).toBeTruthy();
        const button = within(screen.getByTestId("transcript")).getByRole(
            "button",
            { name: "Cutting…" },
        ) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
    });
    it.each([
        false,
        true,
    ])("keeps the panel directly above the transcript card (agenda=%s)", async (agenda) => {
        render(
            <RecordingCutProvider
                recording={recording}
                transcripts={[{ turns }]}
                transcribing={false}
                shared={false}
                onChanged={changed}
            >
                <TranscriptionPanel
                    recording={recording}
                    transcripts={[
                        { source: "riffado", text: "Meeting", turns },
                    ]}
                    isTranscribing={false}
                    onTranscribe={vi.fn()}
                    agenda={agenda ? <div>Agenda</div> : undefined}
                />
            </RecordingCutProvider>,
        );
        await act(async () => {});
        fireEvent.click(
            screen.getByRole("button", { name: "Cut the start and end" }),
        );
        const panel = screen.getByRole("region", { name: "Cut recording" });
        const card = screen
            .getByRole("button", { name: "Close cutting" })
            .closest('[data-slot="card"]');
        expect(card?.parentElement).toBe(panel.parentElement);
        expect(card?.previousElementSibling?.className).toBe("contents");
        expect(card?.previousElementSibling?.previousElementSibling).toBe(
            panel,
        );
        expect(panel.parentElement?.className).toBe(
            agenda ? "order-4 flex flex-col gap-3" : "flex flex-col gap-3",
        );
    });
    it("offers gap actions at a topic inside a turn without adding controls to the text", () => {
        const longTurn = {
            speaker: "S1",
            startMs: 1000,
            endMs: 121000,
            text: "Opening sentence. Chapter sentence. Following sentence. Final sentence.",
            sentenceStartsMs: [1000, 19000, 37000, 79000],
        };
        render(
            <RecordingCutProvider
                recording={{ ...recording, duration: 125000 }}
                transcripts={[{ turns: [longTurn] }]}
                transcribing={false}
                shared={false}
                onChanged={changed}
            >
                <RecordingCutButton />
                <RecordingCutPanel />
                <TranscriptView
                    text={longTurn.text}
                    storedTurns={[longTurn]}
                    topics={[{ title: "Chapter", fromMs: 19000, toMs: 121000 }]}
                />
            </RecordingCutProvider>,
        );
        const before = [...document.querySelectorAll(".group\\/para")].map(
            (element) => element.className,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Cut the start and end" }),
        );
        expect(
            [...document.querySelectorAll(".group\\/para")].map(
                (element) => element.className,
            ),
        ).toEqual(before);
        const pill = boundary(19000);
        expect(pill.className).toContain("absolute");
        expect(pill.querySelector(".group\\/para")).toBeNull();
        expect(
            document.querySelector(".group\\/para [data-cut-boundary]"),
        ).toBeNull();
        expect(pill.textContent).toContain("00:19");
        expect(
            within(pill).getByRole("button", { name: "Start here" }).className,
        ).toContain("focus-visible:ring");
        fireEvent.focus(
            within(pill).getByRole("button", { name: "Start here" }),
        );
        fireEvent.click(
            within(pill).getByRole("button", { name: "Start here" }),
        );
        expect(
            (screen.getByRole("textbox", { name: "From" }) as HTMLInputElement)
                .value,
        ).toBe("00:19");
        expect(screen.getByText("Start 00:19")).toBeTruthy();
        expect(
            screen.getByText("Opening sentence.").closest(".group\\/para")
                ?.className,
        ).toContain("line-through");
        fireEvent.click(
            within(boundary(79000)).getByRole("button", { name: "End here" }),
        );
        expect(
            (screen.getByRole("textbox", { name: "To" }) as HTMLInputElement)
                .value,
        ).toBe("01:19");
        expect(
            screen.getByText("Final sentence.").closest(".group\\/para")
                ?.className,
        ).toContain("line-through");
        expect(
            screen.getByText("Chapter sentence.").closest(".group\\/para")
                ?.className,
        ).not.toContain("line-through");
        expect(document.querySelectorAll("[data-cut-boundary]")).toHaveLength(
            3,
        );
    });
    it.each([
        "Start here",
        "End here",
    ])("disables %s gap actions that would cross or equal the other edge", (name) => {
        render(
            <RecordingCutProvider
                recording={recording}
                transcripts={[{ turns }]}
                transcribing={false}
                shared={false}
                onChanged={changed}
            >
                <RecordingCutButton />
                <RecordingCutPanel />
                {[0, 3000, 6000, 10000].map((ms) => (
                    <CutParagraphBoundary key={ms} ms={ms} />
                ))}
            </RecordingCutProvider>,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Cut the start and end" }),
        );
        typeTime("From", "00:03");
        typeTime("To", "00:06");
        for (const ms of [0, 3000, 6000, 10000]) {
            const button = within(boundary(ms)).getByRole("button", {
                name,
            }) as HTMLButtonElement;
            const disabled = name === "Start here" ? ms >= 6000 : ms <= 3000;
            expect(button.disabled).toBe(disabled);
            if (disabled) fireEvent.click(button);
        }
        expect(
            (screen.getByRole("textbox", { name: "From" }) as HTMLInputElement)
                .value,
        ).toBe("00:03");
        expect(
            (screen.getByRole("textbox", { name: "To" }) as HTMLInputElement)
                .value,
        ).toBe("00:06");
    });
    it("snaps typed fields on blur and Enter and restores invalid or crossed edges inline", () => {
        view();
        fireEvent.click(
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        typeTime("From", "00:02", true);
        expect(
            (screen.getByRole("textbox", { name: "From" }) as HTMLInputElement)
                .value,
        ).toBe("00:03");
        typeTime("To", "00:09");
        expect(
            (screen.getByRole("textbox", { name: "To" }) as HTMLInputElement)
                .value,
        ).toBe("00:10");
        typeTime("To", "00:06");
        for (const value of ["5", "nonsense", "00:99", "00:10"]) {
            typeTime("From", value);
            const field = screen.getByRole("textbox", { name: "From" });
            expect((field as HTMLInputElement).value).toBe("00:03");
            expect(field.getAttribute("aria-invalid")).toBe("true");
            expect(
                document.getElementById(
                    field.getAttribute("aria-describedby") ?? "",
                )?.textContent,
            ).toMatch(/previous time was restored/);
        }
        expect(toast.error).not.toHaveBeenCalled();
    });
    it.each([
        "From",
        "To",
    ])("keeps %s focused when Enter commits a changed time", (label) => {
        view();
        fireEvent.click(
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        const field = screen.getByRole("textbox", { name: label });
        field.focus();
        typeTime(label, label === "From" ? "00:03" : "00:06", true);
        expect(document.activeElement).toBe(field);
        expect(screen.getByRole("textbox", { name: label })).toBe(field);
        fireEvent.change(field, { target: { value: "unfinished" } });
        fireEvent.click(
            within(boundary(3000)).getByRole("button", {
                name: label === "From" ? "Reset start" : "End here",
            }),
        );
        expect((field as HTMLInputElement).value).toBe(
            label === "From" ? "00:00" : "00:03",
        );
    });
    it("renders time values as foreground text while labels stay muted", () => {
        view();
        fireEvent.click(
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        for (const label of ["From", "To"]) {
            const field = screen.getByRole("textbox", { name: label });
            expect(field.classList.contains("text-foreground")).toBe(true);
            expect(
                field
                    .closest("label")
                    ?.classList.contains("text-muted-foreground"),
            ).toBe(true);
        }
    });
    it("places the invalid-time hint below the control row and describes only invalid fields", () => {
        view();
        fireEvent.click(
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        const panel = screen.getByRole("region", { name: "Cut recording" });
        typeTime("From", "invalid");
        const from = screen.getByRole("textbox", { name: "From" });
        const to = screen.getByRole("textbox", { name: "To" });
        const hint = document.getElementById(
            from.getAttribute("aria-describedby") ?? "",
        );
        expect(hint).not.toBeNull();
        expect(hint?.parentElement).toBe(panel);
        expect(panel.firstElementChild?.contains(hint)).toBe(false);
        expect(to.hasAttribute("aria-describedby")).toBe(false);
        typeTime("To", "invalid");
        expect(to.getAttribute("aria-describedby")).toBe(hint?.id);
        fireEvent.change(from, { target: { value: "00:03" } });
        expect(from.getAttribute("aria-invalid")).toBe("false");
        expect(
            document.getElementById(to.getAttribute("aria-describedby") ?? ""),
        ).toBe(hint);
    });
    it("limits gap hit testing to visible pills and keeps keyboard reveal", () => {
        view();
        fireEvent.click(
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        const gap = boundary(3000);
        expect(gap.className).toContain("h-4");
        const button = within(gap).getByRole("button", { name: "Start here" });
        const pill = button.parentElement;
        const row = pill?.parentElement;
        expect(row?.classList.contains("pointer-events-none")).toBe(true);
        for (const line of row?.querySelectorAll(".border-t") ?? []) {
            expect(line.classList.contains("pointer-events-none")).toBe(true);
        }
        expect(pill?.classList.contains("pointer-events-none")).toBe(true);
        expect(
            pill?.classList.contains("group-hover/cut:pointer-events-auto"),
        ).toBe(true);
        expect(
            pill?.classList.contains(
                "group-focus-within/cut:pointer-events-auto",
            ),
        ).toBe(true);
        expect(pill?.classList.contains("h-4")).toBe(true);
        expect(
            row?.classList.contains("group-focus-within/cut:opacity-100"),
        ).toBe(true);
        button.focus();
        expect(document.activeElement).toBe(button);
    });
    it("describes each gap action with its paragraph time", () => {
        view();
        fireEvent.click(
            within(screen.getByTestId("transcript")).getByRole("button"),
        );
        for (const name of ["Start here", "End here"]) {
            const button = within(boundary(3000)).getByRole("button", { name });
            const description = document.getElementById(
                button.getAttribute("aria-describedby") ?? "",
            );
            expect(description?.textContent).toBe("00:03");
        }
    });
    it("accepts hour clocks and snaps to stored sentence times inside a paragraph", () => {
        const longTurn = {
            speaker: "S1",
            startMs: 0,
            endMs: 3800000,
            text: "Opening. Keep. Ending.",
            sentenceStartsMs: [0, 3723456, 3750000],
        };
        render(
            <RecordingCutProvider
                recording={{ ...recording, duration: 3800000 }}
                transcripts={[{ turns: [longTurn] }]}
                transcribing={false}
                shared={false}
                onChanged={changed}
            >
                <RecordingCutButton />
                <RecordingCutPanel />
            </RecordingCutProvider>,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Cut the start and end" }),
        );
        typeTime("From", "1:02:04");
        expect(
            (screen.getByRole("textbox", { name: "From" }) as HTMLInputElement)
                .value,
        ).toBe("1:02:03");
        typeTime("To", "1:02:30", true);
        expect(
            (screen.getByRole("textbox", { name: "To" }) as HTMLInputElement)
                .value,
        ).toBe("1:02:30");
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
