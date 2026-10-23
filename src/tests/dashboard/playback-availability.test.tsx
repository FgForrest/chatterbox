// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkstationDetailPane } from "@/components/dashboard/workstation-detail-pane";
import type { TaskView } from "@/lib/tasks/tasks";
import { createTestPlayback } from "@/tests/helpers/playback";
import type { Recording } from "@/types/recording";

vi.mock("@/components/dashboard/recording-player", () => ({
    RecordingPlayer: () => <div data-testid="player" />,
    transcriptPlayback: () => createTestPlayback().playback,
}));
vi.mock("@/components/dashboard/recording-player-header", () => ({
    RecordingPlayerHeader: () => null,
}));
vi.mock("@/components/pipeline/item-workflow", () => ({
    ItemWorkflow: () => null,
}));
vi.mock("@/components/recordings/erase-recording-menu", () => ({
    EraseRecordingMenu: () => null,
}));
vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => null,
}));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));
vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: () => ({
        summaryData: {
            summary: "A sketch review",
            actionItems: [],
            keyPoints: [],
        },
        summaryLoaded: true,
        isSummarizing: false,
        summaryExpanded: true,
        setSummaryExpanded: vi.fn(),
        handleSummarize: vi.fn(),
        recheckSummary: vi.fn(),
    }),
}));

const turns = [
    {
        speaker: "speaker_0",
        startMs: 1000,
        endMs: 4000,
        text: "First sentence. Second sentence.",
    },
    {
        speaker: "speaker_1",
        startMs: 5000,
        endMs: 9000,
        text: "Send the sketch.",
    },
];
const recording: Recording = {
    id: "recording",
    filename: "Sketch review",
    duration: 9000,
    filesize: 100,
    startTime: "2026-10-21T00:00:00Z",
    deviceSn: "local",
    hasTranscript: true,
    hasSummary: true,
};
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
    createdAt: recording.startTime,
    acceptedAt: null,
    statusChangedAt: null,
    canEdit: true,
    canClose: true,
    canUndoMatch: false,
    own: false,
    note: null,
    noteUpdatedAt: null,
    noteBy: null,
    following: false,
    automaticFollow: false,
    canFollow: false,
    canMerge: false,
};
const props = {
    currentTranscription: undefined,
    transcripts: [
        {
            source: "riffado",
            text: turns.map((turn) => turn.text).join(" "),
            turns,
        },
    ],
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
    scrubberStyle: "slider" as const,
    folders: [],
    folderAssignments: [],
    onSelectFolder: vi.fn(),
    onAddToFolder: vi.fn(),
    onRemoveFromFolder: vi.fn(),
};

beforeEach(() => {
    Element.prototype.scrollTo = vi.fn();
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            if (url.includes("/tasks"))
                return Response.json({
                    canEdit: true,
                    reviewed: true,
                    tasks: [task],
                    proposals: [],
                    updates: [],
                    matches: [],
                });
            if (url.includes("/review"))
                return Response.json({
                    run: { id: "run", status: "ready" },
                    available: true,
                    names: { person: "Neri Vosk" },
                    types: {},
                    relations: {},
                    items: [
                        {
                            id: "new",
                            kind: "new_record",
                            preTicked: false,
                            decision: null,
                            choice: null,
                            version: 0,
                            dependsOnLabel: null,
                            payload: {
                                ref: "n1",
                                kind: "entity",
                                typeKey: "project",
                                name: "Cloudfern",
                                evidenceMs: [5000, 5100],
                                reason: "A project",
                            },
                        },
                        {
                            id: "speaker",
                            kind: "speaker",
                            preTicked: false,
                            decision: null,
                            choice: null,
                            version: 0,
                            dependsOnLabel: null,
                            payload: {
                                label: "speaker_0",
                                personId: "person",
                                evidenceMs: [1000],
                                reason: "Introduced themselves",
                            },
                        },
                    ],
                });
            return Response.json({
                speakers: [],
                corrections: [],
                topics: null,
                held: false,
                pending: [],
            });
        }),
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

it.each([
    false,
    true,
])("centralizes playback for transcript, Learn and summary tasks with audioReaped=%s", async (audioReaped) => {
    render(
        <WorkstationDetailPane
            {...props}
            currentRecording={{ ...recording, audioReaped }}
        />,
    );
    await screen.findByDisplayValue("Send the sketch");
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByDisplayValue("Cloudfern");
    expect(screen.queryByTestId("player") !== null).toBe(!audioReaped);
    if (audioReaped) {
        expect(
            screen.queryAllByRole("button", {
                name: /Play|Listen|Pause|Seek audio/,
            }),
        ).toHaveLength(0);
        expect(
            document.querySelector("[data-sentence], [data-marker]"),
        ).toBeNull();
        expect(screen.queryByRole("link", { name: /Play/ })).toBeNull();
        expect(
            within(
                screen
                    .getByDisplayValue("Cloudfern")
                    .closest("[data-shared-learn-row]") as HTMLElement,
            ).getAllByText("00:05"),
        ).toHaveLength(1);
    } else {
        expect(
            screen.getByRole("button", { name: "Play where it was said" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Play from 00:05" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Play a turn of Speaker 0" }),
        ).toBeTruthy();
        expect(document.querySelector("[data-sentence]")).toBeTruthy();
    }
});
