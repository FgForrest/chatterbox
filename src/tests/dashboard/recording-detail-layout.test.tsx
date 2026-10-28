// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, type Ref, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordingPlayerHandle } from "@/components/dashboard/recording-player";
import type { Recording } from "@/types/recording";

const playFrom = vi.hoisted(() => vi.fn());

vi.mock("@/components/meetings/recording-agenda", () => ({
    RecordingAgenda: ({
        children,
    }: {
        children: (parts: {
            notice: ReactNode;
            agenda: ReactNode;
            nextMeeting: ReactNode;
        }) => ReactNode;
    }) => children({ notice: null, agenda: null, nextMeeting: null }),
}));
vi.mock("@/components/dashboard/recording-player", () => ({
    RecordingPlayer: ({
        ref,
        onEnded,
    }: {
        ref: Ref<RecordingPlayerHandle>;
        onEnded?: () => void;
    }) => {
        useImperativeHandle(ref, () => ({
            playFrom,
            seekTo: vi.fn(),
            pause: vi.fn(),
            subscribe: () => () => {},
        }));
        return (
            <button
                type="button"
                data-testid="recording-player"
                onClick={onEnded}
            >
                End playback
            </button>
        );
    },
    transcriptPlayback: (ref: { current: RecordingPlayerHandle | null }) => ({
        play: (ms: number) => ref.current?.playFrom(ms / 1000),
    }),
}));

vi.mock("@/components/dashboard/recording-player-header", () => ({
    RecordingPlayerHeader: ({ recording }: { recording: Recording }) => (
        <h1>{recording.filename}</h1>
    ),
}));

vi.mock("@/components/dashboard/transcription-panel", () => ({
    TranscriptionPanel: () => <div data-testid="transcription-panel" />,
}));

vi.mock("@/components/recordings/erase-recording-menu", () => ({
    EraseRecordingMenu: () => null,
}));

vi.mock("@/components/pipeline/item-workflow", () => ({
    ItemWorkflow: () => (
        <>
            <div data-testid="workflow-strip" />
            <div data-testid="folder-row" />
        </>
    ),
}));

import { WorkstationDetailPane } from "@/components/dashboard/workstation-detail-pane";

const recording: Recording = {
    id: "rec-1",
    filename: "Planning session",
    duration: 60_000,
    filesize: 1024,
    startTime: new Date(0).toISOString(),
    deviceSn: "local",
};

const sharedProps = {
    currentTranscription: undefined,
    transcripts: undefined,
    isCurrentTranscribing: false,
    visibleRecordings: [recording],
    onTranscribe: vi.fn(),
    onSelectRecording: vi.fn(),
    onDelete: vi.fn(),
    onArtifactsChanged: vi.fn(),
    onBackToList: vi.fn(),
    hiddenOnMobile: false,
    initialPlaybackSpeed: 1,
    initialVolume: 75,
    initialAutoPlayNext: false,
    scrubberStyle: "waveform" as const,
    folders: [],
    folderAssignments: [],
    onSelectFolder: vi.fn(),
    onAddToFolder: vi.fn(),
    onRemoveFromFolder: vi.fn(),
};

describe("recording detail layout", () => {
    afterEach(() => {
        cleanup();
        playFrom.mockClear();
        window.history.replaceState({}, "", "/");
    });

    it("plays a task link once after its recording becomes selected", () => {
        window.history.replaceState(
            {},
            "",
            "/dashboard?recording=rec-1&playFrom=12500",
        );
        const { rerender } = render(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={{ ...recording, id: "other" }}
            />,
        );
        expect(playFrom).not.toHaveBeenCalled();

        rerender(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={recording}
            />,
        );
        expect(playFrom).toHaveBeenCalledExactlyOnceWith(12.5);

        rerender(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={{ ...recording }}
            />,
        );
        expect(playFrom).toHaveBeenCalledTimes(1);
    });

    it("plays captured link context after its URL parameters have been consumed", () => {
        window.history.replaceState(
            {},
            "",
            "/dashboard?recording=rec-1&view=org",
        );
        const linked = { ...recording, view: "org" as const };
        const { rerender } = render(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={linked}
                itemLinkQuery="recording=rec-1&view=org&playFrom=12500"
            />,
        );
        expect(playFrom).toHaveBeenCalledExactlyOnceWith(12.5);
        rerender(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={linked}
                itemLinkQuery="recording=rec-1&view=org"
            />,
        );
        expect(playFrom).toHaveBeenCalledTimes(1);
        rerender(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={linked}
                itemLinkQuery="recording=rec-1&view=org&playFrom=12500"
            />,
        );
        expect(playFrom).toHaveBeenCalledTimes(2);
    });

    it("auto advances through the automatic selection callback", () => {
        const onSelectRecording = vi.fn();
        const next = { ...recording, id: "next" };
        render(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={recording}
                visibleRecordings={[recording, next]}
                onSelectRecording={onSelectRecording}
            />,
        );
        fireEvent.click(screen.getByTestId("recording-player"));
        expect(onSelectRecording).toHaveBeenCalledExactlyOnceWith(next);
    });

    it("keeps the player mounted when switching recordings", () => {
        const { rerender } = render(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={recording}
            />,
        );
        const player = screen.getByTestId("recording-player");
        rerender(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={{ ...recording, id: "next-recording" }}
            />,
        );
        expect(screen.getByTestId("recording-player")).toBe(player);
    });

    it("orders the title, workflow, folder row, player, and detail panels", () => {
        render(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={recording}
            />,
        );

        const ordered = [
            screen.getByRole("heading", { name: "Planning session" }),
            screen.getByTestId("workflow-strip"),
            screen.getByTestId("folder-row"),
            screen.getByTestId("recording-player"),
            screen.getByTestId("transcription-panel"),
        ];
        for (let index = 1; index < ordered.length; index += 1) {
            expect(
                ordered[index - 1].compareDocumentPosition(ordered[index]) &
                    Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
        }
    });

    it("uses the current location and a kind-neutral empty state", () => {
        const { rerender } = render(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={recording}
            />,
        );

        expect(screen.getByRole("button", { name: "Recent" })).toBeTruthy();

        rerender(
            <WorkstationDetailPane {...sharedProps} currentRecording={null} />,
        );
        expect(
            screen.getByText("Select an item to view its details"),
        ).toBeTruthy();
        expect(screen.queryByText(/Select a recording/)).toBeNull();
    });

    it.each([
        "Recent",
        "Private",
        "Invented folder",
    ])("names the current list location on the phone back button: %s", (backLabel) => {
        render(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={recording}
                backLabel={backLabel}
            />,
        );
        expect(
            screen.getByRole("button", { name: backLabel }).className,
        ).toContain("lg:hidden");
        fireEvent.click(screen.getByRole("button", { name: backLabel }));
        expect(sharedProps.onBackToList).toHaveBeenCalled();
    });
    it.each([
        ["a different recording", "recording=other&playFrom=12500", recording],
        [
            "a different view",
            "recording=rec-1&view=org&playFrom=12500",
            recording,
        ],
        ["an invalid timestamp", "recording=rec-1&playFrom=12s", recording],
        [
            "removed audio",
            "recording=rec-1&playFrom=12500",
            { ...recording, audioReaped: true },
        ],
        [
            "mail",
            "recording=rec-1&playFrom=12500",
            { ...recording, kind: "mail" as const },
        ],
    ])("does not play for %s", (_reason, query, currentRecording) => {
        window.history.replaceState({}, "", `/dashboard?${query}`);
        render(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={currentRecording}
            />,
        );
        expect(playFrom).not.toHaveBeenCalled();
    });

    it("keeps the recording heading while removing the player for erased audio", () => {
        const { rerender } = render(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={recording}
            />,
        );

        expect(
            screen.getByRole("heading", { name: "Planning session" }),
        ).toBeTruthy();
        expect(screen.getByTestId("recording-player")).toBeTruthy();

        rerender(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={{
                    ...recording,
                    audioReaped: true,
                    hasTranscript: true,
                }}
            />,
        );

        expect(
            screen.getByRole("heading", { name: "Planning session" }),
        ).toBeTruthy();
        expect(screen.queryByTestId("recording-player")).toBeNull();
        expect(screen.getByTestId("transcription-panel")).toBeTruthy();

        rerender(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={{
                    ...recording,
                    audioReaped: true,
                    hasTranscript: false,
                }}
            />,
        );

        expect(screen.queryByTestId("transcription-panel")).toBeNull();
    });

    it("remounts artifact panels after transcript or summary availability changes", () => {
        const { rerender } = render(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={{
                    ...recording,
                    hasTranscript: true,
                    hasSummary: true,
                }}
            />,
        );
        const panelBeforeErase = screen.getByTestId("transcription-panel");

        rerender(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={{
                    ...recording,
                    hasTranscript: true,
                    hasSummary: false,
                }}
            />,
        );

        expect(screen.getByTestId("transcription-panel")).not.toBe(
            panelBeforeErase,
        );
    });
});
