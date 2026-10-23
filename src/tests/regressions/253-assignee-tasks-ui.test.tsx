// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppNav } from "@/components/app-nav";
import { MergeTaskPicker } from "@/components/tasks/merge-task-picker";
import { RecordingTasks } from "@/components/tasks/recording-tasks";
import { TaskDetail } from "@/components/tasks/task-detail";
import { TaskList } from "@/components/tasks/task-list";
import { TaskRow } from "@/components/tasks/task-row";
import type { RecordingTasksState } from "@/components/tasks/use-recording-tasks";
import type { TaskView } from "@/lib/tasks/tasks";
import type { RecordingFolder } from "@/types/folder";

const { navigation, translate } = vi.hoisted(() => ({
    navigation: {
        params: new URLSearchParams(),
        push: vi.fn(),
        replace: vi.fn(),
    },
    translate: (text: string) => text,
}));
vi.mock("next/navigation", () => ({
    useRouter: () => navigation,
    usePathname: () => "/tasks",
    useSearchParams: () => navigation.params,
}));
vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => "en",
    useFormatter: () => ({ dateTime: (date: Date) => date.toISOString() }),
}));
vi.mock("@/hooks/use-org-events", () => ({ useOrgEvents: vi.fn() }));
vi.mock("@/components/tasks/routed-proposals-inbox", () => ({
    RoutedProposalsInbox: () => null,
}));
vi.mock("@/components/learn/review-events", () => ({
    usePendingReviews: () => 0,
}));
vi.mock("@/components/tasks/use-pending-tasks", () => ({
    usePendingTasks: () => 0,
}));
vi.mock("@/components/product-name-provider", () => ({
    useProductName: () => "Example",
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function task(overrides: Partial<TaskView> = {}): TaskView {
    return {
        id: "task",
        recordingId: "item",
        evidenceItemId: "item",
        evidenceItemKind: "mail",
        evidenceAudioAvailable: false,
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
        evidenceText: null,
        evidenceProvenance: null,
        source: "manual",
        ticked: true,
        version: 3,
        createdAt: "2026-10-22T10:00:00Z",
        acceptedAt: null,
        statusChangedAt: null,
        canEdit: true,
        canClose: true,
        canUndoMatch: false,
        own: false,
        note: null,
        noteBy: null,
        noteUpdatedAt: null,
        following: false,
        automaticFollow: false,
        canFollow: true,
        canMerge: true,
        ...overrides,
    };
}
let fetchMock: ReturnType<
    typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>
>;
let folders: RecordingFolder[];
beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
    folders = [];
    navigation.params = new URLSearchParams();
    navigation.push.mockClear();
    navigation.replace.mockClear();
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/tasks" && init?.method === "POST")
            return Response.json(
                task({ recordingId: null, source: "personal", own: true }),
            );
        if (url.startsWith("/api/tasks?")) return Response.json({ tasks: [] });
        if (url === "/api/folders") return Response.json({ folders });
        if (url === "/api/tasks/pending") return Response.json({});
        if (url.endsWith("/follow"))
            return Response.json(task({ following: true }));
        return Response.json({ candidates: [], nextOffset: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("#253 task desk UI", () => {
    it("inserts an own task and closes immediately, then replaces the temporary row with the server row", async () => {
        let finish: (response: Response) => void = () => {};
        const response = new Promise<Response>((resolve) => {
            finish = resolve;
        });
        const fallback = fetchMock.getMockImplementation();
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (url === "/api/tasks" && init?.method === "POST")
                return response;
            if (!fallback) throw new Error("Missing fetch mock");
            return fallback(url, init);
        });
        render(<TaskList organization={false} />);
        await screen.findByText("Nothing here.");
        fireEvent.click(screen.getByRole("button", { name: "Add task" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Task text" }), {
            target: { value: "Draft reminder" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
        expect(screen.getByText("Draft reminder")).toBeTruthy();
        expect(screen.queryByRole("textbox", { name: "Task text" })).toBeNull();
        expect(document.activeElement).toBe(
            screen.getByRole("button", { name: "Add task" }),
        );
        expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).toBe(
            "true",
        );
        const trigger = screen.getByRole("button", { name: "Add task" });
        expect(trigger.getAttribute("aria-disabled")).toBe("true");
        expect(trigger.classList.contains("aria-disabled:opacity-50")).toBe(
            true,
        );
        fireEvent.click(trigger);
        expect(screen.queryByRole("textbox", { name: "Task text" })).toBeNull();
        await act(async () =>
            finish(
                Response.json(
                    task({
                        id: "saved",
                        recordingId: null,
                        own: true,
                        source: "personal",
                        text: "Saved reminder",
                        version: 8,
                    }),
                ),
            ),
        );
        expect(screen.queryByText("Draft reminder")).toBeNull();
        expect(screen.getAllByText("Saved reminder")).toHaveLength(1);
        expect(document.activeElement).toBe(
            screen.getByRole("button", { name: "Add task" }),
        );
        fireEvent.click(screen.getByRole("checkbox", { name: "Done" }));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks/saved",
                expect.objectContaining({
                    method: "PATCH",
                    body: JSON.stringify({ status: "done", version: 8 }),
                }),
            ),
        );
        fireEvent.click(screen.getByRole("button", { name: "Add task" }));
        expect(
            screen.getByRole("textbox", { name: "Task text" }),
        ).toHaveProperty("value", "");
    });
    it.each([
        "load first",
        "save first",
        "load includes saved",
        "load fails",
        "temporary row cleared",
        "filter changed",
    ])("keeps an own task across a deferred initial GET (%s)", async (ordering) => {
        navigation.params.set("add", "request");
        const initial = Promise.withResolvers<Response>();
        const save = Promise.withResolvers<Response>();
        const fallback = fetchMock.getMockImplementation();
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (url.startsWith("/api/tasks?")) return initial.promise;
            if (url === "/api/tasks" && init?.method === "POST")
                return save.promise;
            if (!fallback) throw new Error("Missing fetch mock");
            return fallback(url, init);
        });
        const view = render(<TaskList organization={false} />);
        fireEvent.change(screen.getByRole("textbox", { name: "Task text" }), {
            target: { value: "Draft reminder" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
        expect(screen.getAllByText("Draft reminder")).toHaveLength(1);
        const saved = {
            ...task({
                id: "saved",
                text: "Saved reminder",
                recordingId: null,
                own: true,
                source: "personal",
                version: 8,
            }),
            recording: null,
            evidence: null,
            visibleMentionQuotes: [],
        };
        if (
            ordering === "temporary row cleared" ||
            ordering === "filter changed"
        ) {
            navigation.params.set("state", "done");
            view.rerender(<TaskList organization={false} />);
            if (ordering === "temporary row cleared") {
                navigation.params.delete("state");
                view.rerender(<TaskList organization={false} />);
            }
            expect(screen.queryByText("Draft reminder")).toBeNull();
        }
        const saveFirst = [
            "save first",
            "temporary row cleared",
            "filter changed",
        ].includes(ordering);
        if (saveFirst) {
            await act(async () => save.resolve(Response.json(saved)));
            if (ordering === "filter changed")
                expect(screen.queryByText("Saved reminder")).toBeNull();
            else expect(screen.getAllByText("Saved reminder")).toHaveLength(1);
        }
        await act(async () =>
            initial.resolve(
                ordering === "load fails"
                    ? new Response(null, { status: 500 })
                    : Response.json({
                          tasks:
                              ordering === "load includes saved" ? [saved] : [],
                      }),
            ),
        );
        if (!saveFirst) {
            expect(screen.getAllByText("Draft reminder")).toHaveLength(1);
            await act(async () => save.resolve(Response.json(saved)));
        }
        expect(screen.queryByText("Draft reminder")).toBeNull();
        if (ordering === "filter changed")
            expect(screen.queryByText("Saved reminder")).toBeNull();
        else expect(screen.getAllByText("Saved reminder")).toHaveLength(1);
        navigation.params.set("state", "all");
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (url.startsWith("/api/tasks?"))
                return Promise.resolve(Response.json({ tasks: [saved] }));
            if (!fallback) throw new Error("Missing fetch mock");
            return fallback(url, init);
        });
        view.rerender(<TaskList organization={false} />);
        await screen.findByText("Saved reminder");
        expect(screen.getAllByText("Saved reminder")).toHaveLength(1);
    });
    it.each([
        "shiftKey",
        "ctrlKey",
        "altKey",
        "metaKey",
    ])("keeps the native context menu with %s held", (modifier) => {
        render(<AppNav />);
        const link = screen.getByRole("link", { name: "Tasks" });
        const event = new MouseEvent("contextmenu", {
            button: 2,
            bubbles: true,
            cancelable: true,
            [modifier]: true,
        });
        fireEvent(link, event);
        expect(event.defaultPrevented).toBe(false);
        expect(navigation.push).not.toHaveBeenCalled();
        expect(link.title).toContain("Shift, Ctrl, Alt or Meta");
        expect(fireEvent.contextMenu(link)).toBe(false);
        expect(navigation.push).toHaveBeenCalledTimes(1);
    });
    it("removes a failed temporary row, shows the server message and preserves the URL-opened draft", async () => {
        folders = folderTree();
        navigation.params.set("folder", "drafts");
        navigation.params.set("add", "request");
        let finish: (response: Response) => void = () => {};
        const response = new Promise<Response>((resolve) => {
            finish = resolve;
        });
        const fallback = fetchMock.getMockImplementation();
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (url === "/api/tasks" && init?.method === "POST")
                return response;
            if (!fallback) throw new Error("Missing fetch mock");
            return fallback(url, init);
        });
        const view = render(<TaskList organization={false} />);
        await screen.findByText("Nothing here.");
        await waitFor(() =>
            expect(
                screen.getByRole("combobox", { name: "Task folder" })
                    .textContent,
            ).toContain("Drafts"),
        );
        fireEvent.change(screen.getByRole("textbox", { name: "Task text" }), {
            target: { value: "Keep my draft" },
        });
        fireEvent.change(screen.getByLabelText("Due date"), {
            target: { value: "2026-10-30" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
        expect(screen.getByText("Keep my draft")).toBeTruthy();
        navigation.params.delete("add");
        view.rerender(<TaskList organization={false} />);
        await act(async () =>
            finish(
                Response.json(
                    {
                        error: "The selected folder is unavailable",
                        code: "INVALID_INPUT",
                    },
                    { status: 400 },
                ),
            ),
        );
        expect(screen.queryByText("Keep my draft")).toBeNull();
        expect(toast.error).toHaveBeenCalledExactlyOnceWith(
            "The selected folder is unavailable",
        );
        fireEvent.click(screen.getByRole("button", { name: "Add task" }));
        expect(
            screen.getByRole("textbox", { name: "Task text" }),
        ).toHaveProperty("value", "Keep my draft");
        expect(screen.getByLabelText("Due date")).toHaveProperty(
            "value",
            "2026-10-30",
        );
        expect(
            screen.getByRole("combobox", { name: "Task folder" }).textContent,
        ).toContain("Drafts");
    });
    it("focuses an existing draft for each navigation request without discarding its text", async () => {
        navigation.params.set("add", "first");
        const view = render(<TaskList organization={false} />);
        await screen.findByText("Nothing here.");
        const input = screen.getByRole("textbox", { name: "Task text" });
        fireEvent.change(input, { target: { value: "Existing draft" } });
        screen.getByLabelText("Due date").focus();
        navigation.params.set("add", "second");
        view.rerender(<TaskList organization={false} />);
        expect(document.activeElement).toBe(input);
        expect(input).toHaveProperty("value", "Existing draft");
    });
    it.each([
        "Escape",
        "Cancel",
    ])("cancels with %s and returns focus to Add task", async (action) => {
        render(<TaskList organization={false} />);
        await screen.findByText("Nothing here.");
        fireEvent.click(screen.getByRole("button", { name: "Add task" }));
        if (action === "Escape")
            fireEvent.keyDown(
                screen.getByRole("textbox", { name: "Task text" }),
                { key: "Escape" },
            );
        else fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("textbox", { name: "Task text" })).toBeNull();
        expect(document.activeElement).toBe(
            screen.getByRole("button", { name: "Add task" }),
        );
        expect(
            fetchMock.mock.calls.some(
                ([url, init]) =>
                    url === "/api/tasks" && init?.method === "POST",
            ),
        ).toBe(false);
    });
    it.each([
        "ContextMenu",
        "F10",
    ])("deduplicates %s and its native contextmenu without swallowing later context menus", (key) => {
        vi.useFakeTimers();
        render(<AppNav />);
        const link = screen.getByRole("link", { name: "Tasks" });
        fireEvent.keyDown(link, { key, shiftKey: key === "F10" });
        fireEvent.contextMenu(link);
        expect(navigation.push).toHaveBeenCalledTimes(1);
        fireEvent.contextMenu(link);
        expect(navigation.push).toHaveBeenCalledTimes(2);
        fireEvent.keyDown(link, { key, shiftKey: key === "F10" });
        act(() => vi.advanceTimersByTime(1001));
        fireEvent.contextMenu(link);
        expect(navigation.push).toHaveBeenCalledTimes(4);
    });
    it.each([
        "list",
        "detail",
        "audio",
        "mail",
    ])("shows the localized merge refusal once and preserves the task in %s", async (surface) => {
        const row = task({
            evidenceItemKind: surface === "audio" ? "audio" : "mail",
        });
        const listRow = {
            ...row,
            recording: null,
            evidence: null,
            visibleMentionQuotes: [],
        };
        const refresh = vi.fn(async () => {});
        fetchMock.mockImplementation(
            async (url: string, init?: RequestInit) => {
                if (url === "/api/folders")
                    return Response.json({ folders: [] });
                if (url.startsWith("/api/tasks?"))
                    return Response.json({ tasks: [listRow] });
                if (url === "/api/tasks/pending") return Response.json({});
                if (init?.method === "POST")
                    return Response.json(
                        {
                            error: "Merge rule: only the home owner or a curator may merge that owner's tasks",
                            code: "FORBIDDEN",
                        },
                        { status: 403 },
                    );
                if (url.includes("target="))
                    return Response.json({
                        keepId: "target",
                        mergeId: row.id,
                        keepVersion: 8,
                        mergeVersion: 3,
                        text: "Merged preview",
                        note: null,
                        dueDate: null,
                        privateToShared: false,
                    });
                return Response.json({
                    candidates: [
                        {
                            id: "target",
                            text: "Kept task",
                            homeItem: null,
                            assignee: null,
                            dueDate: null,
                            duePhrase: null,
                        },
                    ],
                    nextOffset: null,
                });
            },
        );
        const state: RecordingTasksState = {
            itemId: "item",
            data: {
                canEdit: true,
                reviewed: true,
                tasks: [row],
                proposals: [],
                updates: [],
                matches: [],
            },
            failed: false,
            reviewing: false,
            waiting: 0,
            accepting: false,
            refresh,
            update: vi.fn(),
            add: vi.fn(),
            merge: vi.fn(),
            tickUpdate: vi.fn(),
            tickMatch: vi.fn(),
            mergeInto: vi.fn(),
            undoMatch: vi.fn(),
            accept: vi.fn(),
        };
        render(
            surface === "list" ? (
                <TaskList organization={false} />
            ) : surface === "detail" ? (
                <TaskDetail initialTask={listRow} />
            ) : (
                <RecordingTasks
                    state={state}
                    speakers={[]}
                    organizationOnly
                    fallback={null}
                />
            ),
        );
        fireEvent.click(
            await screen.findByRole("button", {
                name: "Merge into another task",
            }),
        );
        fireEvent.click(await screen.findByRole("option"));
        await screen.findByText("Merged preview");
        fireEvent.click(screen.getByRole("button", { name: "Merge task" }));
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledExactlyOnceWith(
                "Merge rule: only the task's home owner or a curator may merge it.",
            ),
        );
        if (surface === "list")
            expect(screen.getByText("Send the draft")).toBeTruthy();
        else expect(screen.getByRole("dialog")).toBeTruthy();
        expect(toast.success).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
    });
    const folderTree = (): RecordingFolder[] => [
        {
            id: "private",
            parentId: null,
            kind: "private",
            scope: "personal",
            name: "Private",
            version: 0,
            sortOrder: 0,
        },
        {
            id: "drafts",
            parentId: "private",
            kind: "custom",
            scope: "personal",
            name: "Drafts",
            version: 0,
            sortOrder: 0,
        },
        {
            id: "later",
            parentId: "private",
            kind: "custom",
            scope: "personal",
            name: "Later",
            version: 0,
            sortOrder: 1,
        },
        {
            id: "public",
            parentId: null,
            kind: "public",
            scope: "personal",
            name: "Public",
            version: 0,
            sortOrder: 1,
        },
        {
            id: "public-child",
            parentId: "public",
            kind: "custom",
            scope: "personal",
            name: "Public child",
            version: 0,
            sortOrder: 0,
        },
        {
            id: "team",
            parentId: null,
            kind: "public",
            scope: "org",
            name: "Team",
            version: 0,
            sortOrder: 0,
        },
    ];
    it.each([
        "drafts",
        "private",
        "team",
        "all",
    ])("defaults the add form folder pill from the %s filter", async (selected) => {
        folders = folderTree();
        navigation.params.set("folder", selected);
        navigation.params.set("add", "new");
        render(<TaskList organization={false} />);
        await waitFor(() =>
            expect(
                screen.getByRole("combobox", { name: "Task folder" })
                    .textContent,
            ).toContain(selected === "drafts" ? "Drafts" : "No folder"),
        );
        fireEvent.change(screen.getByRole("textbox", { name: "Task text" }), {
            target: { value: "Prepare the plan" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks",
                expect.objectContaining({
                    body: JSON.stringify({
                        text: "Prepare the plan",
                        dueDate: null,
                        folderId: selected === "drafts" ? "drafts" : null,
                    }),
                }),
            ),
        );
    });
    it("offers only the private tree in the add pill, searches folders and clears with No folder", async () => {
        folders = folderTree();
        navigation.params.set("add", "new");
        render(<TaskList organization={false} />);
        await act(async () => {});
        const pill = screen.getByRole("combobox", { name: "Task folder" });
        expect(pill.parentElement?.textContent).toContain("Only you");
        fireEvent.click(pill);
        expect(
            screen.queryByRole("option", { name: /Team|Public|Private/ }),
        ).toBeNull();
        const search = screen.getByRole("combobox", {
            name: "Choose a folder",
        });
        fireEvent.change(search, { target: { value: "draft" } });
        fireEvent.click(screen.getByRole("option", { name: /Drafts/ }));
        expect(pill.textContent).toContain("Drafts");
        expect(pill.querySelector(".lucide-folder")).toBeTruthy();
        fireEvent.click(pill);
        fireEvent.click(screen.getByRole("option", { name: "No folder" }));
        expect(pill.textContent).toContain("No folder");
    });
    it.each([
        true,
        false,
    ])("shows the own row folder button with filed=%s and sends optimistic changes", (filed) => {
        const change = vi.fn();
        render(
            <ul>
                <TaskRow
                    task={task({
                        source: "personal",
                        own: true,
                        recordingId: null,
                        folder: filed
                            ? {
                                  id: "drafts",
                                  name: "Drafts",
                                  path: "Private / Drafts",
                              }
                            : null,
                    })}
                    folders={folderTree()}
                    organizationOnly={false}
                    onChange={change}
                />
            </ul>,
        );
        const pill = screen.getByRole("combobox", { name: "Task folder" });
        expect(pill.textContent).toContain(
            filed ? "Drafts" : "File in a folder",
        );
        expect(pill.classList.contains("task-row-folder-action")).toBe(!filed);
        for (const utility of ["border-0", "px-0", "py-0"])
            expect(pill.classList.contains(utility)).toBe(true);
        for (const utility of ["border", "px-2", "py-1"])
            expect(pill.classList.contains(utility)).toBe(false);
        expect(pill.parentElement?.textContent).toContain("Own task");
        fireEvent.click(pill);
        fireEvent.click(screen.getByRole("option", { name: /Later/ }));
        expect(change).toHaveBeenCalledWith(
            { folderId: "later" },
            { folder: { id: "later", name: "Later", path: "Private / Later" } },
        );
        fireEvent.click(pill);
        fireEvent.click(screen.getByRole("option", { name: "No folder" }));
        expect(change).toHaveBeenCalledWith(
            { folderId: null },
            { folder: null },
        );
    });
    it("keeps the filed folder name visible while folder choices load", () => {
        render(
            <ul>
                <TaskRow
                    task={task({
                        source: "personal",
                        own: true,
                        recordingId: null,
                        folder: {
                            id: "drafts",
                            name: "Drafts",
                            path: "Private / Drafts",
                        },
                    })}
                    organizationOnly={false}
                    onChange={vi.fn()}
                />
            </ul>,
        );
        expect(
            screen.getByRole("combobox", { name: "Task folder" }).textContent,
        ).toContain("Drafts");
    });
    it("saves row filing optimistically with the current version", async () => {
        folders = folderTree();
        fetchMock.mockImplementation(
            async (url: string, init?: RequestInit) => {
                if (url === "/api/folders") return Response.json({ folders });
                if (url.startsWith("/api/tasks?"))
                    return Response.json({
                        tasks: [
                            {
                                ...task({
                                    own: true,
                                    source: "personal",
                                    recordingId: null,
                                }),
                                recording: null,
                                evidence: null,
                            },
                        ],
                    });
                if (init?.method === "PATCH")
                    return Response.json(
                        task({
                            own: true,
                            source: "personal",
                            recordingId: null,
                            version: 4,
                            folder: {
                                id: "drafts",
                                name: "Drafts",
                                path: "Private / Drafts",
                            },
                        }),
                    );
                return Response.json({});
            },
        );
        render(<TaskList organization={false} />);
        const pill = await screen.findByRole("combobox", {
            name: "Task folder",
        });
        fireEvent.click(pill);
        fireEvent.click(screen.getByRole("option", { name: /Drafts/ }));
        expect(pill.textContent).toContain("Drafts");
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks/task",
                expect.objectContaining({
                    method: "PATCH",
                    body: JSON.stringify({ folderId: "drafts", version: 3 }),
                }),
            ),
        );
    });
    it("reveals unfiled row filing on hover or keyboard focus and leaves it visible on touch", () => {
        const css = readFileSync("src/components/tasks/task-row.css", "utf8");
        expect(css).toContain("@media (hover: hover) and (pointer: fine)");
        expect(css).toContain(".task-row .task-row-folder-action");
        expect(css).toContain(".task-row:hover .task-row-folder-action");
        expect(css).toContain(".task-row:focus-within .task-row-folder-action");
        expect(
            css.indexOf(".task-row .task-row-folder-action"),
        ).toBeGreaterThan(css.indexOf("@media"));
    });
    it("puts Add task first on Mine and focuses the own-task form opened from navigation", async () => {
        navigation.params.set("add", "request-1");
        render(<TaskList organization={false} />);
        const text = await screen.findByRole("textbox", { name: "Task text" });
        expect(document.activeElement).toBe(text);
        expect(screen.getByText("Only you")).toBeTruthy();
        fireEvent.change(text, { target: { value: "Prepare the plan" } });
        fireEvent.change(screen.getByLabelText("Due date"), {
            target: { value: "2026-10-30" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({
                        text: "Prepare the plan",
                        dueDate: "2026-10-30",
                        folderId: null,
                    }),
                }),
            ),
        );
        expect(navigation.replace).toHaveBeenCalledWith("/tasks", {
            scroll: false,
        });
    });
    it.each([
        "contextmenu",
        "ContextMenu",
        "F10",
    ])("opens own-task entry with %s while retaining normal link navigation", (trigger) => {
        render(<AppNav />);
        const link = screen.getByRole("link", { name: "Tasks" });
        expect(link.getAttribute("href")).toBe("/tasks");
        if (trigger === "contextmenu") fireEvent.contextMenu(link);
        else
            fireEvent.keyDown(link, {
                key: trigger,
                shiftKey: trigger === "F10",
            });
        expect(navigation.push).toHaveBeenCalledWith(
            expect.stringMatching(/^\/tasks\?add=/),
        );
        navigation.push.mockClear();
        fireEvent.click(link, { ctrlKey: true });
        fireEvent(
            link,
            new MouseEvent("auxclick", {
                button: 1,
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(navigation.push).not.toHaveBeenCalled();
        expect(link.title).toContain("Right-click");
    });
    it.each([
        0, 10, 11,
    ])("long press tolerates up to 10 CSS px of touch movement (%s px)", (distance) => {
        vi.useFakeTimers();
        render(<AppNav />);
        const link = screen.getByRole("link", { name: "Tasks" });
        const pointer = (type: string, x: number, y: number) => {
            const event = new MouseEvent(type, {
                bubbles: true,
                clientX: x,
                clientY: y,
            });
            Object.defineProperty(event, "pointerType", { value: "touch" });
            fireEvent(link, event);
        };
        pointer("pointerdown", 100, 100);
        pointer("pointermove", 100 + distance * 0.6, 100 + distance * 0.8);
        act(() => vi.advanceTimersByTime(600));
        expect(navigation.push).toHaveBeenCalledTimes(distance > 10 ? 0 : 1);
        navigation.push.mockClear();
        pointer("pointerdown", 100, 100);
        pointer("pointerup", 100, 100);
        act(() => vi.advanceTimersByTime(600));
        expect(navigation.push).not.toHaveBeenCalled();
    });
    it.each([
        ["mine", false],
        ["mine", true],
        ["followed", false],
    ] as const)("restores the item assignee display for %s with canEdit=%s", async (tab, canEdit) => {
        navigation.params.set("tab", tab);
        fetchMock.mockImplementation(async (url: string) => {
            if (url === "/api/folders") return Response.json({ folders: [] });
            if (url.startsWith("/api/tasks/assignees"))
                return Response.json({ assignees: [] });
            if (url.startsWith("/api/tasks?"))
                return Response.json({
                    tasks: [
                        {
                            ...task({
                                canEdit,
                                assignee: { personId: "self", name: "Caller" },
                            }),
                            recording: null,
                            evidence: null,
                        },
                        {
                            ...task({
                                id: "own",
                                source: "personal",
                                own: true,
                                recordingId: null,
                            }),
                            recording: null,
                            evidence: null,
                        },
                    ],
                });
            return Response.json({});
        });
        render(<TaskList organization={false} />);
        await screen.findByText("Only you");
        expect(
            Boolean(
                screen.queryByRole("button", { name: "Assigned to {name}" }),
            ),
        ).toBe(tab === "followed" || canEdit);
    });
    it("offers Add task before task rows", async () => {
        render(<TaskList organization={false} />);
        const add = screen.getByRole("button", { name: "Add task" });
        expect(add.closest("li")).toBe(
            document.querySelector("ul")?.firstElementChild,
        );
        fireEvent.click(add);
        expect(document.activeElement).toBe(
            screen.getByRole("textbox", { name: "Task text" }),
        );
        await act(async () => {});
    });
    it.each([
        "page",
        "item",
    ])("opens a skippable note on tick and saves from the same box in the %s row", (variant) => {
        const change = vi.fn();
        render(
            <TaskRow
                task={task()}
                recording={
                    variant === "page"
                        ? {
                              id: "item",
                              kind: "mail",
                              title: "Planning",
                              startTime: "2026-10-22T00:00:00Z",
                              view: "org",
                          }
                        : undefined
                }
                currentItemId="item"
                organizationOnly
                onChange={change}
            />,
        );
        fireEvent.click(screen.getByRole("checkbox", { name: "Done" }));
        expect(change).toHaveBeenCalledWith(
            { status: "done" },
            { status: "done" },
        );
        const note = screen.getByRole("textbox", { name: "Note" });
        expect(document.activeElement).toBe(note);
        expect(note.getAttribute("maxlength")).toBe("2000");
        fireEvent.click(screen.getByRole("button", { name: "Skip" }));
        fireEvent.click(screen.getByRole("button", { name: "Note" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
            target: { value: "Resolved" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save note" }));
        expect(change).toHaveBeenCalledWith(
            { note: "Resolved" },
            { note: "Resolved" },
        );
    });
    it.each([
        "page",
        "item",
    ])("matches the merge trigger to the note action in the %s row", async (variant) => {
        render(
            <TaskRow
                task={task()}
                recording={
                    variant === "page"
                        ? {
                              id: "item",
                              kind: "mail",
                              title: "Planning",
                              startTime: "2026-10-22T00:00:00Z",
                              view: "org",
                          }
                        : undefined
                }
                currentItemId="item"
                organizationOnly
                onChange={vi.fn()}
                onMerge={vi.fn(async () => true)}
            />,
        );
        const note = screen.getByRole("button", { name: "Note" });
        const merge = screen.getByRole("button", {
            name: "Merge into another task",
        });
        expect(merge.className).toBe(note.className);
        expect(merge.querySelector("svg")?.classList.contains("size-3")).toBe(
            true,
        );
        fireEvent.click(merge);
        expect(screen.getByRole("dialog")).toBeTruthy();
        await screen.findByText("No matching open tasks");
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    });
    it("shows source and pills on separate rows, own privacy, saved note attribution and follow state", async () => {
        const evidence = {
            id: "item",
            kind: "mail" as const,
            title: "Planning mail",
            startTime: "2026-10-22T00:00:00Z",
            view: "org" as const,
            audioAvailable: false,
        };
        const view = render(
            <TaskRow
                task={task({
                    note: "Ready",
                    noteBy: { id: "author", name: "Luma Veln" },
                    noteUpdatedAt: "2026-10-22T10:00:00Z",
                })}
                recording={evidence}
                evidence={evidence}
                organizationOnly
                onChange={vi.fn()}
            />,
        );
        const source = screen.getByRole("link", { name: /Planning mail/ });
        expect(source.className).toContain("border");
        expect(source.querySelector(".lucide-mail")).toBeTruthy();
        expect(screen.getByText("Ready")).toBeTruthy();
        expect(screen.getByText(/Luma Veln/)).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Follow" }));
        await screen.findByRole("button", { name: "Following", pressed: true });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/tasks/task/follow",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ follow: true }),
            }),
        );
        view.rerender(
            <TaskRow
                task={task({
                    own: true,
                    source: "personal",
                    recordingId: null,
                    evidenceItemId: null,
                })}
                recording={null}
                organizationOnly={false}
                onChange={vi.fn()}
            />,
        );
        expect(screen.getByText("Only you")).toBeTruthy();
        expect(screen.getByText(/Own task/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    });
    it("hides actions only on hover-capable fine pointers and preserves following state and focus", () => {
        const css = readFileSync("src/components/tasks/task-row.css", "utf8");
        expect(css).toContain("@media (hover: hover) and (pointer: fine)");
        expect(css).toContain(":not(.task-following)");
        expect(css).toContain(".task-row:focus-within");
        expect(css).not.toContain("display: none");
    });
    it("renders a server preview and requires private disclosure confirmation before merging", async () => {
        const merge = vi.fn(async () => true);
        fetchMock.mockImplementation(async (url: string) =>
            url.includes("target=")
                ? Response.json({
                      keepId: "target",
                      mergeId: "task",
                      keepVersion: 8,
                      mergeVersion: 3,
                      text: "Kept text\nPrivate text",
                      note: "Combined note",
                      dueDate: "2026-10-25",
                      privateToShared: true,
                  })
                : Response.json({
                      candidates: [
                          {
                              id: "target",
                              text: "Kept text",
                              homeItem: null,
                              assignee: null,
                              dueDate: null,
                              duePhrase: null,
                          },
                      ],
                      nextOffset: null,
                  }),
        );
        render(
            <MergeTaskPicker
                itemId={null}
                sourceTaskId="task"
                taskVersion={3}
                onMerge={merge}
            />,
        );
        const trigger = screen.getByRole("button", {
            name: "Merge into another task",
        });
        expect(trigger.classList.contains("h-8")).toBe(true);
        expect(trigger.classList.contains("text-sm")).toBe(true);
        expect(
            trigger.querySelector("svg")?.classList.contains("size-3.5"),
        ).toBe(true);
        fireEvent.click(trigger);
        fireEvent.click(await screen.findByRole("option"));
        await screen.findByText("Kept text Private text", { exact: false });
        const confirm = screen.getByRole("checkbox");
        expect(confirm.closest("label")?.textContent).toContain(
            "private text and note",
        );
        expect(
            screen.getByRole("button", { name: "Merge task" }),
        ).toHaveProperty("disabled", true);
        fireEvent.click(confirm);
        fireEvent.click(screen.getByRole("button", { name: "Merge task" }));
        await waitFor(() =>
            expect(merge).toHaveBeenCalledWith("target", {
                sourceVersion: 3,
                targetVersion: 8,
                confirmPrivateToShared: true,
            }),
        );
    });
});
