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
import { useState } from "react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OlderTasksDialog } from "@/components/meetings/older-tasks-dialog";
import type { MeetingDetail, OlderTask } from "@/components/meetings/types";
import { useAgenda } from "@/components/meetings/use-agenda";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { at, detail, task } from "./ui-fixtures";

const { toastError, onOpenChange } = vi.hoisted(() => ({
    toastError: vi.fn(),
    onOpenChange: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: TranslationValues) =>
        translatedSourceMessage("en", text, values),
    useFormatter: () => ({
        dateTime: (date: Date) => date.toISOString().slice(0, 10),
    }),
}));

let server: MeetingDetail;
let older: OlderTask[];
const fetchMock = vi.fn();
const invited = "Jitka Dvořáková";
const other = "Dana Nováková";

function Harness() {
    const [open, setOpen] = useState(true);
    const agenda = useAgenda("agenda", server, true, false);
    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>
                Open picker
            </button>
            <output data-testid="agenda-tasks">
                {agenda.detail?.tasks
                    .map(
                        (entry) =>
                            `${entry.id}:${entry.agendaOrigin}:${entry.position}`,
                    )
                    .join(",")}
            </output>
            {agenda.detail && (
                <OlderTasksDialog
                    detail={agenda.detail}
                    open={open}
                    onOpenChange={(value) => {
                        onOpenChange(value);
                        setOpen(value);
                    }}
                    mutate={agenda.mutate}
                />
            )}
        </>
    );
}

beforeEach(() => {
    server = detail({
        invitees: [{ name: invited }],
        tasks: [task("already-added", null)],
    });
    older = [
        task("Prepare Žluťoučký report", invited, {
            recording: {
                id: "source",
                title: "Earlier meeting",
                startTime: at,
                kind: "audio",
                view: "private",
            },
            dueDate: "2026-11-05",
        }),
        task("Review dates", other),
        task("Check agenda", null),
        task("already-added", null),
    ];
    fetchMock
        .mockReset()
        .mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.includes("/older-tasks"))
                return Response.json({ tasks: older });
            if (init?.method === "POST") {
                const { taskId } = JSON.parse(String(init.body)) as {
                    taskId: string;
                };
                const entry = older.find(
                    (candidate) => candidate.id === taskId,
                );
                if (!entry) throw new Error("Unknown test task");
                server = {
                    ...server,
                    version: server.version + 1,
                    tasks: [
                        ...server.tasks,
                        {
                            ...entry,
                            agendaOrigin: "older",
                            agendaNote: null,
                            removedAt: null,
                            position: 100000,
                        },
                    ],
                };
                return Response.json({ success: true });
            }
            return Response.json(server);
        });
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

async function mount() {
    const view = render(<Harness />);
    await screen.findByRole("checkbox", { name: "Prepare Žluťoučký report" });
    return view;
}

it("groups by assignee, labels other assignees and shows source/date/due metadata", async () => {
    await mount();
    const dialog = screen.getByRole("dialog");
    expect(
        within(dialog)
            .getAllByRole("heading", { level: 3 })
            .map((heading) => heading.textContent),
    ).toEqual([invited, `${other}Not invited`, "No assignee"]);
    expect(
        within(dialog).queryByRole("checkbox", { name: "already-added" }),
    ).toBeNull();
    expect(
        screen.getByText("Earlier meeting · 2026-11-03 · 2026-11-05"),
    ).toBeTruthy();
    expect(screen.getAllByText(/No due date/)).toHaveLength(2);
    expect(dialog.querySelector(".task-row")).toBeNull();
    expect(
        screen.getByText(
            "Unfinished tasks from this agenda's folders that are not in it yet.",
        ),
    ).toBeTruthy();
});

it("searches task text without case or diacritics and preserves selections while searching", async () => {
    await mount();
    fireEvent.click(screen.getByRole("checkbox", { name: "Review dates" }));
    const search = screen.getByRole("searchbox", { name: "Search tasks" });
    fireEvent.change(search, { target: { value: "ZLUTOUCKY" } });
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(
        screen.getByRole("checkbox", { name: "Prepare Žluťoučký report" }),
    ).toBeTruthy();
    expect(screen.getByText("Selected: 1")).toBeTruthy();
    fireEvent.change(search, { target: { value: "unknown" } });
    expect(screen.getByText("Nothing matches the search.")).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    expect(
        screen.getByRole("checkbox", { name: "Review dates" }),
    ).toHaveProperty("checked", true);
});

it("switches scope through the segmented control and refetches", async () => {
    await mount();
    expect(fetchMock).toHaveBeenCalledWith(
        "/api/meetings/agenda/older-tasks?scope=invited",
        expect.objectContaining({ method: "GET" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Everyone" }));
    await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/meetings/agenda/older-tasks?scope=all",
            expect.objectContaining({ method: "GET" }),
        ),
    );
    expect(
        screen
            .getByRole("button", { name: "Everyone" })
            .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Invitees only" }));
    await waitFor(() =>
        expect(
            fetchMock.mock.calls.filter(([url]) =>
                url.endsWith("scope=invited"),
            ),
        ).toHaveLength(2),
    );
});

it("selects real checkboxes, updates the footer and adds each task in selection order", async () => {
    await mount();
    expect(screen.getByText("Nothing selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add tasks" })).toHaveProperty(
        "disabled",
        true,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Review dates" }));
    expect(screen.getByText("Selected: 1")).toBeTruthy();
    expect(
        screen
            .getByRole("checkbox", { name: "Review dates" })
            .closest("label")
            ?.classList.contains("bg-primary/10"),
    ).toBe(true);
    fireEvent.click(
        screen.getByRole("checkbox", { name: "Prepare Žluťoučký report" }),
    );
    expect(screen.getByText("Selected: 2")).toBeTruthy();
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Add 2 tasks" })),
    );
    const posts = fetchMock.mock.calls.filter(
        ([, init]) => init.method === "POST",
    );
    expect(
        posts.map(([url, init]) => [url, JSON.parse(String(init.body))]),
    ).toEqual([
        ["/api/meetings/agenda/tasks", { taskId: "Review dates" }],
        ["/api/meetings/agenda/tasks", { taskId: "Prepare Žluťoučký report" }],
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId("agenda-tasks").textContent).toContain(
        "Review dates:older:100000",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open picker" }));
    await screen.findByRole("checkbox", { name: "Check agenda" });
    expect(screen.getByText("Nothing selected")).toBeTruthy();
});

it("keeps failed tasks selected and the dialog open, continues the batch, and retries only failures", async () => {
    const base = fetchMock.getMockImplementation();
    let fail = true;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (
            fail &&
            init?.method === "POST" &&
            String(init.body).includes("Review dates")
        )
            return Promise.resolve(
                Response.json(
                    { error: "Test failure", code: "INTERNAL_ERROR" },
                    { status: 500 },
                ),
            );
        return base?.(url, init);
    });
    await mount();
    for (const name of [
        "Prepare Žluťoučký report",
        "Review dates",
        "Check agenda",
    ])
        fireEvent.click(screen.getByRole("checkbox", { name }));
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Add 3 tasks" })),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
        screen.getByRole("checkbox", { name: "Review dates" }),
    ).toHaveProperty("checked", true);
    expect(screen.getByText("Selected: 1")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Check agenda" })).toBeNull();
    expect(toastError).toHaveBeenCalledWith("Could not save the agenda");
    expect(
        fetchMock.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(3);
    fail = false;
    fetchMock.mockClear();
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Add 1 task" })),
    );
    expect(
        fetchMock.mock.calls
            .filter(([, init]) => init.method === "POST")
            .map(([, init]) => JSON.parse(String(init.body))),
    ).toEqual([{ taskId: "Review dates" }]);
    expect(screen.queryByRole("dialog")).toBeNull();
});

it("optimistically adds a task before its POST completes", async () => {
    const base = fetchMock.getMockImplementation();
    let finish = () => {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
        init?.method === "POST"
            ? new Promise<Response>((resolve) => {
                  finish = () => {
                      void base?.(url, init).then(resolve);
                  };
              })
            : base?.(url, init),
    );
    await mount();
    fireEvent.click(screen.getByRole("checkbox", { name: "Review dates" }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 task" }));
    await waitFor(() =>
        expect(screen.getByTestId("agenda-tasks").textContent).toContain(
            "Review dates:older:100000",
        ),
    );
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("cannot be dismissed while a batch is being added", async () => {
    const base = fetchMock.getMockImplementation();
    let finish = () => {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
        init?.method === "POST"
            ? new Promise<Response>((resolve) => {
                  finish = () => {
                      void base?.(url, init).then(resolve);
                  };
              })
            : base?.(url, init),
    );
    await mount();
    fireEvent.click(screen.getByRole("checkbox", { name: "Review dates" }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 task" }));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveProperty("disabled", true));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("shows loading, focuses search and closes on Escape", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    render(<Harness />);
    expect(screen.getByText("Loading tasks…")).toBeTruthy();
    expect(document.activeElement).toBe(
        screen.getByRole("searchbox", { name: "Search tasks" }),
    );
    fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("shows an error alert when loading fails", async () => {
    fetchMock.mockResolvedValue(
        Response.json({ error: "Test failure" }, { status: 500 }),
    );
    render(<Harness />);
    expect((await screen.findByRole("alert")).textContent).toBe(
        "Could not load tasks",
    );
    expect(screen.getByRole("button", { name: "Add tasks" })).toHaveProperty(
        "disabled",
        true,
    );
});

it.each([
    { tasks: [] },
    { tasks: [task("already-added", null)] },
])("shows the empty state when no eligible tasks remain", async ({ tasks }) => {
    older = tasks;
    render(<Harness />);
    expect(await screen.findByText("No older unfinished tasks")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
});

it("Cancel closes without adding and clears selection", async () => {
    await mount();
    fireEvent.click(screen.getByRole("checkbox", { name: "Review dates" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
        fetchMock.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Open picker" }));
    await screen.findByRole("checkbox", { name: "Review dates" });
    expect(screen.getByText("Nothing selected")).toBeTruthy();
});

it("traps keyboard focus inside the dialog", async () => {
    await mount();
    const first = screen.getByRole("searchbox", { name: "Search tasks" });
    const last = screen.getByRole("button", { name: "Close" });
    act(() => last.focus());
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    act(() =>
        screen
            .getByRole("button", { name: "Open picker", hidden: true })
            .focus(),
    );
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
        true,
    );
});
