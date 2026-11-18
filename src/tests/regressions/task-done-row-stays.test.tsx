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

it("removes the private task and applies the returned Organization survivor and version", async () => {
    const own = { ...before, own: true, recording: null };
    const ownDone = { ...own, status: "done", version: 2 } as const;
    const ownReopened = { ...own, version: 3 };
    const survivor = { ...task, text: "Combined draft", version: 4 };
    const refresh = Promise.withResolvers<Response>();
    let merged = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/merge")) {
            merged = true;
            return Response.json({ ...survivor, mergeOwnerNotified: true });
        }
        if (init?.method === "PATCH" && url.endsWith(own.id)) {
            const change = JSON.parse(String(init.body)) as { status: string };
            return Response.json(
                change.status === "done" ? ownDone : ownReopened,
            );
        }
        if (init?.method === "PATCH")
            return Response.json({ ...survivor, note: "Merged", version: 5 });
        if (url.startsWith("/api/tasks?"))
            return merged ? refresh.promise : Response.json({ tasks: [task] });
        return Response.json({ assignees: [], folders: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
        useTaskListData({ tab: "all", state: "all", initialFolders: [] }),
    );
    await waitFor(() => expect(result.current.tasks).toEqual([task]));
    const temporary = { ...own, id: "temporary", version: 0 };
    act(() => {
        result.current.onAdded(temporary);
        result.current.onReconciled(temporary.id, own);
    });
    await act(async () =>
        result.current.update(own, { status: "done" }, { status: "done" }),
    );
    await act(async () =>
        result.current.update(ownDone, { status: "open" }, { status: "open" }),
    );

    let merging: ReturnType<typeof result.current.merge> | undefined;
    await act(async () => {
        merging = result.current.merge(task, own.id);
    });
    expect(result.current.tasks).toEqual([survivor]);
    await act(async () =>
        result.current.update(task, { note: "Merged" }, { note: "Merged" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
        `/api/tasks/${task.id}`,
        expect.objectContaining({
            body: JSON.stringify({ note: "Merged", version: 4 }),
        }),
    );
    await act(async () => {
        refresh.resolve(Response.json({ tasks: [survivor] }));
        await expect(merging).resolves.toEqual({ ownerNotified: true });
    });
    expect(result.current.tasks).toEqual([
        { ...survivor, note: "Merged", version: 5 },
    ]);
});

it.each([
    false,
    true,
])("sends a queued note while refreshes hang after a write with conflict=%s", async (conflict) => {
    const assignee = { personId: "person", name: "Jitka Dvořáková" };
    const first = Promise.withResolvers<Response>();
    const list = Promise.withResolvers<Response>();
    const options = Promise.withResolvers<Response>();
    const assigned = { ...task, assignee, version: 2 };
    const savedNote = { ...assigned, note: "A note", version: 3 };
    let refreshing = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
            const change = JSON.parse(String(init.body)) as { note?: string };
            return change.note ? Response.json(savedNote) : first.promise;
        }
        if (url.startsWith("/api/tasks?"))
            return refreshing ? list.promise : Response.json({ tasks: [task] });
        return refreshing ? options.promise : Response.json({ assignees: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
        useTaskListData({ tab: "all", state: "open", initialFolders: [] }),
    );
    await waitFor(() => expect(result.current.tasks).toEqual([task]));
    act(() => {
        result.current.update(
            task,
            { assigneePersonId: assignee.personId },
            { assignee },
        );
        result.current.update(task, { note: "A note" }, { note: "A note" });
    });
    refreshing = true;
    await act(async () =>
        first.resolve(
            conflict
                ? new Response(null, { status: 409 })
                : Response.json(assigned),
        ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
        `/api/tasks/${task.id}`,
        expect.objectContaining({
            body: JSON.stringify({ note: "A note", version: conflict ? 1 : 2 }),
        }),
    );
    expect(result.current.tasks).toEqual([savedNote]);
    await act(async () => {
        list.resolve(Response.json({ tasks: [savedNote] }));
        options.resolve(Response.json({ assignees: [assignee] }));
    });
});

it.each([
    false,
    true,
])("uses the latest version for a delayed assignment on a retained row with an auxiliary Open snapshot=%s", async (auxiliary) => {
    const initial = auxiliary ? saved : task;
    const changed = auxiliary
        ? { ...task, status: "open" as const, version: 3 }
        : saved;
    const fresh = { ...changed, version: 4 };
    const assignee = { personId: "person", name: "Petr Bureš" };
    let refresh = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
            const change = JSON.parse(String(init.body)) as {
                assigneePersonId?: string;
            };
            return Response.json(
                change.assigneePersonId
                    ? { ...changed, assignee, version: 5 }
                    : changed,
            );
        }
        if (url.startsWith("/api/tasks?")) {
            const isPrimary = url.includes(`state=${initial.status}`);
            return Response.json({
                tasks: refresh
                    ? auxiliary && !isPrimary
                        ? [fresh]
                        : []
                    : isPrimary
                      ? [initial]
                      : [],
            });
        }
        return Response.json({ assignees: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
        useTaskListData({
            tab: "all",
            state: initial.status,
            countOpen: true,
            initialFolders: [],
        }),
    );
    await waitFor(() => expect(result.current.tasks).toEqual([initial]));
    const delayedAssignment = result.current.update;
    await act(async () =>
        result.current.update(
            initial,
            { status: changed.status },
            { status: changed.status },
        ),
    );
    refresh = true;
    await act(async () => {
        await result.current.reload();
    });
    const latest = auxiliary ? fresh : changed;
    expect(result.current.tasks).toEqual([latest]);
    await act(async () =>
        delayedAssignment(
            initial,
            { assigneePersonId: assignee.personId },
            { assignee },
        ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
        `/api/tasks/${task.id}`,
        expect.objectContaining({
            body: JSON.stringify({
                assigneePersonId: assignee.personId,
                version: latest.version,
            }),
        }),
    );
});

it("keeps a reopened row without counting it after it leaves the folder's assignee filter", async () => {
    const assignee = { personId: "selected", name: "Adam Zelený" };
    const reassignee = { personId: "other", name: "Jitka Dvořáková" };
    const closed = { ...saved, assignee };
    const reopened = { ...task, assignee, version: 3 };
    const reassigned = { ...reopened, assignee: reassignee, version: 4 };
    let row: TaskListItem = closed;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
            row = row === closed ? reopened : reassigned;
            return Response.json(row);
        }
        if (url.startsWith("/api/tasks?"))
            return Response.json({
                tasks:
                    url.includes(`state=${row.status}`) &&
                    row.assignee === assignee
                        ? [row]
                        : [],
            });
        return Response.json({ assignees: [assignee] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
        useTaskListData({
            tab: "all",
            state: "done",
            folder: folder.id,
            initialFolders: [folder],
            assignee: assignee.personId,
            countOpen: true,
        }),
    );
    await waitFor(() => expect(result.current.tasks).toEqual([closed]));
    expect(result.current.openCount).toBe(0);
    await act(async () =>
        result.current.update(closed, { status: "open" }, { status: "open" }),
    );
    expect(result.current.openCount).toBe(1);
    await act(async () => {
        await result.current.reload();
    });
    expect(result.current.openCount).toBe(1);
    await act(async () =>
        result.current.update(
            reopened,
            { assigneePersonId: reassignee.personId },
            { assignee: reassignee },
        ),
    );
    expect(result.current.tasks).toEqual([reassigned]);
    expect(result.current.openCount).toBe(0);
});

it("keeps an added own task across same-query reloads even if the assignee filter excludes it", async () => {
    const assignee = { personId: "selected", name: "Adam Zelený" };
    const own = { ...task, own: true, recording: null };
    const temporary = { ...own, id: "temporary", version: 0 };
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
            Response.json(
                url.startsWith("/api/tasks?")
                    ? { tasks: [] }
                    : { assignees: [assignee] },
            ),
        ),
    );
    const initialProps = {
        tab: "all" as const,
        state: "open",
        assignee: assignee.personId,
        initialFolders: [],
    };
    const { result, rerender } = renderHook(useTaskListData, {
        initialProps,
    });
    await waitFor(() => expect(result.current.tasks).toEqual([]));
    act(() => result.current.onAdded(temporary));
    act(() => result.current.onReconciled(temporary.id, own));
    await act(async () => {
        await result.current.reload();
    });
    expect(result.current.tasks).toEqual([own]);

    rerender({ ...initialProps, state: "done" });
    await waitFor(() => expect(result.current.tasks).toEqual([]));
    rerender(initialProps);
    await waitFor(() => expect(result.current.tasks).toEqual([]));
});
