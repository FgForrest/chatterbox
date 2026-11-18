// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    renderHook,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderTasksPanel } from "@/components/tasks/folder-tasks-panel";
import { TaskList } from "@/components/tasks/task-list";
import { useTaskListData } from "@/hooks/use-task-list-data";
import { tabEventOrigin } from "@/lib/events/tab-origin";
import type { OrgClientEvent } from "@/lib/events/types";
import {
    createTaskListState,
    type TaskListPatch,
    taskListReducer,
    taskListView,
} from "@/lib/tasks/list-state";
import type { TaskListItem } from "@/lib/tasks/tasks";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";

const recording = {
    id: "shared-recording",
    title: "Planning",
    view: "org",
    kind: "audio",
    startTime: "2026-10-28T10:00:00Z",
} as const;
const folder: RecordingFolder = {
    id: "projects",
    parentId: null,
    name: "Projects",
    kind: "custom",
    scope: "org",
    sortOrder: 0,
    version: 0,
};
const task: TaskListItem = {
    id: "send-draft",
    text: "Send the draft",
    recordingId: recording.id,
    evidenceItemId: recording.id,
    evidenceItemKind: "audio",
    evidenceAudioAvailable: true,
    status: "open",
    assignee: null,
    assigneeHasEmail: false,
    assigneeHint: null,
    assigneeCheck: false,
    dueDate: null,
    duePhrase: null,
    quote: null,
    evidenceStartMs: null,
    evidenceText: null,
    evidenceProvenance: null,
    source: "manual",
    own: false,
    note: null,
    noteBy: null,
    noteUpdatedAt: null,
    following: false,
    automaticFollow: false,
    canFollow: false,
    canMerge: false,
    canEdit: false,
    canClose: true,
    canUndoMatch: false,
    ticked: true,
    version: 1,
    createdAt: recording.startTime,
    acceptedAt: null,
    statusChangedAt: null,
    recording,
    evidence: null,
    visibleMentionQuotes: [],
};
const before = { ...task, id: "before", text: "Check the outline" };
const after = { ...task, id: "after", text: "Book the review" };
const saved = { ...task, status: "done", version: 2 } as const;

const { navigation, orgEvent, translate } = vi.hoisted(() => ({
    navigation: { params: new URLSearchParams(), replace: vi.fn() },
    orgEvent: {
        current: undefined as ((event: OrgClientEvent) => void) | undefined,
    },
    translate: (
        text: string | { message: string },
        values?: { count?: number },
    ) => {
        const message = typeof text === "string" ? text : text.message;
        return values?.count === undefined ? message : `${values.count} open`;
    },
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: navigation.replace }),
    usePathname: () => "/tasks",
    useSearchParams: () => navigation.params,
}));
vi.mock("@/components/tasks/routed-proposals-inbox", () => ({
    RoutedProposalsInbox: () => null,
}));
vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => "en",
    useFormatter: () => ({ dateTime: () => "" }),
}));
vi.mock("@/hooks/use-org-events", () => ({
    useOrgEvents: (
        enabled: boolean,
        callback: (event: OrgClientEvent) => void,
    ) => {
        if (enabled) orgEvent.current = callback;
    },
}));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function panel(assignments: RecordingFolderAssignment[], folders = [folder]) {
    return (
        <FolderTasksPanel
            folder={folder}
            organization={{ folders, assignments }}
            isOrgAccount
            onBack={vi.fn()}
        />
    );
}

const assignments = [{ recordingId: recording.id, folderId: folder.id }];

describe.each([
    { surface: "folder panel", inFolder: true },
    { surface: "Tasks page", inFolder: false },
])("$surface", ({ inFolder }) => {
    it("keeps the completed row and note draft across own-origin events, foreign refreshes and revisions until the filter changes", async () => {
        Element.prototype.scrollIntoView = vi.fn();
        navigation.params = new URLSearchParams("tab=all");
        navigation.replace.mockReset();
        let rows = [before, task, after];
        const revisionResponse = Promise.withResolvers<Response>();
        let revising = false;
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            if (init?.method === "PATCH") {
                rows = [before, after];
                return Response.json(saved);
            }
            if (url.startsWith("/api/tasks?")) {
                const state = new URL(url, "http://localhost").searchParams.get(
                    "state",
                );
                if (revising && state === "open")
                    return revisionResponse.promise;
                return Response.json({ tasks: state === "open" ? rows : [] });
            }
            return Response.json({ assignees: [], folders: [] });
        });
        vi.stubGlobal("fetch", fetchMock);
        const freshPage = () => <TaskList organization />;
        const view = render(inFolder ? panel(assignments) : freshPage());
        const taskText = await screen.findByText(task.text);
        const list = taskText.closest("ul");
        const rowOrder = () =>
            Array.from(list?.children ?? [], (row) =>
                [before.text, task.text, after.text].find((label) =>
                    row.textContent?.includes(label),
                ),
            ).filter(Boolean);
        if (inFolder) expect(screen.getByText("3 open")).toBeTruthy();
        await act(async () =>
            fireEvent.click(
                screen.getAllByRole("checkbox", { name: "Done" })[1],
            ),
        );
        const note = screen.getByRole("textbox", {
            name: "Note",
        }) as HTMLTextAreaElement;
        fireEvent.change(note, { target: { value: "A draft to finish" } });
        const expectDraft = () => {
            expect(screen.getByRole("textbox", { name: "Note" })).toBe(note);
            expect(note.value).toBe("A draft to finish");
        };
        if (inFolder) expect(screen.getByText("2 open")).toBeTruthy();
        fetchMock.mockClear();

        await act(async () =>
            orgEvent.current?.({
                type: "recording",
                recordingId: recording.id,
                origin: tabEventOrigin(),
            }),
        );
        expect(fetchMock).not.toHaveBeenCalled();
        expectDraft();

        await act(async () =>
            orgEvent.current?.({
                type: "recording",
                recordingId: recording.id,
                origin: "other-tab",
            }),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("state=open"),
        );
        expect(
            screen.getByText(task.text).classList.contains("line-through"),
        ).toBe(true);
        expectDraft();
        expect(rowOrder()).toEqual([before.text, task.text, after.text]);
        if (inFolder) expect(screen.getByText("2 open")).toBeTruthy();

        revising = true;
        fetchMock.mockClear();
        if (inFolder) {
            await act(async () =>
                view.rerender(
                    panel([
                        ...assignments,
                        {
                            recordingId: "another-recording",
                            folderId: folder.id,
                        },
                    ]),
                ),
            );
        } else {
            act(() => orgEvent.current?.({ type: "tree" }));
        }
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("state=open"),
        );
        expect(screen.queryByText("Loading tasks…")).toBeNull();
        expectDraft();

        const fresh = { ...task, text: "Send the revised draft", version: 3 };
        rows = [before, after, fresh];
        await act(async () =>
            revisionResponse.resolve(Response.json({ tasks: rows })),
        );
        revising = false;
        expect(
            screen.getByText(fresh.text).classList.contains("line-through"),
        ).toBe(false);
        expectDraft();
        if (inFolder) expect(screen.getByText("3 open")).toBeTruthy();

        fireEvent.keyDown(screen.getByRole("combobox", { name: "State" }), {
            key: "ArrowDown",
        });
        fireEvent.click(await screen.findByRole("option", { name: "Dropped" }));
        if (!inFolder) {
            expect(navigation.replace).toHaveBeenCalledWith(
                "/tasks?tab=all&state=dropped",
                { scroll: false },
            );
            navigation.params.set("state", "dropped");
            view.rerender(freshPage());
        }
        await screen.findByText(
            inFolder ? "No tasks in this folder" : "Nothing here.",
        );
        expect(screen.queryByText(fresh.text)).toBeNull();
        expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    });
});

it("keeps a retained row in its original folder group when its recording moves", async () => {
    const first = {
        ...folder,
        id: "first",
        parentId: folder.id,
        name: "First",
    };
    const second = { ...first, id: "second", name: "Second" };
    const folders = [folder, first, second];
    let row: TaskListItem = task;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            if (init?.method === "PATCH") {
                row = saved;
                return Response.json(saved);
            }
            if (url.startsWith("/api/tasks?"))
                return Response.json({ tasks: [row] });
            return Response.json({ assignees: [], folders: [] });
        }),
    );
    const placement = (folderId: string) =>
        panel([{ recordingId: recording.id, folderId }], folders);
    const view = render(placement(first.id));
    await screen.findByText(task.text);
    await act(async () =>
        fireEvent.click(screen.getByRole("checkbox", { name: "Done" })),
    );
    const note = screen.getByRole("textbox", {
        name: "Note",
    }) as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "Notes on the move" } });
    await act(async () => view.rerender(placement(second.id)));
    expect(screen.getByRole("textbox", { name: "Note" })).toBe(note);
    expect(note.value).toBe("Notes on the move");
    expect(
        note.closest("ul")?.parentElement?.querySelector("h3")?.textContent,
    ).toContain("First");
});

it("counts a reopened row immediately and clears its retention after a failed save", async () => {
    const reopening = Promise.withResolvers<Response>();
    const reopened = { ...task, version: 3 };
    let closed: TaskListItem[] = [saved];
    let open = [before, after];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
            return init.body === JSON.stringify({ status: "open", version: 2 })
                ? reopening.promise
                : new Response(null, { status: 409 });
        }
        if (url.startsWith("/api/tasks?")) {
            const state = new URL(url, "http://localhost").searchParams.get(
                "state",
            );
            return Response.json({ tasks: state === "done" ? closed : open });
        }
        return Response.json({ assignees: [], folders: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
        useTaskListData({
            tab: "all",
            state: "done",
            folder: folder.id,
            initialFolders: [folder],
            countOpen: true,
        }),
    );
    await waitFor(() => expect(result.current.openCount).toBe(2));
    act(() =>
        result.current.update(saved, { status: "open" }, { status: "open" }),
    );
    expect(result.current.openCount).toBe(3);
    closed = [];
    open = [before, reopened, after];
    await act(async () => reopening.resolve(Response.json(reopened)));
    await act(async () => {
        await result.current.reload();
    });
    expect(result.current.tasks).toEqual([reopened]);
    expect(result.current.openCount).toBe(3);

    await act(async () =>
        result.current.update(
            reopened,
            { status: "dropped" },
            { status: "dropped" },
        ),
    );
    expect(result.current.tasks).toEqual([]);
    expect(result.current.openCount).toBe(3);
});

it("rolls back a failed PATCH and its open count before a failing recovery GET", async () => {
    const patch = Promise.withResolvers<Response>();
    const recovery = Promise.withResolvers<Response>();
    let recovering = false;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            if (init?.method === "PATCH") return patch.promise;
            if (url.startsWith("/api/tasks?"))
                return recovering
                    ? recovery.promise
                    : Response.json({ tasks: [task] });
            return Response.json({ assignees: [], folders: [] });
        }),
    );
    const { result } = renderHook(() =>
        useTaskListData({ tab: "all", state: "open", countOpen: true }),
    );
    await waitFor(() => expect(result.current.openCount).toBe(1));
    act(() =>
        result.current.update(task, { status: "done" }, { status: "done" }),
    );
    expect(result.current.openCount).toBe(0);
    recovering = true;
    await act(async () => patch.resolve(new Response(null, { status: 500 })));
    expect.soft(result.current.tasks).toEqual([task]);
    expect.soft(result.current.openCount).toBe(1);
    await act(async () =>
        recovery.resolve(new Response(null, { status: 500 })),
    );
    expect(result.current.error).toBe(true);
    expect(result.current.tasks).toEqual([task]);
    expect(result.current.openCount).toBe(1);
});

it("reapplies the second pending status when a reload sees the first save", async () => {
    const firstPatch = Promise.withResolvers<Response>();
    const secondPatch = Promise.withResolvers<Response>();
    const reopened = { ...task, version: 3 };
    let row: TaskListItem = task;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
            return init.body === JSON.stringify({ status: "done", version: 1 })
                ? firstPatch.promise
                : secondPatch.promise;
        }
        if (url.startsWith("/api/tasks?"))
            return Response.json({ tasks: [row] });
        return Response.json({ assignees: [], folders: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
        useTaskListData({ tab: "all", state: "all", countOpen: true }),
    );
    await waitFor(() => expect(result.current.openCount).toBe(1));
    act(() =>
        result.current.update(task, { status: "done" }, { status: "done" }),
    );
    const [completed] = result.current.tasks ?? [];
    act(() =>
        result.current.update(
            completed,
            { status: "open" },
            { status: "open" },
        ),
    );
    row = saved;
    await act(async () => firstPatch.resolve(Response.json(saved)));
    expect(fetchMock).toHaveBeenCalledWith(
        "/api/tasks/send-draft",
        expect.objectContaining({
            body: JSON.stringify({ status: "open", version: 2 }),
        }),
    );
    await act(async () => {
        await result.current.reload();
    });
    expect.soft(result.current.tasks).toEqual([{ ...saved, status: "open" }]);
    expect.soft(result.current.openCount).toBe(1);
    await act(async () => secondPatch.resolve(Response.json(reopened)));
    expect(result.current.tasks).toEqual([reopened]);
});

it("restores only the failed merge source while another edit stays confirmed", async () => {
    const merging = Promise.withResolvers<Response>();
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/merge")) return merging.promise;
            if (init?.method === "PATCH") return Response.json(saved);
            if (url.startsWith("/api/tasks?"))
                return Response.json({ tasks: [before, task, after] });
            return Response.json({ assignees: [], folders: [] });
        }),
    );
    const { result } = renderHook(() =>
        useTaskListData({ tab: "all", state: "open" }),
    );
    await waitFor(() =>
        expect(result.current.tasks).toEqual([before, task, after]),
    );
    act(() => {
        void result.current.merge(before, after.id);
    });
    await act(async () =>
        result.current.update(task, { status: "done" }, { status: "done" }),
    );
    expect(result.current.tasks).toEqual([saved, after]);
    await act(async () => merging.resolve(new Response(null, { status: 500 })));
    expect(result.current.tasks).toEqual([before, saved, after]);
    expect(result.current.openCount).toBe(2);
});

it.each([
    "open",
    "all",
])("never restores a merged insert in state %s when another insert supersedes the merge reload", async (state) => {
    const mergeReload = Promise.withResolvers<Response>();
    const merging = Promise.withResolvers<Response>();
    const inserted = { ...task, own: true };
    const second = { ...after, own: true };
    let lists = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/merge")) return merging.promise;
            if (init?.method === "PATCH")
                return Response.json({ ...saved, own: true });
            if (url.startsWith("/api/tasks?")) {
                lists++;
                if (lists === 3) return mergeReload.promise;
                return Response.json({
                    tasks: lists === 4 ? [second, before] : [before],
                });
            }
            return Response.json({ assignees: [], folders: [] });
        }),
    );
    const { result } = renderHook(() =>
        useTaskListData({ tab: "all", state, filterFolders: true }),
    );
    await waitFor(() => expect(result.current.tasks).toEqual([before]));
    const temporary = { ...inserted, id: "temporary" };
    act(() => result.current.onAdded(temporary));
    await act(async () => result.current.onReconciled(temporary.id, inserted));
    await act(async () =>
        result.current.update(inserted, { status: "done" }, { status: "done" }),
    );
    act(() => {
        void result.current.merge(inserted, before.id);
    });
    await act(async () => merging.resolve(Response.json(before)));
    expect(lists).toBe(3);

    const temporarySecond = { ...second, id: "temporary-second" };
    act(() => result.current.onAdded(temporarySecond));
    await act(async () =>
        result.current.onReconciled(temporarySecond.id, second),
    );
    expect(lists).toBe(4);
    await act(async () =>
        mergeReload.resolve(Response.json({ tasks: [before] })),
    );
    expect(result.current.tasks).toEqual([second, before]);
    expect(result.current.openCount).toBe(2);
});

describe("task list reducer", () => {
    const scope = { query: "state=open", state: "open" };
    const matchesFolder = () => true;

    it("rolls back to the freshest confirmed row after reapplying a pending patch", () => {
        const patch: TaskListPatch = { fields: { status: "done" }, retain: {} };
        const initial = taskListReducer(createTaskListState(scope), {
            type: "loaded",
            scope,
            rows: [task],
            openRows: null,
            inserts: [],
        });
        const pending = taskListReducer(initial, {
            type: "patch",
            scope,
            id: task.id,
            patch,
        });
        const fresh = { ...task, version: 2, note: "A confirmed note" };
        const refreshed = taskListReducer(pending, {
            type: "loaded",
            scope,
            rows: [fresh],
            openRows: null,
            inserts: [],
        });
        expect(taskListView(refreshed, matchesFolder).tasks).toEqual([
            { ...fresh, status: "done" },
        ]);
        const rolledBack = taskListReducer(refreshed, {
            type: "settlePatch",
            scope,
            id: task.id,
            patch,
            matchesFolder,
        });
        expect(taskListView(rolledBack, matchesFolder)).toEqual({
            tasks: [fresh],
            openCount: 1,
        });
    });

    it("ignores a former query's refresh when returning to the same filters", () => {
        const revisited = { ...scope };
        const reset = taskListReducer(createTaskListState(scope), {
            type: "reset",
            scope: revisited,
        });
        expect(
            taskListReducer(reset, {
                type: "loaded",
                scope,
                rows: [task],
                openRows: null,
                inserts: [],
            }),
        ).toBe(reset);
    });
});
