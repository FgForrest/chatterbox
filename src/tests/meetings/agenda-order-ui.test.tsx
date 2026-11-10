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
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { AgendaBody } from "@/components/meetings/agenda-body";
import type { MeetingDetail } from "@/components/meetings/types";
import { moveAgendaPoint } from "@/lib/meetings/point-order";
import { detail, point, task } from "./ui-fixtures";

const mocks = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
let server: MeetingDetail;
const fetchMock = vi.fn();
let finish: (() => void) | undefined;
let fail = 0;
beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
        callback();
        return 0;
    });
    mocks.error.mockReset();
    finish = undefined;
    fail = 0;
    server = detail({
        tasks: [
            task("First task", "Jitka Dvořáková", { position: 0 }),
            task("Second task", "Jitka Dvořáková", { position: 1 }),
            task("Other task", "Martin Král", { position: 2 }),
        ],
    });
    fetchMock
        .mockReset()
        .mockImplementation((_url: string, init?: RequestInit) => {
            if (init?.method === "PATCH")
                return new Promise<Response>((resolve) => {
                    finish = () => {
                        if (fail) {
                            resolve(
                                Response.json(
                                    { error: "Conflict" },
                                    { status: fail },
                                ),
                            );
                            return;
                        }
                        const body = JSON.parse(String(init.body));
                        if (body.taskGroupOrder)
                            server = {
                                ...server,
                                taskGroupOrder: body.taskGroupOrder,
                            };
                        if (body.taskIds) {
                            const positions = server.tasks
                                .filter((task) =>
                                    body.taskIds.includes(task.id),
                                )
                                .map((task) => task.position)
                                .sort((a, b) => a - b);
                            server = {
                                ...server,
                                tasks: server.tasks.map((task) =>
                                    body.taskIds.includes(task.id)
                                        ? {
                                              ...task,
                                              position:
                                                  positions[
                                                      body.taskIds.indexOf(
                                                          task.id,
                                                      )
                                                  ],
                                          }
                                        : task,
                                ),
                            };
                        }
                        server = { ...server, version: server.version + 1 };
                        resolve(Response.json({ success: true }));
                    };
                });
            return Promise.resolve(Response.json(server));
        });
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
function mount(
    initial = server,
    variant: "meeting" | "live" | "recording" = "meeting",
) {
    const view = render(
        <NextIntlClientProvider locale="en" timeZone="UTC">
            <ConfirmDialogProvider>
                <AgendaBody
                    id={initial.id}
                    userId="owner"
                    initial={initial}
                    variant={variant}
                />
            </ConfirmDialogProvider>
        </NextIntlClientProvider>,
    );
    return view;
}
const taskIds = () =>
    Array.from(document.querySelectorAll<HTMLElement>(".task-row")).map((row) =>
        ["First task", "Second task", "Other task"].find((text) =>
            within(row).queryByText(text),
        ),
    );
const names = () =>
    screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent);
function transfer() {
    return {
        effectAllowed: "",
        dropEffect: "",
        setData: vi.fn(),
        getData: vi.fn(),
    };
}
async function saved() {
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => finish?.());
}

it.each([
    "meeting",
    "live",
    "recording",
] as const)("uses recording widget frames and footers in %s", (variant) => {
    mount(server, variant);
    for (const name of ["1 · Task review", "2 · Discussion points"]) {
        if (variant === "recording") {
            const section = screen
                .getByRole("heading", { name })
                .closest("section");
            expect(section).toBeTruthy();
            expect(section?.querySelector("footer")).toBeNull();
            expect(section?.querySelector("[data-workflow-widget]")).toBeNull();
            continue;
        }
        const widget = screen
            .getByRole("heading", { name })
            .closest("[data-workflow-widget]");
        expect(widget?.querySelector("header")?.textContent).toBe(name);
        expect(widget?.querySelector("footer")).toBeTruthy();
        expect(widget?.querySelector("header select")).toBeNull();
    }
    if (variant !== "recording")
        expect(screen.getByText("0 done").closest("footer")).toBeTruthy();
});
it.each([
    {
        variant: "meeting",
        edit: true,
        attached: false,
        checkboxes: false,
    },
    {
        variant: "live",
        edit: true,
        attached: false,
        checkboxes: true,
    },
    {
        variant: "recording",
        edit: true,
        attached: true,
        checkboxes: true,
    },
    {
        variant: "meeting",
        edit: true,
        attached: true,
        checkboxes: true,
    },
    {
        variant: "meeting",
        edit: false,
        attached: false,
        checkboxes: false,
    },
    {
        variant: "live",
        edit: false,
        attached: false,
        checkboxes: true,
    },
] as const)("shows discussed checkboxes only in their applicable context and the points help everywhere: $variant, edit=$edit, attached=$attached", ({
    variant,
    edit,
    attached,
    checkboxes,
}) => {
    server = {
        ...server,
        permissions: { view: true, edit, manage: edit },
        ...(attached
            ? {
                  recordingItemId: "recording",
                  attachedRecording: { visible: true },
              }
            : {}),
        points: [
            point("Discussed point", {
                discussedAt: "2026-11-03T10:00:00.000Z",
            }),
            point("Pending point", { position: 1 }),
        ],
    };
    mount(server, variant);
    expect(
        screen.queryAllByRole("checkbox", { name: /^Discussed:/ }),
    ).toHaveLength(checkboxes ? 2 : 0);
    expect(
        screen.queryAllByRole("button", { name: "Keyboard shortcuts" }),
    ).toHaveLength(0);
    expect(
        screen.getAllByRole("button", {
            name: "Help: discussion points and keyboard shortcuts",
        }),
    ).toHaveLength(1);
    if (checkboxes) {
        const checked = screen.getByRole("checkbox", {
            name: "Discussed: Discussed point",
        });
        expect(checked).toHaveProperty("checked", true);
        expect(checked).toHaveProperty("disabled", attached || !edit);
        const field = within(
            screen.getByRole("group", { name: "Discussed point" }),
        );
        const text =
            field.queryByRole("textbox", { name: "Discussion point" }) ??
            field.getByText("Discussed point");
        expect(text.className).toContain("text-muted-foreground");
        expect(text.className).toContain("line-through");
    } else if (edit) {
        expect(
            screen.getAllByRole("button", { name: "Drag point" }),
        ).toHaveLength(2);
    } else {
        expect(
            screen
                .getByRole("group", { name: "Pending point" })
                .querySelector('[aria-hidden="true"]')?.textContent,
        ).toBe("•");
    }
});
it("persists each block and group separately per agenda", () => {
    let view = mount();
    fireEvent.click(
        screen.getByRole("button", { name: "Collapse tasks: Jitka Dvořáková" }),
    );
    fireEvent.click(
        screen.getByRole("button", { name: "Collapse task review" }),
    );
    fireEvent.click(
        screen.getByRole("button", { name: "Collapse discussion points" }),
    );
    view.unmount();
    view = mount();
    expect(
        screen.getByRole("button", { name: "Expand task review" }),
    ).toBeTruthy();
    expect(
        screen.getByRole("button", { name: "Expand discussion points" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand task review" }));
    expect(
        screen.getByRole("button", { name: "Expand tasks: Jitka Dvořáková" }),
    ).toBeTruthy();
    expect(screen.queryByText("First task")).toBeNull();
    view.unmount();
    mount({ ...server, id: "another" });
    expect(
        screen.getByRole("button", { name: "Collapse task review" }),
    ).toBeTruthy();
    expect(screen.getByText("First task")).toBeTruthy();
});
it("works with unavailable localStorage", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
        throw new Error("Unavailable");
    });
    mount();
    fireEvent.click(
        screen.getByRole("button", { name: "Collapse task review" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand task review" }));
    expect(screen.getByText("First task")).toBeTruthy();
});
it.each([
    "button",
    "keyboard",
    "drag",
])("reorders a task optimistically using %s", async (method) => {
    mount();
    const first = screen.getByText("First task").closest("li");
    if (!first) throw new Error("Missing task");
    if (method === "button")
        fireEvent.click(
            within(first).getByRole("button", { name: "Move task down" }),
        );
    else if (method === "keyboard")
        fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
    else {
        const dataTransfer = transfer();
        fireEvent.dragStart(
            within(
                screen.getByText("Second task").closest("li") as HTMLElement,
            ).getByRole("button", { name: "Drag task" }),
            { dataTransfer },
        );
        fireEvent.dragOver(first, { dataTransfer });
        expect(first.className).toContain("agenda-insert-before");
        fireEvent.drop(first, { dataTransfer });
    }
    expect(taskIds()).toEqual(["Second task", "First task", "Other task"]);
    expect(
        screen
            .getByText(method === "drag" ? "Task 1 of 2" : "Task 2 of 2")
            .getAttribute("aria-live"),
    ).toBe("polite");
    await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/meetings/agenda/tasks",
            expect.objectContaining({
                method: "PATCH",
                body: JSON.stringify({
                    groupKey: "jitka dvořáková",
                    taskIds: ["Second task", "First task"],
                }),
            }),
        ),
    );
    await saved();
    expect(taskIds()).toEqual(["Second task", "First task", "Other task"]);
});
it.each([
    "button",
    "keyboard",
    "drag",
])("reorders a group optimistically using %s", async (method) => {
    mount();
    const header = screen.getByRole("heading", {
        name: "Jitka Dvořáková",
    }).parentElement;
    if (!header) throw new Error("Missing header");
    if (method === "button")
        fireEvent.click(
            screen.getByRole("button", { name: "Move down: Jitka Dvořáková" }),
        );
    else if (method === "keyboard")
        fireEvent.keyDown(header, { key: "ArrowDown", altKey: true });
    else {
        const dataTransfer = transfer();
        fireEvent.dragStart(
            screen.getByRole("button", { name: "Drag tasks: Martin Král" }),
            { dataTransfer },
        );
        expect(screen.queryByText("First task")).toBeNull();
        fireEvent.dragOver(header, { dataTransfer });
        fireEvent.drop(header, { dataTransfer });
        expect(screen.getByText("First task")).toBeTruthy();
    }
    expect(names()).toEqual(["Martin Král", "Jitka Dvořáková"]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(
        String(
            fetchMock.mock.calls.find(
                ([, init]) => init?.method === "PATCH",
            )?.[1]?.body,
        ),
    );
    expect(body).toEqual({
        taskGroupOrder: ["martin král", "jitka dvořáková"],
        previous: { taskGroupOrder: [] },
    });
    await saved();
});
it("ignores cross-group task drops", () => {
    mount();
    const dataTransfer = transfer();
    fireEvent.dragStart(
        within(
            screen.getByText("First task").closest("li") as HTMLElement,
        ).getByRole("button", { name: "Drag task" }),
        { dataTransfer },
    );
    const other = screen.getByText("Other task").closest("li");
    if (!other) throw new Error("Missing row");
    fireEvent.dragOver(other, { dataTransfer });
    fireEvent.drop(other, { dataTransfer });
    expect(other.className).not.toContain("agenda-insert");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(taskIds()).toEqual(["First task", "Second task", "Other task"]);
});
it.each([
    409, 500,
])("rolls back rejected task order and toasts (%s)", async (status) => {
    fail = status;
    mount();
    fireEvent.keyDown(
        screen.getByText("First task").closest("li") as HTMLElement,
        { key: "ArrowDown", altKey: true },
    );
    expect(taskIds()[0]).toBe("Second task");
    await saved();
    expect(taskIds()[0]).toBe("First task");
    expect(mocks.error).toHaveBeenCalledWith(
        status === 409
            ? "Someone else changed this agenda. Your input is kept. Review their changes and try again."
            : "Could not save the agenda",
    );
});
it("read-only viewers see stored order and no move or drag controls", () => {
    server = {
        ...server,
        taskGroupOrder: ["martin král", "jitka dvořáková"],
        permissions: { view: true, edit: false, manage: false },
    };
    mount();
    expect(names()).toEqual(["Martin Král", "Jitka Dvořáková"]);
    expect(
        screen.queryByRole("button", { name: /Move .*up|Move .*down|Drag/ }),
    ).toBeNull();
});
it("the source pencil opens the footer combobox and Escape restores its fact without writing", () => {
    mount();
    const pencil = screen.getByRole("button", { name: "Change task source" });
    expect(pencil.closest("footer")).toBeTruthy();
    fireEvent.click(pencil);
    expect(
        screen
            .getAllByRole("combobox", { name: "Task source" })
            .find((node) => node.tagName === "BUTTON")
            ?.getAttribute("aria-expanded"),
    ).toBe("true");
    fireEvent.keyDown(screen.getByPlaceholderText("Search…"), {
        key: "Escape",
    });
    expect(screen.queryByRole("combobox", { name: "Task source" })).toBeNull();
    expect(
        screen.getByRole("button", { name: "Change task source" }),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
});

it("continues toggling when localStorage writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("Storage full");
    });
    mount();
    fireEvent.click(
        screen.getByRole("button", { name: "Collapse tasks: Jitka Dvořáková" }),
    );
    expect(screen.queryByText("First task")).toBeNull();
    fireEvent.click(
        screen.getByRole("button", { name: "Expand tasks: Jitka Dvořáková" }),
    );
    expect(screen.getByText("First task")).toBeTruthy();
});
it("rolls back rejected group order", async () => {
    fail = 409;
    mount();
    fireEvent.click(
        screen.getByRole("button", { name: "Move down: Jitka Dvořáková" }),
    );
    expect(names()).toEqual(["Martin Král", "Jitka Dvořáková"]);
    await saved();
    expect(names()).toEqual(["Jitka Dvořáková", "Martin Král"]);
    expect(mocks.error).toHaveBeenCalledWith(
        "Someone else changed this agenda. Your input is kept. Review their changes and try again.",
    );
});

it("does not show attribution for another person's task status change alone", () => {
    server = {
        ...server,
        tasks: [
            task("First task", null, {
                agendaUpdatedByUserId: "owner",
                statusChangedByUserId: "colleague",
                statusChangedAt: "2026-11-03T11:00:00.000Z",
            }),
        ],
        authors: [...server.authors, { id: "colleague", name: "Martin Král" }],
    };
    mount();
    expect(screen.queryByText(/^Changed by/)).toBeNull();
    expect(document.querySelector('[title^="Changed by"]')).toBeNull();
});

it.each([
    "meeting",
    "live",
    "recording",
] as const)("shows the point fact in the footer and collapsed line in %s", (variant) => {
    server = {
        ...server,
        points: [
            point("A", { discussedAt: "2026-11-03T10:00:00.000Z" }),
            point("B", { position: 1 }),
            point("Child", {
                parentId: "A",
                discussedAt: "2026-11-03T10:00:00.000Z",
            }),
        ],
    };
    mount(server, variant);
    if (variant === "recording") {
        expect(
            screen.queryByRole("button", {
                name: "Collapse discussion points",
            }),
        ).toBeNull();
        expect(screen.getByLabelText("Discussed: A")).toHaveProperty(
            "checked",
            true,
        );
        expect(screen.getByLabelText("Discussed: B")).toHaveProperty(
            "checked",
            false,
        );
        return;
    }
    const fact = variant === "meeting" ? "2 points" : "1 of 2 discussed";
    const widget = screen
        .getByRole("heading", { name: "2 · Discussion points" })
        .closest("[data-workflow-widget]");
    const footer = widget?.querySelector("footer");
    if (!footer) throw new Error("Missing footer");
    expect(within(footer).getByText(fact)).toBeTruthy();
    expect(footer.textContent?.startsWith(fact)).toBe(true);
    fireEvent.click(
        screen.getByRole("button", { name: "Collapse discussion points" }),
    );
    const line = screen
        .getByRole("button", { name: "Expand discussion points" })
        .closest("[data-workflow-widget-line]");
    if (!line) throw new Error("Missing collapsed line");
    expect(within(line as HTMLElement).getByText(fact)).toBeTruthy();
});
it.each([
    0, 99999,
])("moves tied or capped points optimistically with an index (%s)", async (position) => {
    server = {
        ...server,
        points: [
            point("A", { position }),
            point("B", { position: position === 0 ? 0 : 100000 }),
            point("C", { position: position === 0 ? 0 : 100000 }),
            point("Child", { parentId: "A", position: 100000 }),
        ],
    };
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.method === "PATCH")
            return new Promise<Response>((resolve) => {
                finish = () => {
                    const body = JSON.parse(String(init.body));
                    server = {
                        ...server,
                        points:
                            moveAgendaPoint(
                                server.points,
                                "A",
                                body.parentId,
                                body.siblingIndex,
                            ) ?? server.points,
                        version: server.version + 1,
                    };
                    resolve(Response.json({ success: true }));
                };
            });
        return Promise.resolve(Response.json(server));
    });
    mount();
    fireEvent.click(
        within(screen.getByRole("group", { name: "A" })).getByRole("button", {
            name: "Move point down",
        }),
    );
    const order = () =>
        screen
            .getAllByLabelText("Discussion point")
            .map((field) => (field as HTMLTextAreaElement).value);
    expect(order()).toEqual(["B", "A", "Child", "C"]);
    await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/meetings/agenda/points/A",
            expect.objectContaining({
                body: JSON.stringify({
                    parentId: null,
                    siblingIndex: 1,
                    version: 0,
                }),
            }),
        ),
    );
    await saved();
    expect(order()).toEqual(["B", "A", "Child", "C"]);
});
