// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { RecordingRow } from "@/components/dashboard/recording-row";
import { AgendaBody } from "@/components/meetings/agenda-body";
import { AttachmentAudience } from "@/components/meetings/attachment-disclosure";
import { PersonShareDialog } from "@/components/sharing/person-sharing";
import { TaskList } from "@/components/tasks/task-list";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { detail } from "@/tests/meetings/ui-fixtures";
import type { RecordingFolder } from "@/types/folder";

const mocks = vi.hoisted(() => ({
    locale: "en" as "en" | "cs-CZ",
    request: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/tasks",
    useSearchParams: () => new URLSearchParams("tab=followed"),
}));
vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => mocks.locale,
    useFormatter: () => ({
        dateTime: () => "8 November",
        list: (values: string[]) => values.join(", "),
    }),
}));
vi.mock("@/lib/events/client", () => ({ subscribeEvents: () => () => {} }));
vi.mock("@/components/tasks/routed-proposals-inbox", () => ({
    RoutedProposalsInbox: () => null,
}));
vi.mock("@/hooks/use-task-list-data", () => ({
    useTaskListData: () => ({
        tasks: [],
        folders: [],
        filterFolders: [],
        sortedAssignees: [],
    }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

function translate(
    message: string | { message: string },
    values?: TranslationValues,
) {
    return translatedSourceMessage(
        mocks.locale,
        typeof message === "string" ? message : message.message,
        values,
    );
}

const folders: RecordingFolder[] = ["Cedar", "Juniper"].map((name) => ({
    id: name.toLowerCase(),
    name,
    parentId: null,
    kind: "custom",
    scope: "personal",
    sortOrder: 0,
    version: 0,
}));
beforeEach(() => {
    mocks.locale = "en";
    mocks.request.mockReset().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", mocks.request);
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

it.each([
    "Escape",
    "outside",
])("keeps row-menu search focused through close autofocus and returns focus on %s", async (dismiss) => {
    render(
        <ConfirmDialogProvider>
            <RecordingRow
                recording={{
                    id: "recording",
                    filename: "Review",
                    duration: 0,
                    filesize: 0,
                    deviceSn: "test",
                    startTime: "2026-11-08T10:00:00Z",
                }}
                isSelected={false}
                inFlight={undefined}
                snippet={null}
                isCompact={false}
                rowPadding="p-2"
                dateTimeFormat="relative"
                onSelect={vi.fn()}
                onDelete={vi.fn()}
                registerRef={vi.fn()}
                folders={folders}
                onAssignRecording={vi.fn()}
            />
        </ConfirmDialogProvider>,
    );
    const actions = screen.getByRole("button", { name: "Row actions" });
    actions.focus();
    fireEvent.keyDown(actions, { key: "Enter" });
    const menuItem = await screen.findByRole("menuitem", {
        name: "Add to folder",
    });
    fireEvent.keyDown(menuItem, { key: "Enter" });
    await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    const search = screen.getByRole("combobox", { name: "Choose a folder" });
    expect(document.activeElement).toBe(search);
    fireEvent.change(document.activeElement as Element, {
        target: { value: "ced" },
    });
    expect(screen.getByRole("option", { name: "Cedar" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Juniper" })).toBeNull();
    if (dismiss === "Escape") fireEvent.keyDown(search, { key: "Escape" });
    else fireEvent.pointerDown(document.body);
    await waitFor(() => expect(document.activeElement).toBe(actions));
    expect(screen.queryByRole("option")).toBeNull();
});

it("asks the server to derive task-source invitees and reports skipped invitations", async () => {
    mocks.request.mockImplementation(async (_url: string, init?: RequestInit) =>
        Response.json(
            init?.method === "POST"
                ? {
                      recordingShare: {
                          invited: ["eligible"],
                          skipped: [{ userId: "inactive", reason: "inactive" }],
                      },
                  }
                : {
                      shares: [],
                      agendaTasks: {
                          count: 2,
                          title: "Last review",
                          recordingItemId: "source",
                          canInvite: true,
                      },
                  },
        ),
    );
    render(
        <PersonShareDialog
            itemId="meeting"
            kind="meeting"
            title="Agenda"
            inline
            open
            onOpenChange={vi.fn()}
        />,
    );
    fireEvent.click(
        await screen.findByRole("button", {
            name: "Invite them to the recording too",
        }),
    );
    await waitFor(() =>
        expect(mocks.request).toHaveBeenCalledWith(
            "/api/meetings/meeting/recording-shares",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    recordingItemId: "source",
                    taskSource: true,
                }),
            }),
        ),
    );
    expect(
        await screen.findByText(
            "Some people could not be invited. Existing access and invitations were kept.",
        ),
    ).toBeTruthy();
});

it.each([
    "en",
    "cs-CZ",
] as const)("describes the absorbed receiver agenda as read-only in %s", (locale) => {
    mocks.locale = locale;
    render(
        <AgendaBody
            id="agenda"
            userId="receiver"
            initial={detail({
                attachedRecording: { visible: false },
                absorbedAt: "2026-11-08T10:00:00Z",
                permissions: { view: true, edit: false, manage: false },
                receivedShare: {
                    id: "share",
                    itemId: "meeting",
                    version: 0,
                    filingFolderId: null,
                },
            })}
        />,
    );
    expect(
        screen.getByText(
            locale === "en"
                ? "Jitka Dvořáková shares this recorded agenda with you. Its points and notes are read-only. Recordings and tasks keep their own sharing."
                : "Jitka Dvořáková s vámi sdílí zaznamenanou agendu. Její body a poznámky jsou jen ke čtení. Nahrávky a úkoly mají vlastní sdílení.",
        ),
    ).toBeTruthy();
    expect(
        screen.queryByText(/You can co-edit|Můžete společně upravovat/),
    ).toBeNull();
});

it("matches the folder filter's field border, height and text to the adjacent selects", () => {
    render(<TaskList organization={false} />);
    const folder = screen.getByRole("combobox", { name: "Folder" });
    for (const name of ["State", "Due"]) {
        const select = screen.getByRole("combobox", { name });
        for (const token of ["border-input", "text-xs", "shadow-xs"]) {
            expect(select.classList.contains(token)).toBe(true);
            expect(folder.classList.contains(token)).toBe(true);
        }
        expect(select.getAttribute("data-size")).toBe("default");
    }
    expect(folder.classList.contains("h-9")).toBe(true);
    expect(folder.classList.contains("min-h-0")).toBe(true);
});

it.each([
    { organization: false, userIds: [], users: [] },
    {
        organization: false,
        userIds: ["folder-person"],
        users: [{ id: "folder-person", name: "Hana Králová" }],
    },
    { organization: true, userIds: [], users: [] },
])("renders only the supplied filing audience: $organization / $userIds", (audience) => {
    const { container } = render(<AttachmentAudience audience={audience} />);
    if (audience.organization)
        expect(container.textContent).toContain("Organization");
    else if (audience.users.length)
        expect(container.textContent).toContain("Hana Králová");
    else expect(container.textContent).toBe("");
});
