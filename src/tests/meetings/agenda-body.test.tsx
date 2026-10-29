// @vitest-environment jsdom
import {
    act,
    render as baseRender,
    cleanup,
    fireEvent,
    screen,
    waitFor,
} from "@testing-library/react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import {
    AgendaBody,
    type AgendaVariant,
} from "@/components/meetings/agenda-body";
import { MeetingRow } from "@/components/meetings/meeting-row";
import type { MeetingDetail } from "@/components/meetings/types";
import type { ErrorCode } from "@/lib/errors";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { at, detail, point, row, task } from "./ui-fixtures";

const { toastError, replace } = vi.hoisted(() => ({
    toastError: vi.fn(),
    replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: TranslationValues) =>
        translatedSourceMessage("en", text, values),
    useLocale: () => "en",
    useFormatter: () => ({
        dateTime: (value: Date) => value.toISOString().slice(0, 16),
    }),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
let server: MeetingDetail;
function render(ui: Parameters<typeof baseRender>[0]) {
    return baseRender(ui, { wrapper: ConfirmDialogProvider });
}
const fetchMock = vi.fn();
beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn();
    server = detail();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
            const body = JSON.parse(String(init.body));
            if (url.includes("/api/tasks/"))
                server = {
                    ...server,
                    version: server.version + 1,
                    tasks: server.tasks.map((entry) => ({
                        ...entry,
                        status: body.status ?? entry.status,
                    })),
                };
            else if (url.includes("/points/"))
                server = {
                    ...server,
                    version: server.version + 1,
                    points: server.points.map((entry) => ({
                        ...entry,
                        ...(body.discussed !== undefined
                            ? { discussedAt: body.discussed ? at : null }
                            : {}),
                        ...(body.note !== undefined ? { note: body.note } : {}),
                        version: entry.version + 1,
                    })),
                };
            else
                server = {
                    ...server,
                    state: body.state ?? server.state,
                    version: server.version + 1,
                };
            return Response.json({ success: true });
        }
        if (url.endsWith("/suggestions"))
            return Response.json(
                {
                    error: "Agenda suggestions are not available yet",
                    code: "CONFLICT",
                },
                { status: 409 },
            );
        return Response.json(server);
    });
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

it.each([
    ["planned", "Preparing"],
    ["live", "In progress"],
    ["held", "Agenda without recording"],
] as const)("renders the %s row state and opens the agenda", (state, label) => {
    const onSelect = vi.fn();
    render(
        <MeetingRow meeting={row({ state })} selected onSelect={onSelect} />,
    );
    expect(screen.getByText(label)).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("agenda");
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
        "true",
    );
});

it.each([
    "planned",
    "live",
    "held",
] as const)("labels an absorbed %s row as recorded and opens its meeting link", (state) => {
    const onSelect = vi.fn();
    render(
        <MeetingRow
            meeting={row({
                state,
                recordingItemId: "recording",
                liveStartedAt: at,
            })}
            selected={false}
            onSelect={onSelect}
        />,
    );
    expect(screen.getByText("Recorded")).toBeTruthy();
    for (const label of [
        "Preparing",
        "In progress",
        "Agenda without recording",
    ])
        expect(screen.queryByText(label)).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("agenda");
});

describe.each([
    "meeting",
    "live",
    "recording",
] as const)("shared agenda body: %s", (variant: AgendaVariant) => {
    async function mount(overrides: Partial<MeetingDetail> = {}) {
        server = detail({
            state: variant === "live" ? "live" : "planned",
            liveStartedAt: variant === "live" ? at : null,
            ...(variant === "recording"
                ? {
                      recordingItemId: "recording",
                      permissions: { view: true, edit: false, manage: false },
                  }
                : {}),
            invitees: [{ name: "Jitka Dvořáková" }, { name: "Dana Nováková" }],
            tasks: [
                task("Other task", "Alex Example"),
                task("Unassigned task", null),
                task("Invited task", "Jitka Dvořáková", {
                    note: "Assignee update",
                }),
            ],
            points: [point("Discuss this")],
            ...overrides,
        });
        const view = render(
            <AgendaBody
                id="agenda"
                variant={variant}
                initial={server}
                userId="owner"
            />,
        );
        await act(async () => {});
        if (variant === "recording")
            fireEvent.click(screen.getByRole("button", { name: /Agenda/ }));
        return view;
    }
    it("groups invitees first, other assignees next and unassigned last; shows taskless invitees", async () => {
        await mount();
        const names = screen
            .getAllByRole("heading", { level: 3 })
            .map((element) => element.textContent);
        expect(names[0]).toContain("Jitka Dvořáková");
        expect(names[1]).toContain("Alex Example");
        expect(names[1]).toContain("Not invited");
        expect(names[2]).toContain("No assignee");
        expect(
            screen.getByText("Invitees without tasks: Dana Nováková"),
        ).toBeTruthy();
        expect(screen.getByText("Assignee update")).toBeTruthy();
    });
    it("keeps read-only controls out of the recording variant and offers correct live/preparation actions", async () => {
        await mount();
        if (variant === "recording") {
            expect(
                screen.queryByRole("button", { name: "Start meeting" }),
            ).toBeNull();
            expect(
                screen.queryByRole("button", { name: /Remove .* from agenda/ }),
            ).toBeNull();
            expect(screen.queryByLabelText("Discussion point")).toBeNull();
            expect(
                screen.getByLabelText("Discussed: Discuss this"),
            ).toHaveProperty("disabled", true);
        } else if (variant === "live") {
            expect(
                screen.getByRole("button", { name: "End meeting" }),
            ).toBeTruthy();
            await act(async () =>
                fireEvent.click(
                    screen.getByLabelText("Discussed: Discuss this"),
                ),
            );
            await waitFor(() =>
                expect(
                    screen.getByLabelText("Discussed: Discuss this"),
                ).toHaveProperty("checked", true),
            );
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining("/points/Discuss%20this"),
                expect.objectContaining({
                    method: "PATCH",
                    body: expect.stringContaining('"discussed":true'),
                }),
            );
        } else {
            await act(async () =>
                fireEvent.click(
                    screen.getByRole("button", { name: "Start meeting" }),
                ),
            );
            await waitFor(() =>
                expect(
                    screen.getByRole("button", { name: "End meeting" }),
                ).toBeTruthy(),
            );
        }
    });
    it("uses the checkbox and the existing task route to complete live tasks", async () => {
        await mount();
        expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Add older tasks…" }) !== null,
        ).toBe(variant === "meeting");
        expect(
            screen.queryByText("Older unfinished tasks in these folders"),
        ).toBeNull();
        if (variant !== "live") return;
        await act(async () =>
            fireEvent.click(
                screen.getAllByRole("checkbox", { name: "Done" })[0],
            ),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("/api/tasks/"),
            expect.objectContaining({
                method: "PATCH",
                body: expect.stringContaining('"status":"done"'),
            }),
        );
        expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    });
    it.each([
        "planned",
        "live",
        "held",
    ] as const)("shows an unpublished recording notice and a read-only %s agenda", async (state) => {
        await mount({
            state,
            recordingItemId: "recording",
            attachedRecording: { visible: false },
            redirectTo: null,
            permissions: { view: true, edit: false, manage: false },
            aiSuggestions: { available: false, reason: null },
        });
        expect(
            screen.getByText(
                "This agenda went with the recording. You'll see the recording once its author shares it.",
            ),
        ).toBeTruthy();
        expect(screen.getByText("Discuss this")).toBeTruthy();
        expect(screen.getByLabelText("Discussed: Discuss this")).toHaveProperty(
            "disabled",
            true,
        );
        for (const name of [
            "Start meeting",
            "End meeting",
            "Suggest points",
            "Attach recording…",
            "Done",
        ])
            expect(screen.queryByRole("button", { name })).toBeNull();
        expect(screen.queryByLabelText("Discussion point")).toBeNull();
        expect(
            screen.queryByText(/The meeting ended without a recording/),
        ).toBeNull();
        expect(replace).not.toHaveBeenCalled();
    });
    it("opens a visible recording through the server redirect", async () => {
        await mount({
            recordingItemId: "recording",
            attachedRecording: { visible: true },
            redirectTo: "/dashboard?recording=recording&view=org",
            permissions: { view: true, edit: false, manage: false },
        });
        if (variant === "recording") expect(replace).not.toHaveBeenCalled();
        else
            expect(replace).toHaveBeenCalledWith(
                "/dashboard?recording=recording&view=org",
            );
        expect(
            screen.queryByText(/This agenda went with the recording/),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Suggest points" }),
        ).toBeNull();
    });
});
it("shows the server's unavailable AI suggestions error as a toast", async () => {
    render(<AgendaBody id="agenda" initial={server} userId="owner" />);
    await act(async () => {});
    expect(
        screen.getByRole("button", { name: "Suggest points" }),
    ).toHaveProperty("disabled", false);
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Suggest points" })),
    );
    expect(toastError).toHaveBeenCalledWith(
        "Someone else changed this agenda. Your input is kept. Review their changes and try again.",
    );
});
it.each([
    [
        "CONFLICT",
        "Choose a default processing profile before running this step",
        "Choose a default processing profile to suggest points.",
    ],
    [
        "CONFLICT",
        "The profile pin is disabled",
        "The selected summary provider is disabled. Enable it or update the processing profile.",
    ],
    [
        "AI_PROVIDER_NOT_CONFIGURED",
        "No AI provider configured",
        "Configure the processing profile’s summary provider and its default model to suggest points.",
    ],
    [
        "FORBIDDEN",
        "Provider access denied",
        "Your Organization access does not permit using the selected summary provider.",
    ],
    [
        "NOT_FOUND",
        "Folder not found",
        "The agenda folder or selected summary provider is unavailable. Check the folder and processing profile.",
    ],
    [
        "INVALID_INPUT",
        "Provider cannot run summary",
        "Choose a chat provider for summaries in the processing profile to suggest points.",
    ],
] as const)("disables suggestions with visible localized help for %s: %s", async (errorCode, reason, help) => {
    server = detail({
        aiSuggestions: {
            available: false,
            reason,
            errorCode: errorCode as ErrorCode,
        },
    });
    render(<AgendaBody id="agenda" initial={server} userId="owner" />);
    await act(async () => {});
    const button = screen.getByRole("button", { name: "Suggest points" });
    expect(button).toHaveProperty("disabled", true);
    const helper = screen.getByText(help);
    expect(helper.hidden).toBe(false);
    expect(button.getAttribute("aria-describedby")).toBe(helper.id);
    fireEvent.click(button);
    expect(
        fetchMock.mock.calls.some(([url]) =>
            String(url).endsWith("/suggestions"),
        ),
    ).toBe(false);
});
it("does not let a non-manager start or end a meeting", async () => {
    server = detail({ permissions: { view: true, edit: true, manage: false } });
    render(<AgendaBody id="agenda" initial={server} userId="other" />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Start meeting" })).toBeNull();
});

it("adds a point when randomUUID is unavailable on an HTTP installation", async () => {
    vi.stubGlobal("crypto", {
        getRandomValues: globalThis.crypto.getRandomValues.bind(
            globalThis.crypto,
        ),
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/points") && init?.method === "POST") {
            const body = JSON.parse(String(init.body));
            server = {
                ...server,
                version: server.version + 1,
                points: [...server.points, point(body.text)],
            };
            return Response.json(server.points.at(-1));
        }
        return Response.json(server);
    });
    render(<AgendaBody id="agenda" initial={server} userId="owner" />);
    fireEvent.click(screen.getByRole("button", { name: "Add a point…" }));
    const input = screen.getByLabelText("New discussion point");
    fireEvent.change(input, { target: { value: "Review migration dates" } });
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(screen.getByDisplayValue("Review migration dates")).toHaveProperty(
        "value",
        "Review migration dates",
    );
    expect(toastError).not.toHaveBeenCalled();
});

it("offers one task source per recording across personal and Organization views", () => {
    const recording = {
        id: "source",
        filename: "Previous meeting",
        duration: 60000,
        filesize: 0,
        startTime: at,
        deviceSn: "test",
    };
    render(
        <AgendaBody
            id="agenda"
            initial={server}
            recordings={[recording, { ...recording, view: "org" }]}
        />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Task source" }));
    expect(
        screen.getAllByRole("option", { name: /Previous meeting/ }),
    ).toHaveLength(1);
});

it.each([
    [1, 1, "1 úkol · 1 hotový"],
    [3, 2, "3 úkoly · 2 hotové"],
    [5, 0, "5 úkolů · 0 hotových"],
])("uses Czech count forms for %s tasks and %s done", (count, done, expected) => {
    expect(
        translatedSourceMessage(
            "cs-CZ",
            "{count, plural, one {# task} other {# tasks}} · {done, number} done",
            { count, done },
        ),
    ).toBe(expected);
});

it.each([
    [1, "1 bod", "1 pozvaný", "1 nahrávka ve složce"],
    [3, "3 body", "3 pozvaní", "3 nahrávky ve složce"],
    [5, "5 bodů", "5 pozvaných", "5 nahrávek ve složce"],
])("uses Czech forms in all meeting counts for %s", (count, points, invitees, recordings) => {
    expect(
        translatedSourceMessage(
            "cs-CZ",
            "{count, plural, one {# point} other {# points}}",
            { count },
        ),
    ).toBe(points);
    expect(
        translatedSourceMessage(
            "cs-CZ",
            "{count, plural, one {# invitee} other {# invitees}}",
            { count },
        ),
    ).toBe(invitees);
    expect(
        translatedSourceMessage(
            "cs-CZ",
            "{count, plural, one {# recording in this folder} other {# recordings in this folder}}",
            { count },
        ),
    ).toBe(recordings);
});

it("keeps other task rows editable while one save waits", async () => {
    let finish: (response: Response) => void = () => {};
    server = detail({ tasks: [task("First", null), task("Second", null)] });
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
        init?.method === "PATCH"
            ? new Promise<Response>((resolve) => {
                  finish = resolve;
              })
            : Promise.resolve(Response.json(server)),
    );
    render(<AgendaBody id="agenda" initial={server} userId="owner" />);
    fireEvent.click(
        screen.getByRole("button", { name: "Remove First from agenda" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
        screen
            .getByText("Second")
            .closest("li")
            ?.querySelector("input[type=checkbox]")
            ?.getAttribute("disabled"),
    ).toBeNull();
    expect(
        screen.getByRole("button", { name: "Remove Second from agenda" }),
    ).toHaveProperty("disabled", false);
    await act(async () => finish(Response.json({ success: true })));
});
it.each([
    [1, 0, "1 task · 0 done"],
    [2, 1, "2 tasks · 1 done"],
])("uses English task plurals for %s", (count, done, expected) => {
    expect(
        translatedSourceMessage(
            "en",
            "{count, plural, one {# task} other {# tasks}} · {done, number} done",
            { count, done },
        ),
    ).toBe(expected);
});
it("keeps a hidden absorbed agenda read-only when its recording id is redacted", async () => {
    server = detail({
        recordingItemId: null,
        attachedRecording: { visible: false },
        state: "held",
        permissions: { view: true, edit: false, manage: false },
    });
    render(<AgendaBody id="agenda" initial={server} userId="other" />);
    expect(screen.getByText("Recorded")).toBeTruthy();
    expect(
        screen.queryByText(/The meeting ended without a recording/),
    ).toBeNull();
});

it("shows agenda badges and the labelled meeting note outside hover tools, with icon actions", async () => {
    server = detail({
        liveStartedAt: at,
        tasks: [
            task("Follow up", null, {
                agendaOrigin: "older",
                statusChangedAt: at,
                agendaNote: "Meeting update",
            }),
        ],
    });
    render(<AgendaBody id="agenda" initial={server} userId="owner" />);
    for (const label of ["Older", "Changed during the meeting"]) {
        const badge = screen.getByText(label);
        expect(badge.closest(".task-row-hover-actions")).toBeNull();
        expect(badge.closest(".task-row-pills")).toBeTruthy();
        expect(badge.querySelector("svg")).toBeTruthy();
    }
    expect(
        screen.getByText("Meeting update").closest(".task-row-pills"),
    ).toBeNull();
    expect(screen.getByText("Meeting note")).toBeTruthy();
    for (const label of ["Meeting note", "Remove Follow up from agenda"]) {
        const button = screen.getByRole("button", { name: label });
        expect(button.textContent).toBe("");
        expect(button.querySelector("svg")).toBeTruthy();
        expect(button.closest(".task-row-hover-actions")).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Meeting note" }));
    const editor = screen.getByRole("textbox", {
        name: "Meeting note for Follow up",
    });
    expect(document.activeElement).toBe(editor);
    expect(editor.closest(".task-row-pills")).toBeNull();
    fireEvent.change(editor, { target: { value: "  Updated note  " } });
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Save" })),
    );
    expect(fetchMock).toHaveBeenCalledWith(
        "/api/meetings/agenda/tasks/Follow%20up",
        expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ note: "Updated note" }),
        }),
    );
    expect(
        screen.queryByRole("textbox", { name: "Meeting note for Follow up" }),
    ).toBeNull();
});

it("keeps meeting notes visible to viewers without offering edits or older tasks", () => {
    server = detail({
        permissions: { view: true, edit: false, manage: false },
        tasks: [task("Follow up", null, { agendaNote: "Meeting update" })],
    });
    render(<AgendaBody id="agenda" initial={server} userId="viewer" />);
    expect(screen.getByText("Meeting update")).toBeTruthy();
    for (const name of [
        "Meeting note",
        "Remove Follow up from agenda",
        "Add older tasks…",
    ])
        expect(screen.queryByRole("button", { name })).toBeNull();
});

it("does not complete tasks in live mode without agenda editing permission", () => {
    server = detail({
        state: "live",
        permissions: { view: true, edit: false, manage: false },
        tasks: [task("Follow up", null)],
    });
    render(<AgendaBody id="agenda" initial={server} userId="viewer" />);
    expect(screen.queryByRole("checkbox", { name: "Done" })).toBeNull();
    expect(screen.getByRole("img", { name: "Open" })).toBeTruthy();
});
