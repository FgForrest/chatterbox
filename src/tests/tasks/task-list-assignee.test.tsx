// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskList } from "@/components/tasks/task-list";
import type {
    TaskAssignee,
    TaskChange,
    TaskListItem,
    TaskView,
} from "@/lib/tasks/tasks";

const { navigation, translate, orgEvent, changeTask } = vi.hoisted(() => ({
    navigation: { params: new URLSearchParams(), replace: vi.fn() },
    translate: (text: string | { message: string }) =>
        typeof text === "string" ? text : text.message,
    orgEvent: { current: null as (() => void) | null },
    changeTask: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: navigation.replace }),
    usePathname: () => "/tasks",
    useSearchParams: () => navigation.params,
}));
vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => "cs-CZ",
}));
vi.mock("@/hooks/use-org-events", () => ({
    useOrgEvents: (_enabled: boolean, callback: () => void) => {
        orgEvent.current = callback;
    },
}));
vi.mock("@/components/tasks/routed-proposals-inbox", () => ({
    RoutedProposalsInbox: () => null,
}));
vi.mock("@/components/tasks/task-api", () => ({
    changeTask,
    announceTasksChanged: vi.fn(),
    mergeTaskIntoTarget: vi.fn(),
    TaskRequestError: class extends Error {},
}));
vi.mock("@/components/tasks/task-row", () => ({
    TaskRow: ({
        task,
        onChange,
    }: {
        task: TaskListItem;
        onChange: (
            change: Omit<TaskChange, "version">,
            optimistic: Partial<TaskView>,
        ) => void;
    }) => (
        <li>
            {task.text}
            <button
                type="button"
                onClick={() =>
                    onChange({ assigneePersonId: null }, { assignee: null })
                }
            >
                Unassign task
            </button>
        </li>
    ),
}));

const firstPerson: TaskAssignee = {
    personId: "person-1",
    name: "Čira Cloudfern",
};
const secondPerson: TaskAssignee = {
    personId: "person-2",
    name: "Hela Thistlemere",
};
const item = {
    audioAvailable: true,
    id: "item-1",
    title: "Planning",
    startTime: "2026-10-20T00:00:00Z",
    view: "private" as const,
    kind: "audio" as const,
};
const task: TaskListItem = {
    id: "task-1",
    recordingId: item.id,
    evidenceItemId: item.id,
    evidenceItemKind: "audio",
    evidenceAudioAvailable: true,
    status: "open",
    text: "Send the draft",
    assignee: firstPerson,
    assigneeHasEmail: true,
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
    version: 0,
    createdAt: "2026-10-20T00:00:00Z",
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
    visibleMentionQuotes: [],
    recording: item,
    evidence: item,
};

let assignees: TaskAssignee[];
let tasks: TaskListItem[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    navigation.params = new URLSearchParams("tab=tracked");
    navigation.replace.mockReset();
    changeTask.mockReset();
    assignees = [secondPerson, firstPerson];
    tasks = [];
    HTMLElement.prototype.scrollIntoView = vi.fn();
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/tasks/assignees") return Response.json({ assignees });
        if (url.startsWith("/api/tasks?")) return Response.json({ tasks });
        if (url === "/api/folders") return Response.json({ folders: [] });
        if (url === "/api/tasks/pending") return Response.json({});
        if (url === "/api/people/person-1")
            return Response.json({ person: { displayName: firstPerson.name } });
        return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

async function openAssignee() {
    await screen.findByText("Nothing here.");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Assignee" }), {
        key: "ArrowDown",
    });
    await screen.findByRole("option", { name: "All assignees" });
}

it("marks new tasks as seen once when the Tasks page opens", async () => {
    const view = render(<TaskList organization={false} />);
    await screen.findByText("Nothing here.");
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/pending", {
        method: "POST",
    });
    fetchMock.mockClear();
    navigation.params.set("state", "done");
    view.rerender(<TaskList organization={false} />);
    await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/tasks?tab=followed&state=done&sort=created",
        ),
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/api/tasks/pending", {
        method: "POST",
    });
});

it("offers server assignees in locale order after All assignees and No assignee", async () => {
    render(<TaskList organization={false} />);
    await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/tasks/assignees"),
    );
    await openAssignee();
    expect(
        screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
        "All assignees",
        "No assignee",
        firstPerson.name,
        secondPerson.name,
    ]);
    fireEvent.click(screen.getByRole("option", { name: firstPerson.name }));
    expect(navigation.replace).toHaveBeenCalledWith(
        "/tasks?tab=tracked&assignee=person-1",
        { scroll: false },
    );
});

it("bookmarks No assignee and clears All assignees while preserving other filters", async () => {
    navigation.params = new URLSearchParams(
        "tab=tracked&state=done&folder=folder-1&due=none&sort=due",
    );
    const view = render(<TaskList organization={false} />);
    await openAssignee();
    fireEvent.click(screen.getByRole("option", { name: "No assignee" }));
    expect(navigation.replace).toHaveBeenLastCalledWith(
        "/tasks?tab=tracked&state=done&folder=folder-1&due=none&sort=due&assignee=none",
        { scroll: false },
    );
    navigation.params.set("assignee", "none");
    view.rerender(<TaskList organization={false} />);
    await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("assignee=none"),
        ),
    );
    await openAssignee();
    fireEvent.click(screen.getByRole("option", { name: "All assignees" }));
    expect(navigation.replace).toHaveBeenLastCalledWith(
        "/tasks?tab=tracked&state=done&folder=folder-1&due=none&sort=due",
        { scroll: false },
    );
});

it("combines All states with an assignee", async () => {
    navigation.params.set("assignee", "person-1");
    render(<TaskList organization={false} />);
    await screen.findByText("Nothing here.");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "State" }), {
        key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("option", { name: "All states" }));
    expect(navigation.replace).toHaveBeenCalledWith(
        "/tasks?tab=tracked&assignee=person-1&state=all",
        { scroll: false },
    );
});

it("hides and ignores the assignee on Mine, retaining it when switching tabs", async () => {
    navigation.params = new URLSearchParams("tab=tracked&assignee=person-1");
    const view = render(<TaskList organization={false} />);
    await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("assignee=person-1"),
        ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mine" }));
    expect(navigation.replace).toHaveBeenLastCalledWith(
        "/tasks?assignee=person-1",
        { scroll: false },
    );
    navigation.params.delete("tab");
    fetchMock.mockClear();
    view.rerender(<TaskList organization={false} />);
    await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/tasks?tab=mine&state=open&sort=created",
        ),
    );
    expect(screen.queryByRole("combobox", { name: "Assignee" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/tasks/assignees");
});

it("shows the filter on the Organization account's only list", async () => {
    navigation.params = new URLSearchParams();
    render(<TaskList organization />);
    await openAssignee();
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/assignees");
    expect(screen.queryByRole("button", { name: "Mine" })).toBeNull();
});

it("refreshes assignees on Organization events and retains the selected person", async () => {
    navigation.params.set("assignee", "person-1");
    render(<TaskList organization={false} />);
    await waitFor(() =>
        expect(
            screen.getByRole("combobox", { name: "Assignee" }).textContent,
        ).toContain(firstPerson.name),
    );
    fetchMock.mockClear();
    assignees = [secondPerson];
    await act(async () => {
        orgEvent.current?.();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/assignees");
    expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("assignee=person-1"),
    );
    await openAssignee();
    expect(screen.getByRole("option", { name: firstPerson.name })).toBeTruthy();
});

it("resolves a bookmarked person who no longer has tasks", async () => {
    assignees = [];
    navigation.params.set("assignee", "person-1");
    render(<TaskList organization={false} />);
    await waitFor(() =>
        expect(
            screen.getByRole("combobox", { name: "Assignee" }).textContent,
        ).toContain(firstPerson.name),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/people/person-1");
});

it("reloads tasks and options after a saved assignee change", async () => {
    navigation.params.set("assignee", "person-1");
    tasks = [task];
    changeTask.mockImplementation(async () => {
        tasks = [];
        assignees = [];
        return { ...task, version: 1, assignee: null };
    });
    render(<TaskList organization={false} />);
    await screen.findByText(task.text);
    await waitFor(() =>
        expect(
            screen.getByRole("combobox", { name: "Assignee" }).textContent,
        ).toContain(firstPerson.name),
    );
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Unassign task" }));
    await screen.findByText("Nothing here.");
    expect(changeTask).toHaveBeenCalledWith(task.id, {
        assigneePersonId: null,
        version: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/assignees");
    expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("assignee=person-1"),
    );
    expect(
        screen.getByRole("combobox", { name: "Assignee" }).textContent,
    ).toContain(firstPerson.name);
});

it.each([
    false,
    true,
])("supports All and its folder filter with organization=%s", async (organization) => {
    navigation.params = new URLSearchParams(
        "tab=all&folder=folder-1&assignee=person-1",
    );
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/tasks/assignees?tab=all")
            return Response.json({ assignees });
        if (String(input).startsWith("/api/tasks?"))
            return Response.json({ tasks: [] });
        return Response.json({ folders: [] });
    });
    render(<TaskList organization={organization} />);
    await screen.findByText("Nothing here.");
    expect(
        screen
            .getByRole("button", { name: "All" })
            .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(fetchMock).toHaveBeenCalledWith(
        "/api/tasks?tab=all&state=open&sort=created&folder=folder-1&assignee=person-1",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/assignees?tab=all");
    expect(screen.queryByRole("button", { name: "Mine" }) === null).toBe(
        organization,
    );
});

it("bookmarks the All segment explicitly", async () => {
    navigation.params = new URLSearchParams("folder=folder-1");
    render(<TaskList organization={false} />);
    await screen.findByText("Nothing here.");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(navigation.replace).toHaveBeenCalledWith(
        "/tasks?folder=folder-1&tab=all",
        { scroll: false },
    );
});
