// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orgEventEffect } from "@/components/dashboard/org-event-effect";
import {
    acceptTaskReview,
    addRecordingTask,
    changeTask,
    fetchRecordingTasks,
    mergeProposalIntoTarget,
    mergeTaskIntoTarget,
    mergeTaskProposals,
    setTaskFollow,
    tickTaskUpdate,
    undoTaskMatch,
} from "@/components/tasks/task-api";
import { useRecordingTasks } from "@/components/tasks/use-recording-tasks";
import { EVENT_ORIGIN_HEADER, readEventOrigin } from "@/lib/events/origin";
import { tabEventOrigin } from "@/lib/events/tab-origin";
import type { RecordingTasks, TaskView } from "@/lib/tasks/tasks";

vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const task: TaskView = {
    id: "task-echo",
    recordingId: "recording-echo",
    evidenceItemId: "recording-echo",
    evidenceItemKind: "audio",
    status: "open",
    text: "Send the draft",
    assignee: null,
    assigneeHasEmail: false,
    assigneeHint: null,
    assigneeCheck: false,
    dueDate: null,
    duePhrase: null,
    quote: null,
    evidenceStartMs: null,
    evidenceAudioAvailable: true,
    evidenceText: null,
    evidenceProvenance: null,
    source: "riffado",
    ticked: true,
    version: 1,
    createdAt: "2026-10-01T10:00:00Z",
    acceptedAt: "2026-10-01T10:00:00Z",
    statusChangedAt: null,
    canEdit: false,
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

function tasks(row = task): RecordingTasks {
    return {
        canEdit: true,
        reviewed: true,
        tasks: [row],
        proposals: [],
        updates: [],
        matches: [],
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("task tick Organization echo", () => {
    it.each([
        "private",
        "org",
    ] as const)("labels a tick before its response and ignores its echo in %s", async (view) => {
        const saved = deferred<Response>();
        let origin: string | null = null;
        const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === "PATCH") {
                origin = new Headers(init.headers).get(EVENT_ORIGIN_HEADER);
                return saved.promise;
            }
            return Response.json(tasks());
        });
        vi.stubGlobal("fetch", fetch);
        const { result } = renderHook(() =>
            useRecordingTasks("recording-echo", 0),
        );
        await waitFor(() => expect(result.current.data?.tasks).toHaveLength(1));
        act(() =>
            result.current.update(task, { status: "done" }, { status: "done" }),
        );
        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        expect(origin).toBe(tabEventOrigin());
        expect(result.current.data?.tasks[0].status).toBe("done");
        expect(
            orgEventEffect(
                {
                    type: "recording",
                    recordingId: "recording-echo",
                    origin: origin ?? undefined,
                },
                { id: "recording-echo", view },
                new Set(["recording-echo"]),
                tabEventOrigin(),
            ),
        ).toEqual({ refresh: false, refetchContent: false });
        await act(async () =>
            saved.resolve(
                Response.json({ ...task, status: "done", version: 2 }),
            ),
        );
    });

    it("keeps other origins, unlabelled writes and tree changes live without a time window", () => {
        const current = { id: "recording-echo", view: "org" as const };
        const library = new Set(["recording-echo", "recording-other"]);
        for (const origin of ["other-tab", undefined]) {
            expect(
                orgEventEffect(
                    { type: "recording", recordingId: current.id, origin },
                    current,
                    library,
                    tabEventOrigin(),
                ),
            ).toEqual({ refresh: true, refetchContent: true });
        }
        expect(
            orgEventEffect(
                { type: "recording", recordingId: "recording-other" },
                current,
                library,
                tabEventOrigin(),
            ),
        ).toEqual({ refresh: true, refetchContent: false });
        expect(
            orgEventEffect(
                { type: "tree" },
                current,
                library,
                tabEventOrigin(),
            ),
        ).toEqual({ refresh: true, refetchContent: false });
        expect(
            orgEventEffect(
                { type: "recording", recordingId: "invisible" },
                current,
                library,
                tabEventOrigin(),
            ),
        ).toEqual({ refresh: false, refetchContent: false });
    });
});

describe("task request origins", () => {
    it("labels every task mutation with one page-load id and leaves reads unlabelled", async () => {
        const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
            Response.json({ accepted: 0 }),
        );
        vi.stubGlobal("fetch", fetch);
        await fetchRecordingTasks("recording-echo");
        expect(
            new Headers(fetch.mock.calls[0]?.[1]?.headers).has(
                EVENT_ORIGIN_HEADER,
            ),
        ).toBe(false);
        const writes = [
            () => changeTask("task", { status: "done", version: 1 }),
            () =>
                addRecordingTask("recording-echo", {
                    text: "Task",
                    status: "open",
                }),
            () => mergeTaskProposals("recording-echo", ["one", "two"]),
            () =>
                acceptTaskReview("recording-echo", {
                    proposals: [],
                    updates: [],
                    matches: [],
                }),
            () => tickTaskUpdate("recording-echo", "update", true, 1),
            () => mergeTaskIntoTarget("one", "two"),
            () => mergeProposalIntoTarget("recording-echo", "one", "two"),
            () => undoTaskMatch("recording-echo", "task"),
            () => setTaskFollow("task", true),
        ];
        for (const write of writes) {
            await write();
            expect(
                new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get(
                    EVENT_ORIGIN_HEADER,
                ),
            ).toBe(tabEventOrigin());
        }
    });

    it("accepts only bounded optional event labels", () => {
        for (const value of ["", "a".repeat(65), "bad origin", "bad/origin"]) {
            expect(
                readEventOrigin(new Headers({ [EVENT_ORIGIN_HEADER]: value })),
            ).toBeUndefined();
        }
        expect(readEventOrigin(new Headers())).toBeUndefined();
        expect(
            readEventOrigin(
                new Headers({ [EVENT_ORIGIN_HEADER]: tabEventOrigin() }),
            ),
        ).toBe(tabEventOrigin());
    });
});
