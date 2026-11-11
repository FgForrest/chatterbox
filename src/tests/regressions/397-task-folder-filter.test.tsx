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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskList } from "@/components/tasks/task-list";
import { useTaskListData } from "@/hooks/use-task-list-data";
import type { TaskListItem, TaskTab } from "@/lib/tasks/tasks";
import type { RecordingFolder } from "@/types/folder";

const { navigation, translate } = vi.hoisted(() => ({
    navigation: { params: new URLSearchParams(), replace: vi.fn() },
    translate: (text: string | { message: string }) =>
        typeof text === "string" ? text : text.message,
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
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const folder = (
    id: string,
    parentId: string | null,
    overrides: Partial<RecordingFolder> = {},
): RecordingFolder => ({
    id,
    parentId,
    name: id,
    scope: "personal",
    kind: parentId ? "custom" : "private",
    sortOrder: 0,
    version: 0,
    ...overrides,
});
const deepName = "Planning and preparation for the quarterly release review";
const folders = [
    folder("private", null),
    folder("parent", "private"),
    folder("mine", "parent", { name: deepName }),
    folder("followed", "parent"),
    folder("all-only", "parent"),
    folder("empty", "private"),
    folder("unreadable", "parent", {
        access: false,
        restricted: true,
        scope: "org",
    }),
];
const options: Record<string, string[]> = {
    mine: ["mine"],
    followed: ["followed"],
    all: ["mine", "followed", "all-only", "unreadable"],
};
let fetchMock: ReturnType<typeof vi.fn<(url: string) => Promise<Response>>>;
beforeEach(() => {
    navigation.params = new URLSearchParams();
    navigation.replace.mockClear();
    fetchMock = vi.fn(async (url: string) => {
        if (url === "/api/folders") return Response.json({ folders });
        if (url === "/api/tasks/pending") return Response.json({});
        if (url.startsWith("/api/tasks/assignees"))
            return Response.json({ assignees: [] });
        if (url.startsWith("/api/tasks?")) {
            const query = new URL(url, "https://example.test").searchParams;
            return Response.json({
                tasks: [],
                folderIds: options[query.get("tab") ?? "mine"],
            });
        }
        throw new Error(`Unexpected request: ${url}`);
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
afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
});
const picker = () => screen.getByRole("combobox", { name: "Folder" });
const openOptions = () => {
    fireEvent.click(picker());
    return screen
        .getAllByRole("option")
        .map(
            (option) => option.getAttribute("aria-label") ?? option.textContent,
        );
};
const closeOptions = () =>
    fireEvent.keyDown(screen.getByPlaceholderText("Find a folder…"), {
        key: "Escape",
    });

describe("#397 Tasks folder filter", () => {
    it.each([
        "mine",
        "followed",
        "all",
    ])("shows %s options with ancestors, without empty or unreadable folders", async (tab) => {
        navigation.params.set("tab", tab);
        render(<TaskList organization={false} />);
        await screen.findByText("Nothing here.");
        const labels = openOptions().join("|");
        expect(labels).toContain("All folders");
        expect(labels).toContain("Private");
        expect(labels).toContain("parent");
        expect(labels.includes(deepName)).toBe(tab !== "followed");
        expect(labels.includes("followed Private")).toBe(tab !== "mine");
        expect(labels.includes("all-only")).toBe(tab === "all");
        expect(labels).not.toContain("empty");
        expect(labels).not.toContain("unreadable");
    });
    it("keeps a selected folder visible through a tab change and clears it without losing the tab", async () => {
        navigation.params.set("folder", "mine");
        const view = render(<TaskList organization={false} />);
        await screen.findByText("Nothing here.");
        expect(picker().title).toBe(`Private › parent › ${deepName}`);
        fireEvent.click(screen.getByRole("button", { name: "Followed" }));
        expect(navigation.replace).toHaveBeenCalledWith(
            "/tasks?folder=mine&tab=followed",
            { scroll: false },
        );
        navigation.params.set("tab", "followed");
        view.rerender(<TaskList organization={false} />);
        await waitFor(() =>
            expect(
                fetchMock.mock.calls.some(([url]) =>
                    url.includes("tab=followed&"),
                ),
            ).toBe(true),
        );
        await screen.findByText("Nothing here.");
        expect(picker().title).toBe(`Private › parent › ${deepName}`);
        expect(openOptions().join("|")).toContain(deepName);
        fireEvent.click(screen.getByRole("option", { name: "All folders" }));
        expect(navigation.replace).toHaveBeenLastCalledWith(
            "/tasks?tab=followed",
            { scroll: false },
        );
        navigation.params.delete("folder");
        view.rerender(<TaskList organization={false} />);
        await screen.findByText("Nothing here.");
        expect(picker().textContent).toBe("All folders");
        expect(openOptions().join("|")).not.toContain(deepName);
    });
    it("does not narrow options with state or deadline, and keeps filing choices complete", async () => {
        navigation.params.set("state", "done");
        navigation.params.set("due", "overdue");
        render(<TaskList organization={false} />);
        await screen.findByText("Nothing here.");
        expect(openOptions().join("|")).toContain(deepName);
        closeOptions();
        fireEvent.click(screen.getByRole("button", { name: "Add task" }));
        const filing = screen.getByRole("combobox", { name: "Task folder" });
        fireEvent.click(filing);
        expect(screen.getByRole("option", { name: /empty/ })).toBeTruthy();
    });
    it.each([
        240, 320, 375,
    ])("uses a shrinkable single-line label and full-path tooltip at %ipx", async (width) => {
        vi.stubGlobal("innerWidth", width);
        navigation.params.set("folder", "mine");
        render(<TaskList organization={false} />);
        await screen.findByText("Nothing here.");
        const trigger = picker();
        const label = trigger.querySelector("span");
        expect(trigger.title).toBe(`Private › parent › ${deepName}`);
        expect(trigger.classList.contains("min-w-0")).toBe(true);
        expect(trigger.classList.contains("max-w-48")).toBe(true);
        expect(label?.classList.contains("truncate")).toBe(true);
        expect(label?.classList.contains("whitespace-normal")).toBe(false);
        expect(label?.classList.contains("[overflow-wrap:anywhere]")).toBe(
            false,
        );
    });
    it("ignores stale folder responses after switching tabs", async () => {
        const pending = Promise.withResolvers<Response>();
        const original = fetchMock.getMockImplementation();
        fetchMock.mockImplementation((url) =>
            url.startsWith("/api/tasks?tab=mine")
                ? pending.promise
                : original
                  ? original(url)
                  : Promise.reject(new Error("Missing mock")),
        );
        const view = render(<TaskList organization={false} />);
        navigation.params.set("tab", "followed");
        view.rerender(<TaskList organization={false} />);
        await screen.findByText("Nothing here.");
        await act(async () =>
            pending.resolve(Response.json({ tasks: [], folderIds: ["mine"] })),
        );
        const labels = openOptions().join("|");
        expect(labels).toContain("followed");
        expect(labels).not.toContain(deepName);
    });
});

const ownTask: TaskListItem = {
    id: "own-task",
    recordingId: null,
    evidenceItemId: null,
    evidenceItemKind: "audio",
    evidenceAudioAvailable: false,
    status: "open",
    text: "Prepare the draft",
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
    source: "personal",
    own: true,
    folder: null,
    note: null,
    noteUpdatedAt: null,
    noteBy: null,
    following: false,
    automaticFollow: false,
    canFollow: true,
    canMerge: true,
    ticked: true,
    version: 0,
    createdAt: "2026-11-11T00:00:00Z",
    acceptedAt: null,
    statusChangedAt: null,
    canEdit: true,
    canClose: true,
    canUndoMatch: false,
    visibleMentionQuotes: [],
    recording: null,
    evidence: null,
};
const hookProps = {
    tab: "mine" as TaskTab,
    state: "open",
    filterFolders: true,
    initialFolders: folders,
    allOrganization: false,
    folder: "all",
    due: "all",
    sort: "created",
    assignee: "all",
};
const offered = (entries: RecordingFolder[]) =>
    entries.map((entry) => entry.id);
const taskGets = () =>
    fetchMock.mock.calls
        .map(([url]) => url)
        .filter((url) => url.startsWith("/api/tasks?"));

describe("#397 mutation reloads and folder cache", () => {
    it.each([
        ["folder", false],
        ["assignee", false],
        ["merge", false],
        ["folder", true],
        ["assignee", true],
        ["merge", true],
    ] as const)("keeps the current tab after a delayed %s mutation with failure=%s", async (mutation, failure) => {
        const held = Promise.withResolvers<Response>();
        const original = fetchMock.getMockImplementation();
        fetchMock.mockImplementation((url) => {
            if (url === `/api/tasks/${ownTask.id}` || url.endsWith("/merge"))
                return held.promise;
            if (url.startsWith("/api/tasks?tab=mine"))
                return Promise.resolve(
                    Response.json({ tasks: [ownTask], folderIds: ["mine"] }),
                );
            if (!original) throw new Error("Missing mock");
            return original(url);
        });
        const { result, rerender } = renderHook(useTaskListData, {
            initialProps: hookProps,
        });
        await waitFor(() => expect(result.current.tasks).toHaveLength(1));
        let merged: ReturnType<typeof result.current.merge> | undefined;
        act(() => {
            if (mutation === "merge")
                merged = result.current.merge(ownTask, "target");
            else
                result.current.update(
                    ownTask,
                    mutation === "folder"
                        ? { folderId: "mine" }
                        : { assigneePersonId: null },
                    {},
                );
        });
        await waitFor(() =>
            expect(
                fetchMock.mock.calls.some(
                    ([url]) =>
                        url === `/api/tasks/${ownTask.id}` ||
                        url.endsWith("/merge"),
                ),
            ).toBe(true),
        );
        rerender({ ...hookProps, tab: "followed" });
        await waitFor(() =>
            expect(offered(result.current.filterFolders)).toContain("followed"),
        );
        expect(result.current.tasks).toEqual([]);
        const before = taskGets().length;
        await act(async () => {
            held.resolve(
                failure
                    ? Response.json({ error: "Save refused" }, { status: 409 })
                    : Response.json({ ...ownTask, version: 1 }),
            );
            await merged;
        });
        await waitFor(() => expect(taskGets().length).toBeGreaterThan(before));
        expect(
            taskGets()
                .slice(before)
                .every((url) => url.includes("tab=followed")),
        ).toBe(true);
        expect(result.current.tasks).toEqual([]);
        expect(offered(result.current.filterFolders)).toEqual([
            "private",
            "parent",
            "followed",
        ]);
    });
    it("rejects a retained old reload before it can invalidate the new request", async () => {
        const held = Promise.withResolvers<Response>();
        const original = fetchMock.getMockImplementation();
        fetchMock.mockImplementation((url) =>
            url.startsWith("/api/tasks?tab=followed")
                ? held.promise
                : original
                  ? original(url)
                  : Promise.reject(new Error("Missing mock")),
        );
        const { result, rerender } = renderHook(useTaskListData, {
            initialProps: hookProps,
        });
        await waitFor(() => expect(result.current.tasks).toEqual([]));
        const staleReload = result.current.reload;
        rerender({ ...hookProps, tab: "followed" });
        const before = taskGets().length;
        await act(async () => {
            await staleReload();
        });
        expect(taskGets()).toHaveLength(before);
        await act(async () =>
            held.resolve(Response.json({ tasks: [], folderIds: ["followed"] })),
        );
        expect(offered(result.current.filterFolders)).toContain("followed");
    });
    it("reuses folder IDs across filters and returning tabs, with separate Organization scopes", async () => {
        const { result, rerender } = renderHook(useTaskListData, {
            initialProps: hookProps,
        });
        await waitFor(() => expect(result.current.tasks).toEqual([]));
        expect(
            taskGets().filter((url) => url.includes("folders=true")),
        ).toHaveLength(1);
        for (const change of [
            { state: "done" },
            { due: "none" },
            { sort: "due" },
            { folder: "empty" },
            { assignee: "none" },
        ]) {
            const before = taskGets().length;
            rerender({ ...hookProps, ...change });
            await waitFor(() =>
                expect(taskGets().length).toBeGreaterThan(before),
            );
            await waitFor(() => expect(result.current.tasks).toEqual([]));
        }
        expect(
            taskGets().filter((url) => url.includes("folders=true")),
        ).toHaveLength(1);
        rerender({ ...hookProps, tab: "followed" });
        await waitFor(() =>
            expect(offered(result.current.filterFolders)).toContain("followed"),
        );
        rerender({ ...hookProps, tab: "followed", allOrganization: true });
        await waitFor(() => expect(result.current.tasks).toEqual([]));
        expect(
            taskGets().filter((url) => url.includes("folders=true")),
        ).toHaveLength(3);
        rerender(hookProps);
        await waitFor(() => expect(result.current.tasks).toEqual([]));
        expect(taskGets().at(-1)).not.toContain("folders=true");
        expect(offered(result.current.filterFolders)).toContain("mine");
        await act(async () => {
            await result.current.reload();
        });
        expect(taskGets().at(-1)).toContain("folders=true");
    });
    it.each([
        null,
        { id: "empty", name: "Empty", path: "Private / Empty" },
    ])("adds pending own-task options for folder %s and removes failed inserts", async (filing) => {
        fetchMock.mockImplementation(async () =>
            Response.json({ tasks: [], folderIds: [] }),
        );
        const { result } = renderHook(useTaskListData, {
            initialProps: hookProps,
        });
        await waitFor(() => expect(result.current.tasks).toEqual([]));
        const pending = { ...ownTask, folder: filing };
        act(() => result.current.onAdded(pending));
        expect(offered(result.current.filterFolders)).toEqual(
            filing ? ["private", "empty"] : ["private"],
        );
        act(() => result.current.onReconciled(pending.id, null));
        expect(result.current.filterFolders).toEqual([]);
    });
    it("requests folder IDs only once when also loading the open count", async () => {
        const { result } = renderHook(() =>
            useTaskListData({ ...hookProps, state: "done", countOpen: true }),
        );
        await waitFor(() => expect(result.current.openCount).toBe(0));
        expect(taskGets()).toHaveLength(2);
        expect(
            taskGets().filter((url) => url.includes("folders=true")),
        ).toHaveLength(1);
    });
    it("refreshes cached scopes after an own task is saved", async () => {
        fetchMock.mockImplementation(async () =>
            Response.json({ tasks: [], folderIds: [] }),
        );
        const { result, rerender } = renderHook(useTaskListData, {
            initialProps: hookProps,
        });
        await waitFor(() => expect(result.current.tasks).toEqual([]));
        rerender({ ...hookProps, tab: "all" });
        await waitFor(() => expect(result.current.tasks).toEqual([]));
        act(() => result.current.onAdded(ownTask));
        await act(async () =>
            result.current.onReconciled(ownTask.id, {
                ...ownTask,
                id: "saved",
            }),
        );
        expect(taskGets().at(-1)).toContain("folders=true");
        expect(result.current.tasks?.map((task) => task.id)).toEqual(["saved"]);
        rerender(hookProps);
        await waitFor(() => expect(result.current.tasks).toEqual([]));
        expect(taskGets().at(-1)).toContain("folders=true");
    });
});
