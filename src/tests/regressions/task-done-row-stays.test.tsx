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
import { afterEach, expect, it, vi } from "vitest";
import { FolderTasksPanel } from "@/components/tasks/folder-tasks-panel";
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

const { orgEvent, translate } = vi.hoisted(() => ({
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

it("keeps the completed row and its open note editor through Organization refreshes until the filter changes", async () => {
    Element.prototype.scrollIntoView = vi.fn();
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
            if (revising && state === "open") return revisionResponse.promise;
            return Response.json({ tasks: state === "open" ? rows : [] });
        }
        return Response.json({ assignees: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const assignments = [{ recordingId: recording.id, folderId: folder.id }];
    const panel = (placements: RecordingFolderAssignment[]) => (
        <FolderTasksPanel
            folder={folder}
            organization={{
                folders: [folder],
                assignments: placements,
            }}
            isOrgAccount
            onBack={vi.fn()}
        />
    );
    const view = render(panel(assignments));
    const taskText = await screen.findByText(task.text);
    const list = taskText.closest("ul");
    const rowOrder = () =>
        Array.from(list?.children ?? [], (row) =>
            [before.text, task.text, after.text].find((label) =>
                row.textContent?.includes(label),
            ),
        );
    expect(screen.getByText("3 open")).toBeTruthy();
    await act(async () =>
        fireEvent.click(screen.getAllByRole("checkbox", { name: "Done" })[1]),
    );
    const note = screen.getByRole("textbox", { name: "Note" });
    expect(screen.getByText("2 open")).toBeTruthy();
    fetchMock.mockClear();

    await act(async () =>
        orgEvent.current?.({
            type: "recording",
            recordingId: recording.id,
            origin: tabEventOrigin(),
        }),
    );
    expect.soft(fetchMock).not.toHaveBeenCalled();
    expect.soft(screen.queryByRole("textbox", { name: "Note" })).toBe(note);

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
    expect(screen.getByText(task.text).classList.contains("line-through")).toBe(
        true,
    );
    expect(screen.getByRole("textbox", { name: "Note" })).toBe(note);
    expect(rowOrder()).toEqual([before.text, task.text, after.text]);
    expect(screen.getByText("2 open")).toBeTruthy();

    revising = true;
    fetchMock.mockClear();
    view.rerender(
        panel([
            ...assignments,
            { recordingId: "another-recording", folderId: folder.id },
        ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("state=open"),
    );
    expect(screen.queryByText("Loading tasks…")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Note" })).toBe(note);

    const fresh = { ...task, text: "Send the revised draft", version: 3 };
    rows = [before, after, fresh];
    await act(async () =>
        revisionResponse.resolve(Response.json({ tasks: rows })),
    );
    revising = false;
    expect(
        screen.getByText(fresh.text).classList.contains("line-through"),
    ).toBe(false);
    expect(screen.getByRole("textbox", { name: "Note" })).toBe(note);
    expect(screen.getByText("3 open")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("combobox", { name: "State" }), {
        key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("option", { name: "Dropped" }));
    await screen.findByText("No tasks in this folder");
    expect(screen.queryByText(fresh.text)).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
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
        return Response.json({ assignees: [] });
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
