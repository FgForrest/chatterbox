// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderTasksPanel } from "@/components/tasks/folder-tasks-panel";
import type { TaskRow as TaskRowComponent } from "@/components/tasks/task-row";
import type { TaskListItem } from "@/lib/tasks/tasks";
import type {
    FolderOrganization,
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";

const { translate, rowProps, orgEvent } = vi.hoisted(() => ({
    translate: (
        text: string | { message: string },
        values?: Record<string, string | number>,
    ) =>
        (typeof text === "string" ? text : text.message)
            .replace(
                /\{count, plural, one \{([^}]+)\} other \{([^}]+)\}\}/g,
                (_match, one: string, other: string) =>
                    (values?.count === 1 ? one : other).replaceAll(
                        "#",
                        String(values?.count),
                    ),
            )
            .replace(/\{(\w+)\}/g, (match, key: string) =>
                String(values?.[key] ?? match),
            ),
    rowProps: new Map<string, ComponentProps<typeof TaskRowComponent>>(),
    orgEvent: { current: null as (() => void) | null },
}));
vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => "en",
}));
vi.mock("@/hooks/use-org-events", () => ({
    useOrgEvents: (enabled: boolean, callback: () => void) => {
        if (enabled) orgEvent.current = callback;
    },
}));
vi.mock("@/components/tasks/task-row", () => ({
    TaskRow: (props: ComponentProps<typeof TaskRowComponent>) => {
        rowProps.set(props.task.id, props);
        return (
            <li>
                {props.task.text}
                <button
                    type="button"
                    onClick={() =>
                        props.onChange({ status: "done" }, { status: "done" })
                    }
                >
                    Complete {props.task.id}
                </button>
            </li>
        );
    },
}));
const root: RecordingFolder = {
    id: "private",
    parentId: null,
    kind: "private",
    scope: "personal",
    name: "Private",
    sortOrder: 0,
    version: 0,
};
const folder: RecordingFolder = {
    ...root,
    id: "projects",
    parentId: root.id,
    kind: "custom",
    name: "Projects",
};
const first: RecordingFolder = {
    ...folder,
    id: "first",
    parentId: folder.id,
    name: "First",
    sortOrder: 0,
};
const last: RecordingFolder = {
    ...first,
    id: "last",
    name: "Last",
    sortOrder: 1,
};
const tree = [root, folder, last, first];
function task(
    id: string,
    own = false,
    folderId: string | null = null,
): TaskListItem {
    return {
        id,
        text: id,
        recordingId: own ? null : id,
        evidenceItemId: own ? null : id,
        evidenceItemKind: "mail",
        evidenceAudioAvailable: false,
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
        source: own ? "personal" : "manual",
        own,
        folder: folderId
            ? { id: folderId, name: folderId, path: folderId }
            : null,
        note: null,
        noteBy: null,
        noteUpdatedAt: null,
        following: false,
        automaticFollow: false,
        canFollow: true,
        canMerge: true,
        canEdit: true,
        canClose: true,
        canUndoMatch: false,
        ticked: true,
        version: 4,
        createdAt: "2026-10-28T10:00:00Z",
        acceptedAt: null,
        statusChangedAt: null,
        recording: own
            ? null
            : {
                  id,
                  title: id,
                  view: "org",
                  kind: "mail",
                  startTime: "2026-10-28T10:00:00Z",
              },
        evidence: null,
        visibleMentionQuotes: [],
    };
}
let rows: TaskListItem[];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    rows = [
        task("task-last"),
        task("task-first"),
        task("own", true, folder.id),
    ];
    rowProps.clear();
    Element.prototype.scrollIntoView = vi.fn();
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/tasks/assignees"))
            return Response.json({
                assignees: [{ personId: "person", name: "Lada Cloudfern" }],
            });
        if (url.startsWith("/api/tasks?"))
            return Response.json({ tasks: rows });
        if (url === "/api/tasks" && init?.method === "POST") {
            const body = JSON.parse(String(init.body)) as {
                text: string;
                folderId: string | null;
            };
            return Response.json({
                ...task("saved", true, body.folderId),
                text: body.text,
                version: 9,
            });
        }
        if (url === "/api/tasks/own" && init?.method === "PATCH")
            return Response.json({
                ...task("own", true, folder.id),
                version: 5,
                status: "done",
            });
        return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
const assignments: RecordingFolderAssignment[] = [
    { recordingId: "task-last", folderId: last.id },
    { recordingId: "task-first", folderId: first.id },
];
function panel(
    isOrgAccount = false,
    target = folder,
    folders = tree,
    placements = assignments,
) {
    return render(
        <FolderTasksPanel
            folder={target}
            organization={{
                folders,
                assignments: placements,
            }}
            isOrgAccount={isOrgAccount}
            onBack={vi.fn()}
        />,
    );
}
describe("folder tasks panel", () => {
    it("does not mark global new tasks as seen when opened or filtered", async () => {
        panel();
        await screen.findByText("task-first");
        fireEvent.click(screen.getByRole("button", { name: "Mine" }));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks?tab=mine&state=open&sort=created&folder=projects",
            ),
        );
        expect(fetchMock).not.toHaveBeenCalledWith(
            "/api/tasks/pending",
            expect.objectContaining({ method: "POST" }),
        );
    });
    it("reloads rows, groups and open count when a child moves out and back in", async () => {
        const view = panel();
        await screen.findByText("task-first");
        const taskGets = () =>
            fetchMock.mock.calls.filter(([url]) =>
                String(url).startsWith("/api/tasks?"),
            ).length;
        expect(taskGets()).toBe(1);
        const remaining = rows.filter((row) => row.id !== "task-first");
        rows = remaining;
        view.rerender(
            <FolderTasksPanel
                folder={folder}
                organization={{
                    folders: tree.map((entry) =>
                        entry.id === first.id
                            ? { ...entry, parentId: root.id }
                            : entry,
                    ),
                    assignments,
                }}
                onBack={vi.fn()}
            />,
        );
        await waitFor(() => expect(taskGets()).toBe(2));
        await screen.findByText("Including subfolders · 2 open");
        expect(screen.queryByText("task-first")).toBeNull();
        expect(
            screen
                .getAllByRole("heading", { level: 3 })
                .map((h) => h.textContent),
        ).toEqual(["Private / Projects1", "Private / Projects / Last1"]);

        rows = [task("task-first"), ...remaining];
        view.rerender(
            <FolderTasksPanel
                folder={folder}
                organization={{ folders: tree, assignments }}
                onBack={vi.fn()}
            />,
        );
        await waitFor(() => expect(taskGets()).toBe(3));
        await screen.findByText("task-first");
        expect(screen.getByText("Including subfolders · 3 open")).toBeTruthy();
        expect(
            screen
                .getAllByRole("heading", { level: 3 })
                .map((h) => h.textContent),
        ).toEqual([
            "Private / Projects1",
            "Private / Projects / First1",
            "Private / Projects / Last1",
        ]);
    });
    it.each([
        "added",
        "removed",
    ] as const)("reloads when an item assignment is %s inside the subtree", async (change) => {
        const present = { recordingId: "task-first", folderId: first.id };
        const organization: FolderOrganization = {
            folders: tree,
            assignments: change === "added" ? [] : [present],
        };
        rows = change === "added" ? [] : [task("task-first")];
        const view = panel(false, folder, tree, organization.assignments);
        await screen.findByText(
            change === "added" ? "No tasks in this folder" : "task-first",
        );
        fetchMock.mockClear();
        rows = change === "added" ? [task("task-first")] : [];
        view.rerender(
            <FolderTasksPanel
                folder={folder}
                organization={{
                    ...organization,
                    assignments: change === "added" ? [present] : [],
                }}
                onBack={vi.fn()}
            />,
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks?tab=all&state=open&sort=created&folder=projects",
            ),
        );
        await screen.findByText(
            change === "added" ? "task-first" : "No tasks in this folder",
        );
        expect(
            screen.getByText(
                `Including subfolders · ${change === "added" ? 1 : 0} open`,
            ),
        ).toBeTruthy();
    });
    it("keeps its query when folders and assignments outside the subtree change", async () => {
        const view = panel();
        await screen.findByText("task-first");
        fetchMock.mockClear();
        view.rerender(
            <FolderTasksPanel
                folder={folder}
                organization={{
                    folders: [
                        ...tree.map((entry) => ({ ...entry })),
                        { ...folder, id: "unrelated", name: "Archive" },
                    ],
                    assignments: [
                        ...assignments.toReversed(),
                        { recordingId: "outside", folderId: "unrelated" },
                    ],
                }}
                onBack={vi.fn()}
            />,
        );
        await act(async () => {});
        expect(fetchMock).not.toHaveBeenCalledWith(
            expect.stringMatching(/^\/api\/tasks\?/),
        );
        expect(screen.getByText("task-first")).toBeTruthy();
        expect(screen.getByText("Including subfolders · 3 open")).toBeTruthy();
    });
    it("defaults to All, groups by tree order with adjacent counts, and carries TaskRow handlers and links", async () => {
        panel();
        await screen.findByText("task-first");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/tasks?tab=all&state=open&sort=created&folder=projects",
        );
        expect(fetchMock).toHaveBeenCalledWith("/api/tasks/assignees?tab=all");
        expect(
            screen
                .getByRole("button", { name: "All" })
                .getAttribute("aria-pressed"),
        ).toBe("true");
        expect(
            screen.getByText("Including subfolders", { exact: false })
                .textContent,
        ).toBe("Including subfolders · 3 open");
        expect(
            screen
                .getAllByRole("heading", { level: 3 })
                .map((heading) => heading.textContent),
        ).toEqual([
            "Private / Projects1",
            "Private / Projects / First1",
            "Private / Projects / Last1",
        ]);
        for (const heading of screen.getAllByRole("heading", { level: 3 })) {
            expect(heading.lastElementChild?.className).toContain(
                "text-muted-foreground",
            );
            expect(heading.lastElementChild?.className).not.toContain(
                "ml-auto",
            );
        }
        const props = rowProps.get("task-first");
        expect(props?.folders).toBe(tree);
        expect(props?.recording).toEqual(rows[1].recording);
        expect(props?.evidence).toBeNull();
        expect(props?.organizationOnly).toBe(true);
        expect(props?.onMerge).toBeTypeOf("function");
        expect(props?.onFollow).toBeTypeOf("function");
        expect(
            screen
                .getByRole("link", { name: "Open in Tasks" })
                .getAttribute("href"),
        ).toBe("/tasks?folder=projects&tab=all");
    });
    it("switches scopes, assignee and state filters and retains the scope in the link", async () => {
        panel();
        await screen.findByText("task-first");
        fireEvent.click(screen.getByRole("button", { name: "Mine" }));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks?tab=mine&state=open&sort=created&folder=projects",
            ),
        );
        expect(screen.queryByRole("combobox", { name: "Assignee" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Followed" }));
        expect(screen.queryByRole("button", { name: "Add task" })).toBeNull();
        fireEvent.keyDown(screen.getByRole("combobox", { name: "Assignee" }), {
            key: "ArrowDown",
        });
        fireEvent.click(
            await screen.findByRole("option", { name: "Lada Cloudfern" }),
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks?tab=followed&state=open&sort=created&folder=projects&assignee=person",
            ),
        );
        fireEvent.keyDown(screen.getByRole("combobox", { name: "State" }), {
            key: "ArrowDown",
        });
        fireEvent.click(await screen.findByRole("option", { name: "Done" }));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks?tab=followed&state=done&sort=created&folder=projects&assignee=person",
            ),
        );
        expect(screen.getByRole("link").getAttribute("href")).toContain(
            "tab=followed",
        );
    });
    it("hides Mine and own-task creation for the Organization account", async () => {
        panel(true);
        await screen.findByText("task-first");
        expect(screen.queryByRole("button", { name: "Mine" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Add task" })).toBeNull();
        expect(
            screen
                .getByRole("button", { name: "All" })
                .getAttribute("aria-pressed"),
        ).toBe("true");
    });
    it("opens the first-row form with this folder, makes the trigger inert and reconciles at the top", async () => {
        panel();
        await screen.findByText("own");
        const add = screen.getByRole("button", { name: "Add task" });
        fireEvent.click(add);
        const input = screen.getByRole("textbox", { name: "Task text" });
        expect(input.closest("li")?.parentElement?.firstElementChild).toBe(
            input.closest("li"),
        );
        expect(
            screen.getByRole("combobox", { name: "Task folder" }).textContent,
        ).toContain("Projects");
        expect(add.getAttribute("aria-disabled")).toBe("true");
        expect(add.getAttribute("aria-expanded")).toBe("true");
        expect(add.classList.contains("aria-disabled:cursor-default")).toBe(
            true,
        );
        expect(
            add.classList.contains("aria-disabled:hover:bg-transparent"),
        ).toBe(true);
        screen.getByLabelText("Due date").focus();
        const focused = document.activeElement;
        fireEvent.click(add);
        expect(document.activeElement).toBe(focused);
        fireEvent.change(input, { target: { value: "New reminder" } });
        await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: "Add" })),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/tasks",
            expect.objectContaining({
                body: JSON.stringify({
                    text: "New reminder",
                    dueDate: null,
                    folderId: folder.id,
                }),
            }),
        );
        const group = screen.getAllByRole("heading", { level: 3 })[0]
            .parentElement;
        expect(
            group && within(group).getAllByRole("listitem")[0].textContent,
        ).toContain("New reminder");
        expect(rowProps.get("saved")?.task.version).toBe(9);
        expect(screen.queryByRole("textbox", { name: "Task text" })).toBeNull();
    });
    it("preserves an optimistic own task through a subtree refresh and reconciles it once", async () => {
        const view = panel();
        await screen.findByText("own");
        const add = screen.getByRole("button", { name: "Add task" });
        fireEvent.click(add);
        fireEvent.change(screen.getByRole("textbox", { name: "Task text" }), {
            target: { value: "Pending reminder" },
        });
        const saving = Promise.withResolvers<Response>();
        fetchMock.mockImplementationOnce(() => saving.promise);
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
        expect(screen.getByText("Pending reminder")).toBeTruthy();
        expect(add.getAttribute("aria-expanded")).toBe("false");
        expect(add.getAttribute("aria-disabled")).toBe("true");
        expect(add.classList.contains("aria-disabled:cursor-default")).toBe(
            true,
        );
        expect(
            add.classList.contains("aria-disabled:hover:bg-transparent"),
        ).toBe(true);
        fireEvent.click(add);
        expect(screen.queryByRole("textbox", { name: "Task text" })).toBeNull();

        fetchMock.mockClear();
        view.rerender(
            <FolderTasksPanel
                folder={folder}
                organization={{
                    folders: tree,
                    assignments: [
                        ...assignments,
                        { recordingId: "another-item", folderId: first.id },
                    ],
                }}
                onBack={vi.fn()}
            />,
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks?tab=all&state=open&sort=created&folder=projects",
            ),
        );
        await screen.findByText("Pending reminder");
        expect(screen.getByText("Including subfolders · 4 open")).toBeTruthy();
        await act(async () => {
            saving.resolve(
                Response.json({
                    ...task("saved", true, folder.id),
                    text: "Pending reminder",
                    version: 9,
                }),
            );
        });
        expect(screen.getAllByText("Pending reminder")).toHaveLength(1);
        const group = screen.getAllByRole("heading", { level: 3 })[0]
            .parentElement;
        expect(
            group && within(group).getAllByRole("listitem")[0].textContent,
        ).toContain("Pending reminder");
        expect(rowProps.get("saved")?.task.version).toBe(9);
        expect(add.getAttribute("aria-disabled")).toBe("false");
        expect(screen.getByText("Including subfolders · 4 open")).toBeTruthy();
    });
    it("preselects no own-task folder for Organization folders", async () => {
        panel(
            false,
            { ...folder, scope: "org" },
            tree.map((entry) => ({ ...entry, scope: "org" })),
        );
        await screen.findByText("own");
        fireEvent.click(screen.getByRole("button", { name: "Add task" }));
        expect(
            screen.getByRole("combobox", { name: "Task folder" }).textContent,
        ).toContain("No folder");
    });
    it("uses the saved row version and refreshes after a follow or Organization event", async () => {
        panel();
        fireEvent.click(
            await screen.findByRole("button", { name: "Complete own" }),
        );
        await waitFor(() => expect(rowProps.get("own")?.task.version).toBe(5));
        fireEvent.click(screen.getByRole("button", { name: "Complete own" }));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks/own",
                expect.objectContaining({
                    body: JSON.stringify({ status: "done", version: 5 }),
                }),
            ),
        );
        fetchMock.mockClear();
        await act(async () => rowProps.get("own")?.onFollow?.());
        expect(fetchMock).toHaveBeenCalledWith("/api/tasks/assignees?tab=all");
        fetchMock.mockClear();
        await act(async () => orgEvent.current?.());
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/tasks?tab=all&state=open&sort=created&folder=projects",
        );
    });
    it("shows loading, an empty add affordance, and a retryable failure", async () => {
        const deferred = Promise.withResolvers<Response>();
        fetchMock.mockImplementation((url: string) =>
            url.startsWith("/api/tasks?")
                ? deferred.promise
                : Promise.resolve(Response.json({ assignees: [] })),
        );
        panel(false, first);
        expect(screen.getByText("Loading tasks…")).toBeTruthy();
        await act(async () => deferred.resolve(Response.json({ tasks: [] })));
        expect(screen.getByText("No tasks in this folder")).toBeTruthy();
        expect(
            screen.getAllByRole("button", { name: "Add task" }),
        ).toHaveLength(2);
        expect(
            screen.queryByText("Including subfolders", { exact: false }),
        ).toBeNull();
        fetchMock.mockImplementation(async (url: string) =>
            url.startsWith("/api/tasks?")
                ? new Response(null, { status: 500 })
                : Response.json({ assignees: [] }),
        );
        await act(async () => orgEvent.current?.());
        expect(screen.getByRole("alert").textContent).toContain(
            "Could not load your tasks",
        );
        fetchMock.mockImplementation(async () =>
            Response.json({ tasks: [], assignees: [] }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("No tasks in this folder")).toBeTruthy();
    });
});
