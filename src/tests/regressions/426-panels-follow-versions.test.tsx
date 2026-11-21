// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    renderHook,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { type ComponentProps, type ReactNode, useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { TranscriptView } from "@/components/dashboard/transcript-view";
import type { TranscriptOption } from "@/components/dashboard/transcription-panel";
import { WorkstationDetailPane } from "@/components/dashboard/workstation-detail-pane";
import { ItemDetailProvider } from "@/components/items/item-detail-store";
import {
    ItemOperationQueue,
    itemOperationResult,
} from "@/components/items/item-operation-queue";
import { openWidget } from "@/components/pipeline/workflow-widget";
import { useRecordingTasks } from "@/components/tasks/use-recording-tasks";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import { projectProcessing } from "@/lib/pipeline/processing-status";
import { processingFixture } from "@/tests/pipeline/processing-fixture";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

const mounts = vi.hoisted(() => ({ transcript: vi.fn(), player: vi.fn() }));

vi.mock("@/components/dashboard/transcript-view", () => ({
    TranscriptView: ({
        text,
        topics,
    }: ComponentProps<typeof TranscriptView>) => {
        useEffect(() => {
            mounts.transcript();
        }, []);
        return (
            <div>
                {text}
                {topics?.map((topic) => (
                    <p key={topic.title}>{topic.title}</p>
                ))}
            </div>
        );
    },
}));
vi.mock("@/components/dashboard/recording-player", () => ({
    RecordingPlayer: () => {
        useEffect(() => {
            mounts.player();
        }, []);
        return null;
    },
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
vi.mock("@/components/recordings/ai-cost-summary", () => ({
    AiCostSummary: () => null,
}));

const item: Recording = {
    id: "versioned-panels",
    filename: "Planning session",
    duration: 5_000,
    filesize: 1,
    startTime: new Date(0).toISOString(),
    deviceSn: "local",
    hasTranscript: true,
    hasSummary: false,
    view: "private",
};

function transcript(source: string, revision = 1) {
    const text = `${source} transcript ${revision}`;
    return {
        source,
        text,
        language: "en",
        contentVersion: `${source}-${revision}`,
        version: { transcriptionId: source, revision },
        turns: [{ speaker: "speaker_0", startMs: 0, endMs: 5_000, text }],
    } satisfies TranscriptOption & { contentVersion: string };
}

const props = {
    currentRecording: item,
    currentTranscription: undefined,
    transcripts: [transcript("plaud"), transcript("riffado")],
    isCurrentTranscribing: false,
    visibleRecordings: [item],
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

const reviewPhase = {
    state: "waiting",
    reason: "review_pending",
    generation: 1,
    at: item.startTime,
    waitingFor: { kind: "learnReview" },
} as const;
const categorized = {
    state: "done",
    generation: 1,
    at: item.startTime,
} as const;
function projection() {
    return {
        ...processingFixture({
            itemId: item.id,
            kind: "audio",
            legacy: false,
            manualOnly: false,
            phases: { categorize: categorized, learn: reviewPhase },
            profile: null,
            placements: [],
            intents: [],
            outputs: { transcript: true, summary: false, learn: false },
            processAgain: false,
            processAgainReason: null,
            learnFindingsWaiting: 1,
            taskReviewWaiting: 0,
            jobs: { transcription: null, summary: null },
            failures: [],
        }),
        access: {
            shared: false,
            role: "owner" as const,
            contentView: "private" as "private" | "org",
        },
        versions: {
            item: "item-1",
            folders: "folders",
            tasks: "tasks-1",
            title: "title-1",
            transcripts: { plaud: "plaud-1", riffado: "riffado-1" },
            summaries: {},
            learn: { riffado: "run-1" },
            speakers: { riffado: "speakers-1" },
            corrections: {},
            language: "language-1",
        },
    };
}

type Projection = Omit<ReturnType<typeof projection>, "versions"> & {
    versions: NonNullable<ReturnType<typeof processingFixture>["versions"]>;
};
type Reply = (
    url: string,
    options?: RequestInit,
) => Response | Promise<Response> | undefined;

function server(reply?: Reply, initial: Projection = projection()) {
    let current = initial;
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
        const response = reply?.(url, options);
        if (response) return response;
        if (url.includes("processing=1"))
            return Response.json({ processing: current });
        return Response.json({
            profiles: [],
            tasks: [],
            proposals: [],
            updates: [],
            matches: [],
            speakers: [],
        });
    });
    vi.stubGlobal("fetch", fetch);
    return {
        fetch,
        set(next: Projection) {
            current = next;
        },
        async update(next: Projection) {
            current = next;
            await act(async () => invalidateItemProcessing(item.id));
        },
    };
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

it("reads each recording part once on a cold open and once when its version changes", async () => {
    const projectionRead = Promise.withResolvers<Response>();
    const initial = projection();
    const base = {
        ...initial,
        outputs: { ...initial.outputs, summary: true },
        versions: {
            ...initial.versions,
            summaries: { riffado: "summary-1" },
            corrections: { riffado: "corrections-1" },
        },
    };
    const api = `/api/recordings/${item.id}`;
    const parts = [
        `${api}/summary?source=riffado`,
        `${api}/corrections?source=riffado`,
        `${api}/speakers?source=riffado`,
        `${api}/language`,
        `${api}/review?source=riffado`,
        `${api}/topics?source=riffado`,
        `${api}/tasks`,
    ];
    const replies = new Map<string, unknown>([
        [
            parts[0],
            { summary: "The schedule is confirmed.", source: "riffado" },
        ],
        [parts[1], { corrections: [] }],
        [parts[2], { speakers: [] }],
        [parts[3], { confirmedLanguage: "cs", canChange: true }],
        [parts[4], review()],
        [parts[5], { topics: [] }],
        [parts[6], { tasks: [], proposals: [], updates: [], matches: [] }],
    ]);
    const inFlight = new Map(
        [parts[0], parts[1], parts[4], parts[5], parts[6]].map((url) => [
            url,
            Promise.withResolvers<Response>(),
        ]),
    );
    let projectionResolved = false;
    const remote = server((url) => {
        if (url.includes("processing=1") && !projectionResolved)
            return projectionRead.promise;
        if (!replies.has(url)) return;
        return inFlight.get(url)?.promise ?? Response.json(replies.get(url));
    }, base);
    const requests = () =>
        parts.map((part) =>
            remote.fetch.mock.calls.filter(([url]) => url === part),
        );

    render(
        <WorkstationDetailPane
            {...props}
            currentRecording={{ ...item, view: undefined, hasSummary: true }}
            transcripts={[transcript("riffado")]}
        />,
    );
    await waitFor(() =>
        expect(requests().map((calls) => calls.length)).toEqual(
            parts.map(() => 1),
        ),
    );
    expect(await screen.findByText("Czech")).toBeTruthy();
    projectionResolved = true;
    await act(async () =>
        projectionRead.resolve(Response.json({ processing: base })),
    );
    expect(requests().map((calls) => calls.length)).toEqual(parts.map(() => 1));
    for (const calls of requests())
        expect(calls[0][1]?.signal?.aborted).toBe(false);
    await act(async () => {
        for (const [url, reply] of inFlight)
            reply.resolve(Response.json(replies.get(url)));
        inFlight.clear();
    });
    expect(await screen.findByText("The schedule is confirmed.")).toBeTruthy();
    expect(requests().map((calls) => calls.length)).toEqual(parts.map(() => 1));

    await remote.update({
        ...base,
        versions: {
            ...base.versions,
            item: "item-2",
            summaries: { riffado: "summary-2" },
            corrections: { riffado: "corrections-2" },
            speakers: { riffado: "speakers-2" },
            language: "language-2",
            learn: { riffado: "run-2" },
            transcripts: { riffado: "riffado-2" },
            tasks: "tasks-2",
        },
    });
    expect(requests().map((calls) => calls.length)).toEqual(parts.map(() => 2));
});

it("defaults to Custom during a workflow with Plaud first in the props", async () => {
    server();
    render(<WorkstationDetailPane {...props} />);
    await screen.findByLabelText("Workflow");
    expect(screen.getByText("riffado transcript 1")).toBeTruthy();
});

it("shows the workflow default throughout a cold open with Plaud preferred", async () => {
    let sendProjection!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
        sendProjection = resolve;
    });
    server((url) => (url.includes("processing=1") ? pending : undefined));
    render(<WorkstationDetailPane {...props} />);
    expect(screen.getByText("riffado transcript 1")).toBeTruthy();
    await act(async () =>
        sendProjection(Response.json({ processing: projection() })),
    );
    expect(screen.getByText("riffado transcript 1")).toBeTruthy();
});

it("keeps the unpicked tab when the workflow finishes during the visit", async () => {
    const remote = server();
    render(<WorkstationDetailPane {...props} />);
    await screen.findByLabelText("Workflow");
    expect(screen.getByText("riffado transcript 1")).toBeTruthy();
    const base = projection();
    await remote.update({
        ...base,
        phases: { categorize: categorized },
        steps: {
            ...base.steps,
            learn: {
                ...base.steps.learn,
                state: "done",
                waitingFor: null,
                actions: [],
            },
        },
    });
    expect(screen.queryByLabelText("Workflow")).toBeNull();
    expect(screen.getByText("riffado transcript 1")).toBeTruthy();
});

it("keeps the settings default when a workflow starts after the first projection", async () => {
    const base = projection();
    const remote = server(undefined, { ...base, legacy: true });
    render(<WorkstationDetailPane {...props} />);
    expect(await screen.findByText("plaud transcript 1")).toBeTruthy();
    await remote.update(base);
    expect(await screen.findByLabelText("Workflow")).toBeTruthy();
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();
});

it.each([
    false,
    true,
])("follows the first higher-ranked transcript once per visit (workflow finished %s)", async (finished) => {
    const base = projection();
    const initial = {
        ...base,
        versions: { ...base.versions, transcripts: { plaud: "plaud-1" } },
    };
    const remote = server(undefined, initial);
    const plaud = transcript("plaud");
    const custom = transcript("riffado");
    const detail = (transcripts: TranscriptOption[]) => (
        <WorkstationDetailPane {...props} transcripts={transcripts} />
    );
    const view = render(detail([plaud]));
    await screen.findByLabelText("Workflow");
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();

    const updated = { ...base, legacy: finished };
    await remote.update(updated);
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();
    view.rerender(detail([plaud, custom]));
    expect(screen.getByText("riffado transcript 1")).toBeTruthy();

    await remote.update({ ...updated, versions: initial.versions });
    view.rerender(detail([plaud]));
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();
    await remote.update(updated);
    view.rerender(detail([plaud, custom]));
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();
});

it("keeps the picked Plaud tab when Custom disappears and returns during a workflow", async () => {
    const base = projection();
    const remote = server(undefined, base);
    const view = render(<WorkstationDetailPane {...props} />);
    await screen.findByLabelText("Workflow");
    expect(screen.getByText("riffado transcript 1")).toBeTruthy();
    fireEvent.click(screen.getByText("Plaud", { selector: "button" }));
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();

    await remote.update({
        ...base,
        versions: { ...base.versions, transcripts: { plaud: "plaud-1" } },
    });
    view.rerender(
        <WorkstationDetailPane
            {...props}
            transcripts={[transcript("plaud")]}
        />,
    );
    await remote.update(base);
    view.rerender(<WorkstationDetailPane {...props} />);
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();
});

it("keeps the Plaud setting when Custom arrives without a workflow", async () => {
    const base = { ...projection(), legacy: true };
    const remote = server(undefined, {
        ...base,
        versions: { ...base.versions, transcripts: { plaud: "plaud-1" } },
    });
    const view = render(
        <WorkstationDetailPane
            {...props}
            transcripts={[transcript("plaud")]}
        />,
    );
    await act(async () => {});
    expect(screen.queryByLabelText("Workflow")).toBeNull();
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();

    await remote.update(base);
    view.rerender(<WorkstationDetailPane {...props} />);
    expect(screen.queryByLabelText("Workflow")).toBeNull();
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();
});

it("switches to the transcript targeted by a workflow review", async () => {
    server();
    render(<WorkstationDetailPane {...props} />);
    const workflow = within(await screen.findByLabelText("Workflow"));
    fireEvent.click(screen.getByText("Plaud", { selector: "button" }));
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();
    fireEvent.click(workflow.getByRole("button", { name: /review/i }));
    expect(screen.getByText("riffado transcript 1")).toBeTruthy();
});

it("opens the Plaud Learn review while Custom is the preferred transcript", async () => {
    const base = projection();
    server(
        (url) =>
            url.includes("/review?source=plaud")
                ? Response.json(review("Plaud proposal"))
                : undefined,
        {
            ...base,
            phases: {
                ...base.phases,
                learn: {
                    ...reviewPhase,
                    inputs: {
                        contentId: "plaud",
                        contentRevision: 1,
                        contentSourceId: "plaud",
                    },
                },
            },
        },
    );
    render(<WorkstationDetailPane {...props} />);
    const workflow = within(await screen.findByLabelText("Workflow"));
    expect(screen.getByText("riffado transcript 1")).toBeTruthy();
    fireEvent.click(workflow.getByRole("button", { name: /review/i }));
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();
    expect(await screen.findByText(/Plaud proposal/)).toBeTruthy();
});

it("refreshes once for a newer title and renders the title from RSC props", async () => {
    const base = projection();
    const remote = server();
    const refresh = vi.fn();
    const row = { ...item, titleVersion: "title-1" };
    const renderRow = (recording: Recording) => (
        <WorkstationDetailPane
            {...props}
            currentRecording={recording}
            onTranscriptStale={refresh}
        />
    );
    const view = render(renderRow(row));
    await screen.findByLabelText("Workflow");
    expect(refresh).not.toHaveBeenCalled();
    const newer = {
        ...base,
        versions: { ...base.versions, title: "title-2", item: "item-2" },
    };
    await remote.update(newer);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(item.filename)).toBeTruthy();
    await remote.update(newer);
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender(
        renderRow({
            ...row,
            titleVersion: "title-2",
            filename: "Updated title",
        }),
    );
    expect(screen.getByText("Updated title")).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
});

it("keeps a picked tab and the card instance through a first summary, revision signal and row swap", async () => {
    server();
    const view = render(<WorkstationDetailPane {...props} />);
    await screen.findByLabelText("Workflow");
    fireEvent.click(screen.getByText("Plaud", { selector: "button" }));
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();
    view.rerender(
        <WorkstationDetailPane
            {...props}
            currentRecording={{ ...item, hasSummary: true }}
            organizationEventRevision={1}
        />,
    );
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();
    view.rerender(
        <WorkstationDetailPane
            {...props}
            currentRecording={{ ...item, hasSummary: true, view: "org" }}
            organizationEventRevision={1}
        />,
    );
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();
    expect(mounts.transcript).toHaveBeenCalledTimes(1);
    expect(mounts.player).toHaveBeenCalledTimes(1);
});

it("starts from the workflow default when the same recording is reopened", async () => {
    const remote = server();
    const view = render(<WorkstationDetailPane {...props} />);
    await screen.findByLabelText("Workflow");
    fireEvent.click(screen.getByText("Plaud", { selector: "button" }));
    expect(screen.getByText("plaud transcript 1")).toBeTruthy();
    const other = { ...item, id: "other-item", filename: "Other recording" };
    remote.set({ ...projection(), itemId: other.id });
    view.rerender(
        <WorkstationDetailPane {...props} currentRecording={other} />,
    );
    await screen.findByText(other.filename);
    remote.set(projection());
    view.rerender(<WorkstationDetailPane {...props} />);
    expect(await screen.findByText("riffado transcript 1")).toBeTruthy();
    expect(mounts.player).toHaveBeenCalledTimes(1);
});

it("replaces a private topic read on an Organization row swap", async () => {
    const privateTopic = { title: "Private topic", fromMs: 0, toMs: 4_000 };
    const orgTopic = { ...privateTopic, title: "Organization topic" };
    const remote = server((url) =>
        url.includes("/topics?")
            ? Response.json({
                  topics: [url.includes("view=org") ? orgTopic : privateTopic],
              })
            : undefined,
    );
    const options = {
        ...props,
        transcripts: [{ ...transcript("riffado"), topics: [privateTopic] }],
    };
    const rendered = render(<WorkstationDetailPane {...options} />);
    expect(await screen.findAllByText(privateTopic.title)).toHaveLength(2);
    const base = projection();
    remote.set({
        ...base,
        access: { ...base.access, shared: true, contentView: "org" },
    });
    rendered.rerender(
        <WorkstationDetailPane
            {...options}
            currentRecording={{ ...item, view: "org" }}
        />,
    );
    await waitFor(() =>
        expect(screen.getAllByText(orgTopic.title)).toHaveLength(2),
    );
    expect(screen.queryByText(privateTopic.title)).toBeNull();
});

function review(id?: string) {
    return {
        run: id ? { id, status: "ready" } : null,
        available: true,
        names: {},
        types: {},
        relations: {},
        items: id
            ? [
                  {
                      id,
                      kind: "correction",
                      preTicked: true,
                      decision: null,
                      choice: null,
                      version: 0,
                      dependsOnLabel: null,
                      payload: {
                          kind: "correct",
                          heard: id,
                          replacement: "Roadmap",
                          anchors: [{ turnIndex: 0, charStart: 0, charEnd: 3 }],
                      },
                  },
              ]
            : [],
    };
}

it("holds Learn while the RSC transcript is behind, then reads the new run as soon as it appears", async () => {
    let answer = review("old proposal");
    const refresh = vi.fn();
    const base = projection();
    const initial = {
        ...base,
        versions: { ...base.versions, transcripts: { riffado: "riffado-1" } },
    };
    const remote = server(
        (url) => (url.includes("/review?") ? Response.json(answer) : undefined),
        initial,
    );
    const views = {
        ...props,
        transcripts: [transcript("riffado")],
        onTranscriptStale: refresh,
    };
    const row = { ...item, titleVersion: "title-1" };
    const rendered = render(
        <WorkstationDetailPane {...views} currentRecording={row} />,
    );
    await waitFor(() =>
        expect(
            remote.fetch.mock.calls.some(([url]) => url.includes("/review?")),
        ).toBe(true),
    );
    act(() => openWidget(`recording-learn-review-${item.id}`, "riffado"));
    expect(await screen.findByText(/old proposal/)).toBeTruthy();

    const rewritten = {
        ...initial,
        versions: {
            ...initial.versions,
            item: "item-2",
            transcripts: { riffado: "riffado-2" },
            learn: {},
        },
    };
    answer = review();
    await remote.update(rewritten);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/old proposal/)).toBeTruthy();
    await remote.update(rewritten);
    expect(refresh).toHaveBeenCalledTimes(1);

    rendered.rerender(
        <WorkstationDetailPane
            {...views}
            currentRecording={row}
            transcripts={[transcript("riffado", 2)]}
        />,
    );
    expect(screen.queryByText(/old proposal/)).toBeNull();
    answer = review("new proposal");
    await remote.update({
        ...rewritten,
        versions: {
            ...rewritten.versions,
            item: "item-3",
            learn: { riffado: "run-2" },
        },
    });
    expect(await screen.findByText(/new proposal/)).toBeTruthy();
    expect(screen.queryByText(/old proposal/)).toBeNull();
});

it("releases panel reads immediately when the projected transcript was deleted", async () => {
    vi.useFakeTimers();
    let answer = review("old proposal");
    const refresh = vi.fn();
    const remote = server((url) =>
        url.includes("/review?") ? Response.json(answer) : undefined,
    );
    render(
        <WorkstationDetailPane
            {...props}
            currentRecording={{ ...item, titleVersion: "title-1" }}
            onTranscriptStale={refresh}
        />,
    );
    await act(async () => {});
    act(() => openWidget(`recording-learn-review-${item.id}`, "riffado"));
    expect(screen.getByText(/old proposal/)).toBeTruthy();
    answer = review();
    const base = projection();
    await remote.update({
        ...base,
        versions: {
            ...base.versions,
            item: "deleted",
            transcripts: { plaud: "plaud-1" },
            learn: {},
        },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/old proposal/)).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(refresh).toHaveBeenCalledTimes(1);
});

it("retries a missing RSC refresh once, releases reads, and handles a later version", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const remote = server((url) =>
        url.includes("/review?") ? Response.json(review()) : undefined,
    );
    render(
        <WorkstationDetailPane
            {...props}
            currentRecording={{ ...item, titleVersion: "title-1" }}
            onTranscriptStale={refresh}
        />,
    );
    await act(async () => {});
    const reads = () =>
        remote.fetch.mock.calls.filter(([url]) =>
            url.includes("/review?source=riffado"),
        ).length;
    const base = projection();
    let previousReads = reads();
    for (const revision of [2, 3]) {
        await remote.update({
            ...base,
            versions: {
                ...base.versions,
                item: `item-${revision}`,
                transcripts: {
                    plaud: "plaud-1",
                    riffado: `riffado-${revision}`,
                },
                learn: { riffado: `run-${revision}` },
            },
        });
        expect(refresh).toHaveBeenCalledTimes(2 * revision - 3);
        await act(async () => vi.advanceTimersByTimeAsync(9_999));
        expect(reads()).toBe(previousReads);
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(refresh).toHaveBeenCalledTimes(2 * revision - 2);
        expect(reads()).toBe(++previousReads);
    }
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(refresh).toHaveBeenCalledTimes(4);
});

it("dedupes a speaker revision mismatch with the later processing projection", async () => {
    const base = projection();
    const newer = {
        ...base,
        versions: {
            ...base.versions,
            item: "item-2",
            transcripts: { ...base.versions.transcripts, riffado: "riffado-2" },
        },
    };
    const refresh = vi.fn();
    const remote = server((url) => {
        if (url.includes("/speakers?source=riffado")) {
            remote.set(newer);
            return Response.json({
                transcriptionId: "riffado",
                revision: 2,
                speakers: [],
            });
        }
    });
    render(
        <WorkstationDetailPane
            {...props}
            currentRecording={{ ...item, titleVersion: "title-1" }}
            onTranscriptStale={refresh}
        />,
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await remote.update(newer);
    expect(refresh).toHaveBeenCalledTimes(1);
});

it("waits for a Learn draft before applying a version-triggered reload", async () => {
    const original = review("Road map");
    let answer = original;
    let finishDraft: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
        finishDraft = resolve;
    });
    const remote = server((url, init) => {
        if (url.includes("/review/items/") && init?.method === "PATCH")
            return pending;
        if (url.includes("/review?")) return Response.json(answer);
    });
    render(
        <WorkstationDetailPane
            {...props}
            transcripts={[transcript("riffado")]}
        />,
    );
    await screen.findByLabelText("Workflow");
    act(() => openWidget(`recording-learn-review-${item.id}`, "riffado"));
    const checkbox = await screen.findByRole<HTMLInputElement>("checkbox", {
        name: "Correct Road map",
    });
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    await waitFor(() =>
        expect(
            remote.fetch.mock.calls.some(([url]) =>
                url.includes("/review/items/"),
            ),
        ).toBe(true),
    );

    const reads = () =>
        remote.fetch.mock.calls.filter(([url]) => url.includes("/review?"))
            .length;
    const before = reads();
    const base = projection();
    await remote.update({
        ...base,
        versions: { ...base.versions, learn: { riffado: "run-updated" } },
    });
    expect(reads()).toBe(before);
    answer = {
        ...original,
        items: original.items.map((proposal) => ({
            ...proposal,
            preTicked: false,
            version: 1,
        })),
    };
    await act(async () => finishDraft?.(Response.json({ version: 1 })));
    expect(reads()).toBe(before + 1);
    expect(checkbox.checked).toBe(false);
});

it("refetches speaker names and language on their versions and retains them on errors", async () => {
    let name = "Jitka Dvořáková";
    let language = "cs";
    let fail = false;
    const remote = server((url) => {
        if (url.includes("/speakers?"))
            return fail
                ? new Response(null, { status: 500 })
                : Response.json({
                      speakers: [
                          {
                              label: "speaker_0",
                              personId: "person",
                              personName: name,
                              status: "confirmed",
                          },
                      ],
                  });
        if (url.endsWith("/language"))
            return fail
                ? new Response(null, { status: 500 })
                : Response.json({
                      confirmedLanguage: language,
                      canChange: true,
                  });
    });
    render(
        <WorkstationDetailPane
            {...props}
            transcripts={[transcript("riffado")]}
        />,
    );
    expect(await screen.findByText(name)).toBeTruthy();
    expect(await screen.findByText("Czech")).toBeTruthy();
    const next = (n: number) => {
        const base = projection();
        return {
            ...base,
            versions: {
                ...base.versions,
                item: `item-${n}`,
                speakers: { riffado: `speakers-${n}` },
                language: `language-${n}`,
            },
        };
    };
    name = "Eva Nováková";
    language = "de";
    await remote.update(next(2));
    expect(await screen.findByText(name)).toBeTruthy();
    expect(await screen.findByText("German")).toBeTruthy();
    const count = (part: string) =>
        remote.fetch.mock.calls.filter(([url]) => url.includes(part)).length;
    const before = [count("/speakers?"), count("/language")];
    fail = true;
    await remote.update(next(3));
    expect([count("/speakers?"), count("/language")]).toEqual(
        before.map((n) => n + 1),
    );
    expect(screen.getByText(name)).toBeTruthy();
    expect(screen.getByText("German")).toBeTruthy();
});

it("keeps summary speaker names when the same source is read independently of the tab", async () => {
    let name = "Jitka Dvořáková";
    let fail = false;
    const base = projection();
    const initial = { ...base, outputs: { ...base.outputs, summary: true } };
    const remote = server((url) => {
        if (url.includes("/summary?source=riffado"))
            return Response.json({
                summary: "### Attendees\n\n- Speaker 0 — leads the meeting",
                source: "riffado",
            });
        if (url.includes("/speakers?source=riffado"))
            return fail
                ? new Response(null, { status: 500 })
                : Response.json({
                      speakers: [
                          {
                              label: "speaker_0",
                              personId: "person",
                              personName: name,
                              status: "confirmed",
                          },
                      ],
                  });
    }, initial);
    render(
        <WorkstationDetailPane
            {...props}
            itemLinkQuery={`recording=${item.id}&widget=summary`}
        />,
    );
    const summaryLine = await screen.findByText(/leads the meeting/);
    await waitFor(() => expect(summaryLine.textContent).toContain(name));
    fail = true;
    fireEvent.click(
        within(
            screen.getByLabelText("Transcript source", {
                selector: "fieldset",
            }),
        ).getByText("Plaud"),
    );
    expect(screen.getByText(/leads the meeting/).textContent).toContain(name);
    name = "Eva Nováková";
    fail = false;
    await remote.update({
        ...initial,
        versions: { ...base.versions, speakers: { riffado: "speakers-2" } },
    });
    await waitFor(() =>
        expect(screen.getByText(/leads the meeting/).textContent).toContain(
            name,
        ),
    );
});

it("refetches task review on its version and keeps the data on an error", async () => {
    let changed = false;
    let fail = false;
    const remote = server((url) =>
        url.endsWith("/tasks")
            ? fail
                ? new Response(null, { status: 500 })
                : Response.json({
                      tasks: [],
                      proposals: [],
                      updates: [],
                      matches: [],
                      taskReviewChanged: changed,
                  })
            : undefined,
    );
    const { result } = renderHook(() => useRecordingTasks(item.id, 0), {
        wrapper: ({ children }) => (
            <NextIntlClientProvider locale="en" timeZone="UTC">
                <ItemDetailProvider itemId={item.id} kind="audio" isOwn>
                    {children}
                </ItemDetailProvider>
            </NextIntlClientProvider>
        ),
    });
    await waitFor(() =>
        expect(result.current.data?.taskReviewChanged).toBe(false),
    );
    const base = projection();
    changed = true;
    await remote.update({
        ...base,
        versions: { ...base.versions, tasks: "tasks-2" },
    });
    expect(result.current.data?.taskReviewChanged).toBe(true);
    fail = true;
    await remote.update({
        ...base,
        versions: { ...base.versions, tasks: "tasks-3" },
    });
    expect(result.current.failed).toBe(true);
    expect(result.current.data?.taskReviewChanged).toBe(true);
});

it.each([
    false,
    true,
])("moves the workflow strip within five seconds of filing (stale write projection %s)", async (stale) => {
    vi.useFakeTimers();
    const base = projection();
    const {
        steps: _steps,
        nextCheckAt: _at,
        nextCheckInMs: _delay,
        ...input
    } = base;
    const pending = projectProcessing(input, [], {
        advancePending: true,
        canFile: true,
        canChange: true,
    });
    const advanced = {
        ...base,
        steps: {
            ...base.steps,
            learn: {
                ...base.steps.learn,
                state: "running" as const,
                waitingFor: null,
            },
        },
    };
    const folder: RecordingFolder = {
        id: "file-here",
        parentId: null,
        name: "Notes",
        kind: "custom",
        scope: "personal",
        sortOrder: 0,
        version: 1,
    };
    const queue = new ItemOperationQueue(item.id);
    const remote = server((url, request) => {
        if (url.endsWith("/folders") && request?.method === "POST") {
            remote.set({
                ...pending,
                versions: base.versions,
                access: base.access,
            });
            return Response.json(
                stale
                    ? { placement: "filed", processingStale: true }
                    : { placement: "filed", processing: pending },
            );
        }
    });
    render(
        <WorkstationDetailPane
            {...props}
            folders={[folder]}
            operationQueue={queue}
            onAddToFolder={async (id, folderId) => {
                await queue.enqueueOperation({
                    write: async () =>
                        itemOperationResult(
                            await fetch(`/api/recordings/${id}/folders`, {
                                method: "POST",
                                body: JSON.stringify({ folderId }),
                            }),
                        ),
                });
            }}
        />,
    );
    await act(async () => {});
    const workflow = () => within(screen.getByLabelText("Workflow"));
    const original = workflow().getByRole("button", { name: /review/i });
    fireEvent.click(screen.getByRole("combobox", { name: "Add to folder" }));
    fireEvent.click(screen.getByRole("option", { name: "Notes" }));
    await act(async () => {});
    expect(remote.fetch).toHaveBeenCalledWith(
        `/api/recordings/${item.id}/folders`,
        expect.objectContaining({ method: "POST" }),
    );
    expect(workflow().getByRole("button", { name: /review/i })).toBe(original);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    remote.set(advanced);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(workflow().queryByRole("button", { name: /review/i })).toBeNull();
});
