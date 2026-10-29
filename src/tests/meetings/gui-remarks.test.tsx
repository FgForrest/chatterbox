// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { TranslationValues } from "use-intl";
import { IntlProvider } from "use-intl/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { LibraryLocationHeader } from "@/components/dashboard/library-location-header";
import { AgendaBody } from "@/components/meetings/agenda-body";
import { CalendarEventPicker } from "@/components/meetings/calendar-event-picker";
import { MeetingSettings } from "@/components/meetings/meeting-settings";
import type { CalendarChoices } from "@/components/meetings/types";
import { ProductNameProvider } from "@/components/product-name-provider";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import type { RecordingFolder } from "@/types/folder";
import { at, detail } from "./ui-fixtures";

const mocks = vi.hoisted(() => ({
    locale: "en" as "en" | "cs-CZ",
    push: vi.fn(),
    fetch: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: mocks.push, replace: vi.fn() }),
}));
vi.mock("next-intl", () => ({
    useExtracted: () => (message: string, values?: TranslationValues) =>
        translatedSourceMessage(mocks.locale, message, values),
    useLocale: () => mocks.locale,
    useFormatter: () => ({
        dateTime: (date: Date) => date.toISOString().slice(0, 16),
    }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const folder: RecordingFolder = {
    id: "folder",
    name: "Acme",
    parentId: null,
    scope: "personal",
    kind: "custom",
    sortOrder: 0,
    version: 0,
};
const choices: CalendarChoices = {
    reason: null,
    recurring: [
        {
            id: "event",
            title: "Weekly review",
            start: at,
            end: at,
            attendees: [],
            recordingCount: 2,
            visibleAgenda: null,
        },
    ],
    other: [
        {
            id: "other",
            title: "Project planning",
            start: at,
            end: at,
            attendees: [],
            recordingCount: 0,
            visibleAgenda: {
                id: "existing",
                author: { id: "other", name: "Dana Nováková" },
            },
        },
    ],
};
function frame(children: ReactNode, hosted = false) {
    return (
        <ProductNameProvider isHosted={hosted}>
            <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
        </ProductNameProvider>
    );
}
beforeEach(() => {
    mocks.locale = "en";
    mocks.fetch.mockReset().mockResolvedValue(Response.json(choices));
    mocks.push.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
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
    vi.clearAllMocks();
});

it("edits planned times in the resolved zone and sends UTC instants", async () => {
    const save = vi.fn().mockResolvedValue(true);
    render(
        <IntlProvider locale="en" messages={{}} timeZone="Europe/Prague">
            {frame(
                <MeetingSettings
                    detail={detail()}
                    onSave={save}
                    onDelete={vi.fn()}
                />,
            )}
        </IntlProvider>,
    );
    await act(async () =>
        fireEvent.click(
            screen.getByRole("button", { name: "Agenda settings" }),
        ),
    );
    expect(screen.getByLabelText("Start (optional)")).toHaveProperty(
        "value",
        "2026-11-03T11:00",
    );
    fireEvent.change(screen.getByLabelText("Start (optional)"), {
        target: { value: "2026-11-03T10:30" },
    });
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Save" })),
    );
    expect(save.mock.calls[0][0]).toMatchObject({
        start: "2026-11-03T09:30:00.000Z",
        previous: { start: at },
    });
});

it("orders the unchanged recording options by own folder, then newest, and searches titles", () => {
    const recording = {
        id: "outside",
        filename: "Outside latest",
        startTime: "2026-11-05T10:00:00Z",
        duration: 0,
        filesize: 0,
        deviceSn: "test",
    };
    render(
        frame(
            <AgendaBody
                id="agenda"
                initial={detail({ folderRecordingIds: ["older", "newer"] })}
                recordings={[
                    recording,
                    {
                        ...recording,
                        id: "older",
                        filename: "Folder older",
                        startTime: "2026-11-01T10:00:00Z",
                    },
                    {
                        ...recording,
                        id: "newer",
                        filename: "Folder newer",
                        startTime: at,
                    },
                    { ...recording, view: "org" },
                    {
                        ...recording,
                        id: "mail",
                        kind: "mail",
                        filename: "Mail",
                    },
                ]}
            />,
        ),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Task source" }));
    expect(
        screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
        "Automatic",
        "Folder newer2026-11-03T10:00",
        "Folder older2026-11-01T10:00",
        "Outside latest2026-11-05T10:00",
    ]);
    fireEvent.change(screen.getByPlaceholderText("Search…"), {
        target: { value: "outside" },
    });
    expect(
        screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Automatic", "Outside latest2026-11-05T10:00"]);
});

describe.each([
    "meeting",
    "live",
] as const)("shared meeting header: %s", (variant) => {
    it("puts details in the metadata line and leaves only the removable folder chip below", async () => {
        const server = detail({
            invitees: [
                { name: "Jitka Dvořáková" },
                ...Array.from({ length: 6 }, () => ({ name: "" })),
            ],
            calendarEventId: "event",
        });
        mocks.fetch.mockResolvedValue(Response.json(server));
        const { container } = render(
            frame(
                <AgendaBody
                    id="agenda"
                    variant={variant}
                    initial={server}
                    userId="owner"
                    folders={[folder]}
                />,
            ),
        );
        const metadata = container.querySelector('[data-slot="item-metadata"]');
        expect(metadata?.textContent).toContain("Invitees: Jitka Dvořáková +6");
        expect(metadata?.textContent).toContain("Calendar event");
        expect(metadata?.textContent).toContain("Editors: Jitka Dvořáková");
        expect(metadata?.closest("header")?.className).toContain(
            "border-meeting",
        );
        expect(
            within(screen.getByRole("group", { name: "Folders" })).getAllByRole(
                "button",
            ),
        ).toHaveLength(3);
        expect(
            screen.getByText("Invitees without tasks: Jitka Dvořáková +6"),
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Agenda export" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: /Google Calendar/ }),
        ).toBeNull();
        await act(async () =>
            fireEvent.click(
                screen.getByRole("button", { name: "Remove from Acme" }),
            ),
        );
        expect(mocks.fetch).toHaveBeenCalledWith(
            "/api/recordings/meeting/folders",
            expect.objectContaining({ method: "DELETE" }),
        );
    });
    it("does not allow a colleague to unfile the owner's folder", () => {
        render(
            frame(
                <AgendaBody
                    id="agenda"
                    variant={variant}
                    initial={detail()}
                    userId="colleague"
                />,
            ),
        );
        expect(
            screen.queryByRole("button", { name: "Remove from Acme" }),
        ).toBeNull();
    });
});

it("shows visible task excerpts and full titles while retaining a generic hidden source", () => {
    const text = "Review the project schedule with the working group tomorrow";
    render(
        frame(
            <AgendaBody
                id="agenda"
                initial={detail({
                    suggestionTasks: [{ id: "visible", text }],
                    suggestions: [
                        {
                            id: "suggestion",
                            agendaId: "agenda",
                            userId: "owner",
                            text: "Review schedule",
                            kind: "ai",
                            state: "open",
                            parentPointId: null,
                            originPointId: null,
                            createdByUserId: "owner",
                            sources: {
                                itemIds: [],
                                taskIds: ["visible", "hidden"],
                            },
                            createdAt: at,
                            updatedAt: at,
                        },
                    ],
                })}
            />,
        ),
    );
    expect(
        screen.getByRole("link", { name: `${text.slice(0, 40)}…` }).title,
    ).toBe(text);
    expect(screen.getByRole("link", { name: "Source task" }).title).toBe("");
    expect(
        screen
            .getByRole("button", { name: "Suggest points" })
            .querySelector("svg.lucide-wand-sparkles"),
    ).toBeTruthy();
});

it("shares the searchable event picker and prevents settings from taking another visible agenda's event", () => {
    render(
        <CalendarEventPicker
            choices={choices}
            value=""
            onValueChange={vi.fn()}
            agendaId="agenda"
            allowEmpty
        />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Calendar event" }));
    expect(screen.getAllByRole("option")[0].textContent).toBe(
        "Without a calendar event",
    );
    fireEvent.change(screen.getByPlaceholderText("Search…"), {
        target: { value: "planning" },
    });
    expect(
        screen
            .getByRole("option", { name: /Project planning/ })
            .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.queryByRole("option", { name: /Weekly review/ })).toBeNull();
});

it.each([
    true,
    false,
])("confirms deletion with accurate Czech effects, linked=%s", async (linked) => {
    mocks.locale = "cs-CZ";
    const onDelete = vi.fn().mockResolvedValue(true);
    render(
        frame(
            <MeetingSettings
                detail={detail({ calendarEventId: linked ? "event" : null })}
                onSave={vi.fn()}
                onDelete={onDelete}
            />,
        ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Nastavení agendy" }));
    fireEvent.click(screen.getByRole("button", { name: "Smazat agendu" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Smazat tuto agendu v Klepně?");
    expect(dialog.textContent).toContain("Úkoly dokončené nebo zahozené");
    expect(dialog.textContent?.includes("Událost v Google Kalendáři")).toBe(
        linked,
    );
    expect(onDelete).not.toHaveBeenCalled();
    const confirm = within(dialog).getByRole("button", {
        name: "Smazat agendu",
    });
    expect(confirm.className).toContain("bg-destructive");
    await act(async () => fireEvent.click(confirm));
    expect(onDelete).toHaveBeenCalledOnce();
});

it("keeps Calendar export accessible to a non-manager organizer", async () => {
    render(
        frame(
            <MeetingSettings
                detail={detail({
                    calendarEventId: "event",
                    canExportCalendar: true,
                    permissions: { view: true, edit: true, manage: false },
                })}
                onSave={vi.fn()}
                onDelete={vi.fn()}
            />,
            true,
        ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Agenda settings" }));
    expect(screen.queryByRole("button", { name: "Delete agenda" })).toBeNull();
    expect(screen.getByLabelText("Title")).toHaveProperty("disabled", true);
    const exportButton = screen.getByRole("button", {
        name: "Write to the Google Calendar event…",
    });
    expect(exportButton).toHaveProperty("disabled", false);
    await act(async () => fireEvent.click(exportButton));
    expect(
        screen.getByRole("dialog", { name: "Write the agenda to the event" }),
    ).toBeTruthy();
    expect(
        mocks.fetch.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);
});

it.each([
    "personal",
    "org",
] as const)("renders three plain folder action icons for %s", (scope) => {
    const current = { ...folder, scope };
    render(
        <LibraryLocationHeader
            variant="rail"
            organization={{ folders: [current], assignments: [] }}
            recordings={[]}
            folder={current}
            onNavigate={vi.fn()}
            onSettings={vi.fn()}
            onKnowledge={vi.fn()}
            knowledgeOpen
            onNewFolder={vi.fn()}
            onPrepareMeeting={vi.fn()}
            onAssign={vi.fn()}
            onMove={vi.fn()}
        />,
    );
    for (const name of ["Prepare an agenda", "Knowledge", "Folder settings"]) {
        const button = screen.getByRole("button", { name });
        expect(button.className).toContain("size-8");
        expect(button.className).toContain("hover:bg-accent");
        expect(button.classList.contains("border")).toBe(false);
    }
    const knowledge = screen.getByRole("button", { name: "Knowledge" });
    expect(knowledge.getAttribute("aria-pressed")).toBe("true");
    expect(knowledge.className).toContain("bg-accent");
    expect(knowledge.className).not.toContain("border-organization");
    expect(Boolean(knowledge.querySelector("svg.text-organization"))).toBe(
        scope === "org",
    );
});

it("uses the per-deployment English name and cancellation never deletes", () => {
    const onDelete = vi.fn();
    render(
        frame(
            <MeetingSettings
                detail={detail()}
                onSave={vi.fn()}
                onDelete={onDelete}
            />,
            true,
        ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Agenda settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete agenda" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Delete this agenda in Riffado?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onDelete).not.toHaveBeenCalled();
});

it("selects an event inside meeting settings with keyboard focus in its search field", async () => {
    const save = vi.fn().mockResolvedValue(true);
    render(
        frame(
            <MeetingSettings
                detail={detail()}
                onSave={save}
                onDelete={vi.fn()}
            />,
        ),
    );
    await act(async () =>
        fireEvent.click(
            screen.getByRole("button", { name: "Agenda settings" }),
        ),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Calendar event" }));
    const input = screen.getByPlaceholderText("Search…");
    expect(document.activeElement).toBe(input);
    expect(
        input.closest<HTMLElement>('[role="presentation"]')?.style
            .pointerEvents,
    ).toBe("auto");
    fireEvent.change(input, { target: { value: "weekly" } });
    expect(
        screen
            .getByRole("option", { name: /Weekly review/ })
            .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
        screen.getByRole("combobox", { name: "Calendar event" }).textContent,
    ).toContain("Weekly review");
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Save" })),
    );
    expect(save.mock.calls[0][0]).toEqual({
        calendarEventId: "event",
        previous: { calendarEventId: null },
    });
});

it("waits for a changed event link to be saved before permitting Calendar export", async () => {
    render(
        frame(
            <MeetingSettings
                detail={detail({
                    calendarEventId: "current",
                    canExportCalendar: true,
                })}
                onSave={vi.fn()}
                onDelete={vi.fn()}
            />,
        ),
    );
    await act(async () =>
        fireEvent.click(
            screen.getByRole("button", { name: "Agenda settings" }),
        ),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Calendar event" }));
    fireEvent.click(screen.getByRole("option", { name: /Weekly review/ }));
    expect(
        screen.getByRole("button", {
            name: "Write to the Google Calendar event…",
        }),
    ).toHaveProperty("disabled", true);
    expect(
        mocks.fetch.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);
});

it("preserves organizer export from a linked absorbed agenda through read-only settings", () => {
    render(
        frame(
            <AgendaBody
                id="agenda"
                initial={detail({
                    attachedRecording: { visible: false },
                    permissions: { view: true, edit: false, manage: false },
                    calendarEventId: "event",
                    canExportCalendar: true,
                })}
            />,
        ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Agenda settings" }));
    expect(screen.getByLabelText("Title")).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Delete agenda" })).toBeNull();
    expect(
        screen.getByRole("button", {
            name: "Write to the Google Calendar event…",
        }),
    ).toHaveProperty("disabled", false);
});
