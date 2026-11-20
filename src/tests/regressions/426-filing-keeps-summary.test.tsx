// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkstationDetailPane } from "@/components/dashboard/workstation-detail-pane";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import { processingFixture } from "@/tests/pipeline/processing-fixture";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

vi.mock("@/components/dashboard/recording-player", () => ({
    RecordingPlayer: () => <div data-testid="recording-player" />,
    transcriptPlayback: () => null,
}));
vi.mock("@/components/meetings/recording-agenda", () => ({
    RecordingAgenda: ({
        children,
    }: {
        children: (parts: {
            agenda: ReactNode;
            nextMeeting: ReactNode;
        }) => ReactNode;
    }) => children({ agenda: null, nextMeeting: null }),
}));
vi.mock("@/components/people/speaker-tags", () => ({
    SpeakerTags: () => null,
    confirmedAttributions: () => ({}),
}));
vi.mock("@/components/recordings/ai-cost-summary", () => ({
    AiCostSummary: () => null,
}));
vi.mock("@/components/learn/learn-review", () => ({ LearnReview: () => null }));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const recording: Recording = {
    id: "filing-regression",
    filename: "Planning session",
    duration: 5_000,
    filesize: 1,
    startTime: new Date(0).toISOString(),
    deviceSn: "local",
    hasTranscript: true,
    hasSummary: true,
    view: "private",
};

const props = {
    currentRecording: recording,
    transcripts: [
        {
            source: "riffado",
            text: "We use Path finder.",
            turns: [
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 5_000,
                    text: "We use Path finder.",
                },
            ],
        },
    ],
    currentTranscription: undefined,
    isCurrentTranscribing: false,
    visibleRecordings: [recording],
    onTranscribe: vi.fn(),
    onSelectRecording: vi.fn(),
    onDelete: vi.fn(),
    onArtifactsChanged: vi.fn(),
    onBackToList: vi.fn(),
    hiddenOnMobile: false,
    initialPlaybackSpeed: undefined,
    initialVolume: undefined,
    initialAutoPlayNext: undefined,
    scrubberStyle: undefined,
    folders: [],
    folderAssignments: [],
    onSelectFolder: vi.fn(),
    onAddToFolder: vi.fn(),
    onRemoveFromFolder: vi.fn(),
} satisfies ComponentProps<typeof WorkstationDetailPane>;

const orgFolder: RecordingFolder = {
    id: "org-project",
    parentId: "org-root",
    name: "Design team",
    kind: "custom",
    sortOrder: 0,
    scope: "org",
    version: 1,
};

function projection(shared: boolean, item: string, itemId = recording.id) {
    return {
        ...processingFixture({
            itemId,
            kind: "audio",
            legacy: false,
            manualOnly: false,
            phases: {
                categorize: {
                    state: "done",
                    generation: 1,
                    at: recording.startTime,
                },
            },
            profile: null,
            placements: [],
            intents: [],
            outputs: { transcript: true, summary: true, learn: false },
            processAgain: false,
            processAgainReason: null,
            learnFindingsWaiting: 0,
            taskReviewWaiting: 0,
            jobs: { transcription: null, summary: null },
            failures: [],
        }),
        access: {
            shared,
            role: "owner",
            contentView: shared ? "org" : "private",
        },
        versions: {
            item,
            folders: item,
            tasks: "tasks",
            title: "title",
            transcripts: {},
            learn: {},
            speakers: {},
            summaries: { riffado: item },
            corrections: { riffado: item },
        },
    };
}

const summary = "The team discussed navigation.";
const corrections = [
    {
        id: "correction-example",
        turnIndex: 0,
        charStart: 7,
        charEnd: 18,
        heard: "Path finder",
        kind: "correct",
        replacement: "Pathfinder",
        meaning: "Pathfinder",
    },
];
const correctionLabel = "Pathfinder, heard as Path finder: show undo";

it("keeps the summary and corrections while optimistically filing into the Organization", async () => {
    let processing = projection(false, "private");
    let finishPrivateProjection: (() => void) | undefined;
    let finishOrgSummary: (() => void) | undefined;
    let orgCorrectionsRead = 0;
    const summaryResponse = () => Response.json({ summary, source: "riffado" });
    const fetch = vi.fn(async (url: string) => {
        if (url.includes("processing=1")) {
            if (!finishPrivateProjection) {
                return new Promise<Response>((resolve) => {
                    finishPrivateProjection = () =>
                        resolve(Response.json({ processing }));
                });
            }
            return Response.json({ processing });
        }
        if (url.includes("/summary?")) {
            if (url.includes("view=org")) {
                return new Promise<Response>((resolve) => {
                    finishOrgSummary = () => resolve(summaryResponse());
                });
            }
            return summaryResponse();
        }
        if (url.includes("/corrections?")) {
            if (url.includes("view=org")) {
                orgCorrectionsRead++;
                return new Response("", { status: 500 });
            }
            return Response.json({ corrections, canUndo: true });
        }
        return Response.json({ profiles: [], speakers: [] });
    });
    vi.stubGlobal("fetch", fetch);

    const { rerender } = render(
        <WorkstationDetailPane {...props} folders={[orgFolder]} />,
    );
    const player = screen.getByTestId("recording-player");
    expect(await screen.findByText(summary)).toBeTruthy();
    expect(
        await screen.findByRole("button", { name: correctionLabel }),
    ).toBeTruthy();
    const contentReads = (view: "private" | "org") =>
        fetch.mock.calls
            .map(([url]) => url)
            .filter(
                (url) =>
                    /\/(summary|corrections)\?/.test(url) &&
                    url.includes("view=org") === (view === "org"),
            );
    expect(new Set(contentReads("private"))).toEqual(
        new Set([
            `/api/recordings/${recording.id}/summary?source=riffado`,
            `/api/recordings/${recording.id}/corrections?source=riffado`,
        ]),
    );

    rerender(
        <WorkstationDetailPane
            {...props}
            folders={[orgFolder]}
            folderAssignments={[
                { recordingId: recording.id, folderId: orgFolder.id },
            ]}
            recordingShared
        />,
    );
    expect(screen.getByText(orgFolder.name)).toBeTruthy();
    expect(contentReads("org")).toEqual([]);
    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.getByRole("button", { name: correctionLabel })).toBeTruthy();

    expect(finishPrivateProjection).toBeTypeOf("function");
    await act(async () => finishPrivateProjection?.());
    expect(contentReads("org")).toEqual([]);
    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.getByRole("button", { name: correctionLabel })).toBeTruthy();

    processing = projection(true, "shared");
    await act(async () => invalidateItemProcessing(recording.id));
    await waitFor(() => expect(contentReads("org")).toHaveLength(2));
    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.getByRole("button", { name: correctionLabel })).toBeTruthy();
    await act(async () => finishOrgSummary?.());
    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.getByRole("button", { name: correctionLabel })).toBeTruthy();

    processing = projection(true, "shared-org-row");
    rerender(
        <WorkstationDetailPane
            {...props}
            currentRecording={{ ...recording, view: "org" }}
            recordingShared
        />,
    );
    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.getByRole("button", { name: correctionLabel })).toBeTruthy();
    await waitFor(() => expect(orgCorrectionsRead).toBe(2));
    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.getByRole("button", { name: correctionLabel })).toBeTruthy();
    await act(async () => finishOrgSummary?.());
    expect(screen.getByTestId("recording-player")).toBe(player);
});

it("keeps the player and workflow strip mounted while the same item changes rows", async () => {
    const privateRow = { ...recording, id: "row-switch-regression" };
    const orgRow = { ...privateRow, view: "org" as const };
    const initial = projection(true, "shared", privateRow.id);
    const processing = {
        ...initial,
        steps: {
            ...initial.steps,
            learn: {
                state: "failed",
                reason: "lost",
                waitingFor: null,
                actions: [],
            },
        },
    };
    let finishOrgProjection: (() => void) | undefined;
    const fetch = vi.fn(async (url: string) => {
        if (url.includes("processing=1&view=org")) {
            return new Promise<Response>((resolve) => {
                finishOrgProjection = () =>
                    resolve(Response.json({ processing }));
            });
        }
        if (url.includes("processing=1")) return Response.json({ processing });
        return Response.json({ profiles: [], speakers: [] });
    });
    vi.stubGlobal("fetch", fetch);

    const { rerender } = render(
        <WorkstationDetailPane
            {...props}
            currentRecording={privateRow}
            recordingShared
        />,
    );
    const strip = await screen.findByLabelText("Workflow");
    const player = screen.getByTestId("recording-player");
    rerender(
        <WorkstationDetailPane
            {...props}
            currentRecording={orgRow}
            recordingShared
        />,
    );
    expect(finishOrgProjection).toBeTypeOf("function");
    expect(screen.getByLabelText("Workflow")).toBe(strip);
    expect(screen.getByTestId("recording-player")).toBe(player);
    await act(async () => finishOrgProjection?.());
    expect(screen.getByLabelText("Workflow")).toBe(strip);
    expect(screen.getByTestId("recording-player")).toBe(player);
});
