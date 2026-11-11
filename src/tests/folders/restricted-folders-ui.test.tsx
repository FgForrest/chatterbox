// @vitest-environment jsdom

import {
    act,
    cleanup,
    createEvent,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { IntlProvider } from "use-intl/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { FolderActionDialog } from "@/components/dashboard/folder-action-dialog";
import { FolderTree } from "@/components/dashboard/folder-tree";
import { RecordingList } from "@/components/dashboard/recording-list";
import { RecordingRow } from "@/components/dashboard/recording-row";
import {
    UploadDialog,
    uploadFolderParents,
} from "@/components/dashboard/upload-dialog";
import { FolderCombobox } from "@/components/recordings/folder-combobox";
import { RecordingFolderTags } from "@/components/recordings/recording-folder-tags";
import { FolderNoAccess } from "@/components/sharing/folder-access-request";
import { FolderRestrictionDialog } from "@/components/sharing/folder-restriction-dialog";
import { RestrictedAudienceDialog } from "@/components/sharing/restricted-audience-dialog";
import { RestrictedAudiencePicker } from "@/components/sharing/restricted-audience-picker";
import { RestrictedFolderProvider } from "@/components/sharing/restricted-folder-context";
import { SharedFolderIcon } from "@/components/sharing/shared-folder-icon";
import {
    RestrictedTaskWarning,
    restrictedTaskAssignment,
} from "@/components/tasks/restricted-task-warning";
import { useConfirmOrganizationFiling } from "@/hooks/use-confirm-organization-filing";
import { useExportRefusal } from "@/hooks/use-export-refusal";
import { recordingIdsVisibleInFolder } from "@/lib/folders/hierarchy";
import { libraryNavigation, matchFolders } from "@/lib/folders/navigation";
import { canCreateSubfolder } from "@/lib/folders/permissions";
import { messagesForLocale } from "@/lib/i18n/messages";
import { row as meetingRow } from "@/tests/meetings/ui-fixtures";
import type { RecordingFolder } from "@/types/folder";

const { refresh, errorToast } = vi.hoisted(() => ({
    refresh: vi.fn(),
    errorToast: vi.fn(),
}));
vi.mock("@/hooks/use-dashboard-refresh", () => ({
    useDashboardRefresh: () => refresh,
}));
vi.mock("@/lib/events/client", () => ({ subscribeEvents: () => () => {} }));
vi.mock("sonner", () => ({ toast: { error: errorToast, success: vi.fn() } }));
const root: RecordingFolder = {
    id: "org",
    name: "Organization",
    parentId: null,
    scope: "org",
    kind: "public",
    sortOrder: 0,
    version: 1,
};
const locked: RecordingFolder = {
    ...root,
    id: "locked",
    parentId: root.id,
    name: "Acme pilot",
    kind: "custom",
    restricted: true,
    access: true,
    restrictedRole: "member",
    managers: [{ name: "Lada Cloudfern" }],
    accessRequest: "none",
};
const openFolder: RecordingFolder = {
    ...locked,
    id: "open",
    name: "Open project",
    restricted: undefined,
    restrictedRole: undefined,
};
const record = {
    id: "item",
    filename: "Pilot call",
    duration: 1000,
    filesize: 42,
    deviceSn: "local",
    startTime: "2026-11-01T12:00:00Z",
};
const assignment = { recordingId: record.id, folderId: locked.id };
const fetchMock = vi.fn<typeof fetch>();
function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
function mount(children: ReactNode, writable = true) {
    return render(
        <IntlProvider
            locale="en"
            messages={messagesForLocale("en")}
            timeZone="UTC"
        >
            <RestrictedFolderProvider writable={writable} userId="owner">
                {children}
            </RestrictedFolderProvider>
        </IntlProvider>,
    );
}
beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset().mockResolvedValue(json({}));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
            unobserve() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

it.each([
    false,
    true,
])("uses only the restricted icon colour for completed and transitioning folders: %s", (restricting) => {
    const { container } = mount(
        <SharedFolderIcon
            folder={{
                ...locked,
                restricted: restricting ? undefined : true,
                restricting: restricting ? true : undefined,
            }}
        />,
    );
    expect(
        container.querySelector(".lucide-folder-lock.text-restricted"),
    ).toBeTruthy();
    expect(container.querySelector(".text-organization")).toBeNull();
    expect(
        canCreateSubfolder({ ...locked, restricting: true }, true, true),
    ).toBe(false);
});

describe("public locked node", () => {
    it.each([
        "none",
        "pending",
        "declined",
    ] as const)("shows %s without fetching content, counts or audience", (accessRequest) => {
        mount(
            <FolderNoAccess
                folder={{
                    ...locked,
                    access: false,
                    restrictedRole: undefined,
                    accessRequest,
                }}
            />,
        );
        expect(screen.getByText("Acme pilot")).toBeTruthy();
        expect(
            screen.getByText("Audience managers: Lada Cloudfern"),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", {
                name:
                    accessRequest === "pending"
                        ? "Cancel request"
                        : "Request access",
            }),
        ).toBeTruthy();
        if (accessRequest === "pending")
            expect(
                screen.getByText(
                    "Request sent. Anyone in the audience can approve it.",
                ),
            ).toBeTruthy();
        if (accessRequest === "declined")
            expect(
                screen.getByText(
                    "Your request was declined. You can ask again.",
                ),
            ).toBeTruthy();
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("optimistically requests and cancels, then refreshes", async () => {
        let finish: (response: Response) => void = () => {};
        fetchMock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        mount(
            <FolderNoAccess
                folder={{ ...locked, access: false, managers: [] }}
            />,
        );
        expect(screen.queryByText(/Audience managers:/)).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Request access" }));
        expect(
            screen.getByText(
                "Request sent. Anyone in the audience can approve it.",
            ),
        ).toBeTruthy();
        await act(async () => finish(json({ request: { state: "pending" } })));
        fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
        await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
        expect(
            fetchMock.mock.calls.map(([url, init]) => [url, init?.method]),
        ).toEqual([
            ["/api/folders/locked/access-requests", "POST"],
            ["/api/folders/locked/access-requests", "DELETE"],
        ]);
    });
    it.each([
        403, 429,
    ])("rolls back a refused request (%s) with a localized toast", async (status) => {
        fetchMock.mockResolvedValue(
            json(
                {
                    code: status === 403 ? "FORBIDDEN" : "RATE_LIMITED",
                    error: "server text",
                },
                status,
            ),
        );
        mount(<FolderNoAccess folder={{ ...locked, access: false }} />);
        fireEvent.click(screen.getByRole("button", { name: "Request access" }));
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Request access" }),
            ).toHaveProperty("disabled", false),
        );
        expect(errorToast).toHaveBeenCalledWith(
            status === 403
                ? "You no longer have permission for this action."
                : "Too many requests. Please try again shortly.",
        );
    });
    it.each([
        "hosted",
        "local-only",
        "read-only",
    ])("hides request entry points in %s mode", () => {
        mount(<FolderNoAccess folder={{ ...locked, access: false }} />, false);
        expect(
            screen.queryByRole("button", { name: "Request access" }),
        ).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

function tree(folder = locked, curate = false, writable = true) {
    return mount(
        <FolderTree
            folders={[root, folder, openFolder]}
            assignments={[assignment]}
            recordings={[record]}
            selectedFolderId={folder.id}
            onRecent={vi.fn()}
            onSelectFolder={vi.fn()}
            onMoveFolder={vi.fn()}
            onAssignRecording={vi.fn()}
            onSettings={vi.fn()}
            canCurate={curate}
        />,
        writable,
    );
}
it.each([
    false,
    true,
])("tree keeps the lock visible, hiding counts for non-readers (%s)", (access) => {
    tree({ ...locked, access, restrictedRole: access ? "member" : undefined });
    const row = screen.getByRole("button", {
        name: access ? "Acme pilot, 1 recording" : "Acme pilot",
    });
    expect(
        row.querySelector(".lucide-folder-lock.text-restricted"),
    ).toBeTruthy();
    expect(row.textContent).toBe(access ? "Acme pilot1" : "Acme pilot");
});
it("non-reader menu offers only the request action", () => {
    tree({ ...locked, access: false, restrictedRole: undefined });
    fireEvent.pointerDown(
        screen.getByRole("button", { name: "Folder actions for Acme pilot" }),
        { button: 0, ctrlKey: false },
    );
    expect(
        screen.getByRole("menuitem", { name: "Request access" }),
    ).toBeTruthy();
    expect(screen.queryByText("Folder settings")).toBeNull();
    expect(screen.queryByText("Who can see it…")).toBeNull();
});
it.each([
    "member",
    "manager",
    "curator",
] as const)("reader menu observes the %s role", (restrictedRole) => {
    tree({ ...locked, restrictedRole });
    fireEvent.pointerDown(
        screen.getByRole("button", { name: "Folder actions for Acme pilot" }),
        { button: 0, ctrlKey: false },
    );
    expect(
        screen
            .getByRole("menuitem", { name: /New subfolder/ })
            .getAttribute("data-disabled"),
    ).not.toBeNull();
    expect(
        screen.getByText("A restricted folder has no subfolders."),
    ).toBeTruthy();
    expect(screen.getByText("Who can see it…")).toBeTruthy();
    expect(!!screen.queryByText("Open to the whole Organization…")).toBe(
        restrictedRole !== "member",
    );
});
it.each([
    false,
    true,
])("curator restriction is gated by writable mode (%s)", (writable) => {
    tree(locked, true, writable);
    fireEvent.pointerDown(
        screen.getByRole("button", { name: "Folder actions for Open project" }),
        { button: 0, ctrlKey: false },
    );
    expect(!!screen.queryByText("Restrict…")).toBe(writable);
});
it("rejects folder inside-drops and all drops onto an inaccessible folder", () => {
    tree({ ...locked, access: false }, true);
    const row = screen.getByRole("button", { name: "Acme pilot" });
    const source = screen.getByRole("button", {
        name: "Open project, 0 recordings",
    });
    const transfer = {
        types: ["application/x-riffado-folder"],
        setData: vi.fn(),
        getData: () => "open",
        effectAllowed: "move",
        dropEffect: "move",
    };
    fireEvent.dragStart(source, { dataTransfer: transfer });
    const event = createEvent.dragOver(row);
    Object.defineProperties(event, {
        dataTransfer: { value: transfer },
        clientY: { value: 20 },
    });
    fireEvent(row, event);
    expect(transfer.dropEffect).toBe("none");
});
it("disables inaccessible picker entries and keeps keyboard selection away from them", async () => {
    const select = vi.fn();
    mount(
        <FolderCombobox
            entries={matchFolders(
                [root, { ...locked, access: false }, openFolder],
                "",
            ).filter((entry) => entry.folder.kind !== "public")}
            value=""
            onValueChange={select}
        />,
    );
    fireEvent.click(screen.getByRole("combobox"));
    const row = screen.getByRole("option", { name: "Acme pilot Organization" });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(
        row.querySelector(".lucide-folder-lock.text-restricted"),
    ).toBeTruthy();
    fireEvent.click(row);
    expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByPlaceholderText("Find a folder…"), {
        key: "Enter",
    });
    await waitFor(() => expect(select).toHaveBeenCalledWith("open"));
});
it("creates a restricted subfolder with selected IDs and an immutable creator", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(
        json({
            people: [
                {
                    id: "colleague",
                    name: "Robin Fields",
                    email: "robin@example.com",
                },
            ],
        }),
    );
    mount(
        <FolderActionDialog
            folder={openFolder}
            folders={[root, openFolder]}
            action="create"
            open
            onOpenChange={vi.fn()}
            onCreate={create}
            onMove={vi.fn()}
        />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Drafts" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Restricted folder" }));
    expect(screen.getByText("you")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove you" })).toBeNull();
    expect(screen.getByText(/Everyone sees the folder's name/)).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "Robin" },
    });
    fireEvent.click(
        await screen.findByRole("button", { name: "Robin Fields" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "New subfolder" }));
    await waitFor(() =>
        expect(create).toHaveBeenCalledWith("open", "Drafts", {
            restricted: true,
            audienceUserIds: ["colleague"],
        }),
    );
});
it("hides restricted creation in non-writable mode", () => {
    mount(
        <FolderActionDialog
            folder={openFolder}
            folders={[root, openFolder]}
            action="create"
            open
            onOpenChange={vi.fn()}
            onCreate={vi.fn()}
            onMove={vi.fn()}
        />,
        false,
    );
    expect(screen.queryByRole("switch")).toBeNull();
});

const member = {
    userId: "owner",
    name: "Lada Cloudfern",
    email: "lada@example.com",
    role: "manager",
    ownsItems: true,
};
const colleague = {
    userId: "colleague",
    name: "Robin Fields",
    email: "robin@example.com",
    role: "member",
    ownsItems: false,
};
function audienceFetch(
    role: string,
    requests: {
        id: string;
        name: string;
        email: string;
        userId: string;
    }[] = [],
) {
    fetchMock.mockImplementation(async (url, init) => {
        if (init?.method && init.method !== "GET")
            return json({ updated: true, skippedUserIds: [] });
        if (String(url).endsWith("/access-requests")) return json({ requests });
        return json({ members: [member, colleague], role });
    });
}
it.each([
    "member",
    "manager",
    "curator",
])("audience removal follows %s authority and confirms contributors", async (role) => {
    audienceFetch(role);
    mount(<RestrictedAudienceDialog folder={locked} onOpenChange={vi.fn()} />);
    await screen.findByText("has items here", { exact: false });
    const remove = screen.queryAllByRole("button", { name: "Remove" });
    expect(remove.length).toBe(role === "member" ? 0 : 2);
    if (role !== "member") {
        expect(remove[0]).toHaveProperty("disabled", false);
        expect(remove[1]).toHaveProperty("disabled", false);
        fireEvent.click(remove[0]);
        const confirmation = screen.getByRole("alertdialog");
        expect(
            within(confirmation).getByText(
                "Lada Cloudfern has items in this folder. They stay here and the audience keeps seeing them; Lada Cloudfern keeps them as owner and can still take them out.",
            ),
        ).toBeTruthy();
        expect(
            fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
        ).toBe(false);
        fireEvent.click(
            within(confirmation).getByRole("button", { name: "Cancel" }),
        );
        expect(
            fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
        ).toBe(false);
        fireEvent.click(remove[0]);
        fireEvent.click(
            within(screen.getByRole("alertdialog")).getByRole("button", {
                name: "Remove",
            }),
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/folders/locked/audience",
                expect.objectContaining({
                    method: "DELETE",
                    body: JSON.stringify({ userId: "owner" }),
                }),
            ),
        );
    }
    expect(screen.getByRole("searchbox")).toBeTruthy();
});
it("does not fetch the audience for a public-only node", () => {
    mount(
        <RestrictedAudienceDialog
            folder={{ ...locked, access: false }}
            onOpenChange={vi.fn()}
        />,
    );
    expect(fetchMock).not.toHaveBeenCalled();
});
it("closes after successful self-removal without reporting the following audience refusal as a failed write", async () => {
    const close = vi.fn();
    let removed = false;
    fetchMock.mockImplementation(async (url, init) => {
        if (init?.method === "DELETE") {
            removed = true;
            return json({ updated: true });
        }
        if (removed)
            return json(
                { code: "RESTRICTED_FOLDER_NO_ACCESS", error: "no access" },
                403,
            );
        return String(url).endsWith("/access-requests")
            ? json({ requests: [] })
            : json({ members: [member], role: "manager" });
    });
    mount(<RestrictedAudienceDialog folder={locked} onOpenChange={close} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
            name: "Remove",
        }),
    );
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(errorToast).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
});
it("keeps audience add and remove hidden in read-only mode", async () => {
    audienceFetch("curator");
    mount(
        <RestrictedAudienceDialog folder={locked} onOpenChange={vi.fn()} />,
        false,
    );
    await screen.findByText("has items here", { exact: false });
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
});
it.each([
    "Approve",
    "Decline",
])("allows an audience member to %s a pending request", async (label) => {
    audienceFetch("member", [
        {
            id: "request",
            name: "Jitka Dvořáková",
            email: "jitka@example.com",
            userId: "requester",
        },
    ]);
    mount(<RestrictedAudienceDialog folder={locked} onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: label }));
    await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/folders/locked/access-requests/request",
            expect.objectContaining({
                method: "PATCH",
                body: JSON.stringify({
                    state: label === "Approve" ? "approved" : "declined",
                }),
            }),
        ),
    );
});
it("refreshes a request already decided by somebody else", async () => {
    audienceFetch("member", [
        {
            id: "request",
            name: "Robin Fields",
            email: "robin@example.com",
            userId: "requester",
        },
    ]);
    mount(<RestrictedAudienceDialog folder={locked} onOpenChange={vi.fn()} />);
    await screen.findByRole("button", { name: "Approve" });
    fetchMock.mockResolvedValueOnce(
        json(
            {
                code: "RESTRICTED_FOLDER_REQUEST_NOT_PENDING",
                error: "conflict",
            },
            409,
        ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
        expect(errorToast).toHaveBeenCalledWith(
            "This request has already been decided. The list has been refreshed.",
        ),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
});

const previewItem = {
    id: "item",
    kind: "audio",
    ownerUserId: "owner",
    ownerName: "Lada Cloudfern",
    ownerEmail: "lada@example.com",
    occurredAt: "2026-11-01T12:00:00Z",
};
it("restriction preview fixes contributors and resolves retained Almanac labels", async () => {
    fetchMock.mockImplementation(async (url) =>
        String(url).startsWith("/api/people/")
            ? json({ person: { displayName: "Jitka Dvořáková" } })
            : json({
                  items: [previewItem],
                  withdrawnItems: [previewItem],
                  retainedAlmanacAdditions: [
                      { kind: "person", targetId: "person" },
                  ],
                  exports: [{ id: "export", provider: "google-drive" }],
              }),
    );
    mount(
        <FolderRestrictionDialog
            folder={openFolder}
            folders={[root, openFolder]}
            action="restrict"
            onOpenChange={vi.fn()}
        />,
    );
    expect(await screen.findByText("Jitka Dvořáková")).toBeTruthy();
    expect(screen.getByText("Recordings: 1")).toBeTruthy();
    expect(screen.getByText("google-drive")).toBeTruthy();
    expect(
        screen.queryByRole("button", { name: "Remove Lada Cloudfern" }),
    ).toBeNull();
    expect(
        screen
            .getByRole("link", { name: "Review additions from sharing" })
            .getAttribute("href"),
    ).toBe("/almanac/care?section=shares");
});
it("a folder with children gets an explanation instead of a restrict form", () => {
    mount(
        <FolderRestrictionDialog
            folder={openFolder}
            folders={[root, openFolder, { ...locked, parentId: openFolder.id }]}
            action="restrict"
            onOpenChange={vi.fn()}
        />,
    );
    expect(
        screen.getByText(/Move this folder's subfolders elsewhere first/),
    ).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
});
it("lift preview distinguishes released, waiting and retention-reached items", async () => {
    const released = {
        ...previewItem,
        problems: [],
        reachedByOrganizationRetention: true,
        graceEndsAt: "2026-12-11T12:00:00Z",
    };
    const waiting = {
        ...released,
        id: "waiting",
        ownerName: "Robin Fields",
        problems: [{ code: "unresolved_speakers" }],
        reachedByOrganizationRetention: false,
    };
    fetchMock.mockResolvedValue(
        json({
            items: [released, waiting],
            sharedNow: [released],
            pending: [waiting],
            graceEndsAt: released.graceEndsAt,
        }),
    );
    mount(
        <FolderRestrictionDialog
            folder={locked}
            folders={[root, locked]}
            action="lift"
            onOpenChange={vi.fn()}
        />,
    );
    expect(await screen.findByText("Shared now: 1")).toBeTruthy();
    expect(screen.getByText("Waiting for their owner: 1")).toBeTruthy();
    expect(screen.getByText(/The 30-day grace ends on/)).toBeTruthy();
    expect(
        screen.getByText(/Restricting the folder again cannot recall/),
    ).toBeTruthy();
});
it("stale restrict authority closes the dialog and refreshes", async () => {
    const close = vi.fn();
    fetchMock.mockResolvedValue(
        json({ code: "FORBIDDEN", error: "forbidden" }, 403),
    );
    mount(
        <FolderRestrictionDialog
            folder={openFolder}
            folders={[root, openFolder]}
            action="restrict"
            onOpenChange={close}
        />,
    );
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(refresh).toHaveBeenCalled();
});

it("a restricted item header shows the path and only the authorized reader projection", async () => {
    fetchMock.mockResolvedValue(
        json({
            restricted: true,
            organization: false,
            ownerUserId: "other",
            curatorsCanRead: true,
            readers: [
                {
                    userId: "other",
                    name: "Robin Fields",
                    email: "robin@example.com",
                },
            ],
        }),
    );
    const { container } = mount(
        <RecordingFolderTags
            recordingId="item"
            folders={[root, locked]}
            assignments={[assignment]}
            isOwn={false}
            onSelectFolder={vi.fn()}
            onAdd={vi.fn()}
            onRemove={vi.fn()}
        />,
    );
    expect(screen.getByText("Organization / Acme pilot")).toBeTruthy();
    expect(container.querySelector('[class~="bg-restricted/5"]')).toBeTruthy();
    expect(await screen.findByText("Visible to")).toBeTruthy();
    expect(screen.getByText("and curators")).toBeTruthy();
    expect(screen.getByText(/Speaker names are the owner's/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
        "/api/items/item/readers",
        expect.anything(),
    );
});
function Filing() {
    const confirm = useConfirmOrganizationFiling(
        [locked, openFolder],
        [assignment],
    );
    const [keep, setKeep] = useState(false);
    return (
        <>
            <button
                type="button"
                onClick={() =>
                    void Promise.resolve(confirm("item", "open"))
                        .then(setKeep)
                        .catch(() => {})
                }
            >
                File
            </button>
            <span>{keep ? "source kept" : "not filed"}</span>
        </>
    );
}
it("lets an owner outside the audience open the locked node and remove their placement without reader names", async () => {
    fetchMock.mockResolvedValue(
        json({
            restricted: true,
            organization: false,
            ownerUserId: "owner",
            curatorsCanRead: true,
            readers: [
                {
                    userId: "owner",
                    name: "Lada Cloudfern",
                    email: "lada@example.com",
                },
            ],
        }),
    );
    const select = vi.fn();
    const remove = vi.fn().mockResolvedValue(undefined);
    const inaccessible = {
        ...locked,
        access: false,
        restrictedRole: undefined,
    };
    const { container } = mount(
        <RecordingFolderTags
            recordingId="item"
            folders={[root, inaccessible]}
            assignments={[assignment]}
            isOwn
            onSelectFolder={select}
            onAdd={vi.fn()}
            onRemove={remove}
        />,
    );
    expect(
        container.querySelector(".lucide-folder-lock.text-restricted"),
    ).toBeTruthy();
    expect(
        await screen.findByText(
            "Visible to the folder's audience and curators",
        ),
    ).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(
        screen.getByRole("button", { name: "Organization / Acme pilot" }),
    );
    expect(select).toHaveBeenCalledWith(inaccessible);
    fireEvent.click(
        screen.getByRole("button", {
            name: "Remove from Organization / Acme pilot",
        }),
    );
    expect(remove).toHaveBeenCalledWith("item", "locked");
    expect(screen.queryByRole("dialog")).toBeNull();
});
it("requires confirmation before open filing and keeps the source", async () => {
    mount(
        <ConfirmDialogProvider>
            <Filing />
        </ConfirmDialogProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(
        screen.getByText(
            "Speaker names and facts reach the Organization Almanac. The item stays in the restricted folder too.",
        ),
    ).toBeTruthy();
    fireEvent.click(
        screen.getByRole("button", { name: "Share with the Organization" }),
    );
    await screen.findByText("source kept");
});
it("warns about a task assignee outside item readers and can add them", async () => {
    const assign = vi.fn();
    fetchMock
        .mockResolvedValueOnce(
            json({ people: [{ id: "colleague", email: "robin@example.com" }] }),
        )
        .mockResolvedValueOnce(json({ skippedUserIds: [] }));
    mount(
        <RestrictedTaskWarning
            assignment={{
                person: { personId: "person", name: "Robin Fields" },
                email: "robin@example.com",
                folder: locked,
            }}
            onAssign={assign}
        />,
    );
    expect(
        screen.getByText(
            "Robin Fields cannot see the folder Acme pilot, so they will not see this task.",
        ),
    ).toBeTruthy();
    fireEvent.click(
        screen.getByRole("button", { name: "Add to the audience" }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/folders/locked/audience",
        expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ userIds: ["colleague"] }),
        }),
    );
});
it("matches task assignees by primary email and ignores openly shared items", async () => {
    fetchMock.mockImplementation(async (url) =>
        String(url).includes("/readers")
            ? json({
                  restricted: true,
                  organization: false,
                  readers: [{ email: "ROBIN@example.com" }],
              })
            : String(url).includes("/people/")
              ? json({ person: { primaryEmail: "robin@example.com" } })
              : json({ folders: [locked], assignments: [assignment] }),
    );
    expect(
        await restrictedTaskAssignment("item", {
            personId: "person",
            name: "Robin Fields",
        }),
    ).toBeNull();
});
it("hides task audience additions outside writable mode but keeps Assign anyway", () => {
    mount(
        <RestrictedTaskWarning
            assignment={{
                person: { personId: "person", name: "Robin Fields" },
                email: "robin@example.com",
                folder: locked,
            }}
            onAssign={vi.fn()}
        />,
        false,
    );
    expect(
        screen.queryByRole("button", { name: "Add to the audience" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Assign anyway" })).toBeTruthy();
});
function ExportError({ code, cause }: { code: string; cause?: string }) {
    const refusal = useExportRefusal();
    const error = refusal({ code, error: "server", details: { cause } });
    return (
        <output>
            {error?.message}|{String(error?.retryable)}
        </output>
    );
}
it.each([
    ["EXPORT_LOCK_BUSY", "", "An export is busy. Retry when it finishes.|true"],
    [
        "EXPORT_REVOCATION_PENDING",
        "",
        "Restricted copies are still being removed. Retry shortly.|true",
    ],
    [
        "EXPORT_REVOCATION_BLOCKED",
        "needs_reconnect",
        "The Google account must be reconnected|false",
    ],
    [
        "EXPORT_REVOCATION_BLOCKED",
        "target_lost",
        "The export target is unavailable. Choose the target again before retrying copy removal.|false",
    ],
])("maps export refusal %s / %s", (code, cause, message) => {
    mount(<ExportError code={code} cause={cause} />);
    expect(screen.getByText(message)).toBeTruthy();
});

it("lets an ordinary member add people and reports skipped recipients by name", async () => {
    let finish: (response: Response) => void = () => {};
    fetchMock.mockImplementation(async (url, init) => {
        if (String(url).includes("/shares/people"))
            return json({
                people: [
                    {
                        id: "third",
                        name: "Jitka Dvořáková",
                        email: "jitka@example.com",
                    },
                ],
            });
        if (init?.method === "POST")
            return new Promise((resolve) => {
                finish = resolve;
            });
        if (String(url).endsWith("/access-requests"))
            return json({ requests: [] });
        return json({ members: [member], role: "member" });
    });
    mount(<RestrictedAudienceDialog folder={locked} onOpenChange={vi.fn()} />);
    await screen.findByText("has items here", { exact: false });
    fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "Jitka" },
    });
    fireEvent.click(
        await screen.findByRole("button", { name: "Jitka Dvořáková" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add people" }));
    expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/folders/locked/audience",
        expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ userIds: ["third"] }),
        }),
    );
    expect(screen.getAllByText("Jitka Dvořáková").length).toBeGreaterThan(0);
    await act(async () =>
        finish(json({ skippedUserIds: ["third"], addedUserIds: [] })),
    );
    expect(errorToast).toHaveBeenCalledWith(
        "Jitka Dvořáková could not be added",
    );
});
it("rolls back removal when manager authority is lost", async () => {
    audienceFetch("manager");
    mount(<RestrictedAudienceDialog folder={locked} onOpenChange={vi.fn()} />);
    await screen.findByText("has items here", { exact: false });
    fetchMock.mockResolvedValueOnce(
        json(
            {
                code: "FORBIDDEN",
                error: "forbidden",
            },
            403,
        ),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    await waitFor(() =>
        expect(errorToast).toHaveBeenCalledWith(
            "You no longer have permission for this action.",
        ),
    );
    expect(screen.getAllByText("Robin Fields").length).toBeGreaterThan(0);
});

it("does not derive ancestor counts or activity from a stale inaccessible assignment", () => {
    const navigation = libraryNavigation(
        [root, { ...locked, access: false }],
        [assignment],
        [record],
        (folder) => folder.name,
    );
    expect(
        recordingIdsVisibleInFolder(
            [root, { ...locked, access: false }],
            [assignment],
            root,
            [record.id],
        ).size,
    ).toBe(0);
    expect(navigation.counts.get(root.id)).toBe(0);
    expect(navigation.counts.get(locked.id)).toBe(0);
    expect(navigation.activity.has(root.id)).toBe(false);
    expect(navigation.activity.has(locked.id)).toBe(false);
});

it("upload does not preselect an inaccessible folder or offer it as a creation parent", () => {
    const inaccessible = { ...locked, access: false };
    mount(
        <UploadDialog
            file={null}
            folders={[{ ...inaccessible, path: "Organization / Acme pilot" }]}
            folderParents={[]}
            open
            onOpenChange={vi.fn()}
            onUpload={vi.fn()}
            selectedFolderId="locked"
        />,
    );
    expect(screen.getByRole("combobox").textContent).toContain("File later");
    fireEvent.click(screen.getByRole("combobox"));
    expect(
        screen
            .getByRole("option", { name: /Acme pilot/ })
            .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
        uploadFolderParents(
            [root, inaccessible, locked],
            true,
            (folder) => folder.name,
        ).map((folder) => folder.id),
    ).toEqual(["org"]);
});
it("cancelling open filing keeps the item unfiled", async () => {
    mount(
        <ConfirmDialogProvider>
            <Filing />
        </ConfirmDialogProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText("not filed")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
});
it("caps each audience selection at twenty additional people", () => {
    mount(
        <RestrictedAudiencePicker
            selected={Array.from({ length: 20 }, (_, index) => ({
                id: `person-${index}`,
                name: `Invented colleague ${index}`,
                email: `person${index}@example.com`,
            }))}
            fixed={[{ id: "owner", name: "you", email: "" }]}
            onChange={vi.fn()}
        />,
    );
    expect(screen.getByRole("searchbox")).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Remove you" })).toBeNull();
});

it("closes an open tree audience dialog when the current node loses access", async () => {
    audienceFetch("member");
    const view = tree(locked);
    fireEvent.pointerDown(
        screen.getByRole("button", { name: "Folder actions for Acme pilot" }),
        { button: 0, ctrlKey: false },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Who can see it…" }));
    await screen.findByRole("dialog", { name: "Who can see it" });
    await screen.findByText("has items here", { exact: false });
    const calls = fetchMock.mock.calls.length;
    view.rerender(
        <RestrictedFolderProvider writable userId="owner">
            <FolderTree
                folders={[
                    root,
                    { ...locked, access: false, restrictedRole: undefined },
                    openFolder,
                ]}
                assignments={[]}
                recordings={[]}
                selectedFolderId="locked"
                onRecent={vi.fn()}
                onSelectFolder={vi.fn()}
                onMoveFolder={vi.fn()}
                onAssignRecording={vi.fn()}
                onSettings={vi.fn()}
            />
        </RestrictedFolderProvider>,
    );
    expect(screen.queryByRole("dialog", { name: "Who can see it" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(calls);
});

it("starts audience additions empty, excludes current members and marks the viewer", async () => {
    audienceFetch("manager");
    mount(<RestrictedAudienceDialog folder={locked} onOpenChange={vi.fn()} />);
    await screen.findByText("Lada Cloudfern (you)");
    expect(screen.getAllByText("Robin Fields")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Remove Robin/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Add people" })).toHaveProperty(
        "disabled",
        true,
    );
    fetchMock.mockResolvedValue(
        json({
            people: [
                { id: member.userId, name: member.name, email: member.email },
                {
                    id: colleague.userId,
                    name: colleague.name,
                    email: colleague.email,
                },
                {
                    id: "new",
                    name: "Jitka Dvořáková",
                    email: "jitka@example.com",
                },
            ],
        }),
    );
    fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "colleague" },
    });
    fireEvent.click(
        await screen.findByRole("button", { name: "Jitka Dvořáková" }),
    );
    expect(screen.queryByRole("button", { name: "Robin Fields" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Lada Cloudfern" })).toBeNull();
    expect(
        screen.getByRole("button", { name: "Remove Jitka Dvořáková" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add people" })).toHaveProperty(
        "disabled",
        false,
    );
});

it("gives the no-access screen a primary request, nearby help and a Recent return", () => {
    const back = vi.fn();
    mount(
        <FolderNoAccess folder={{ ...locked, access: false }} onBack={back} />,
    );
    expect(
        screen
            .getByRole("button", { name: "Request access" })
            .classList.contains("bg-primary"),
    ).toBe(true);
    expect(
        within(screen.getByRole("heading", { name: /Acme pilot/ })).getByRole(
            "button",
            { name: "Help: restricted folders" },
        ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to Recent" }));
    expect(back).toHaveBeenCalledOnce();
});

it.each([
    "lift",
    "restrict",
] as const)("uses a neutral %s menu icon", (action) => {
    tree({ ...locked, restrictedRole: "manager" }, true);
    fireEvent.pointerDown(
        screen.getByRole("button", {
            name: `Folder actions for ${action === "lift" ? locked.name : openFolder.name}`,
        }),
        { button: 0, ctrlKey: false },
    );
    const item = screen.getByRole("menuitem", {
        name:
            action === "lift" ? "Open to the whole Organization…" : "Restrict…",
    });
    expect(
        item.querySelector(
            action === "lift" ? ".lucide-lock-open" : ".lucide-lock",
        ),
    ).toBeTruthy();
    expect(
        item.querySelector(
            ".text-restricted, .text-organization, .text-primary",
        ),
    ).toBeNull();
});

it.each([
    "audio",
    "mail",
    "meeting",
])("hides zero restriction counts while retaining the %s total", async (kind) => {
    fetchMock.mockResolvedValue(
        json({
            items: [previewItem],
            withdrawnItems: [{ ...previewItem, kind }],
            retainedAlmanacAdditions: [],
            exports: [],
        }),
    );
    mount(
        <FolderRestrictionDialog
            folder={openFolder}
            folders={[root, openFolder]}
            action="restrict"
            onOpenChange={vi.fn()}
        />,
    );
    expect(
        await screen.findByText(
            `${{ audio: "Recordings", mail: "Mail", meeting: "Agendas" }[kind]}: 1`,
        ),
    ).toBeTruthy();
    expect(screen.queryByText(/^(Recordings|Mail|Agendas): 0$/)).toBeNull();
    expect(screen.getByText("1 item")).toBeTruthy();
});

it("hides the empty withdrawal section", async () => {
    fetchMock.mockResolvedValue(
        json({
            items: [],
            withdrawnItems: [],
            retainedAlmanacAdditions: [],
            exports: [],
        }),
    );
    mount(
        <FolderRestrictionDialog
            folder={openFolder}
            folders={[root, openFolder]}
            action="restrict"
            onOpenChange={vi.fn()}
        />,
    );
    await screen.findByText("Who will see it");
    expect(screen.queryByText("Withdrawn from the Organization")).toBeNull();
    expect(screen.queryByText("0 items")).toBeNull();
});

it.each([
    "sharedNow",
    "pending",
    "empty",
])("hides empty lift sections for %s", async (group) => {
    const item = {
        ...previewItem,
        problems: [],
        reachedByOrganizationRetention: false,
        graceEndsAt: "2026-12-11T12:00:00Z",
    };
    fetchMock.mockResolvedValue(
        json({
            items: group === "empty" ? [] : [item],
            sharedNow: group === "sharedNow" ? [item] : [],
            pending: group === "pending" ? [item] : [],
            graceEndsAt: item.graceEndsAt,
        }),
    );
    mount(
        <FolderRestrictionDialog
            folder={locked}
            folders={[root, locked]}
            action="lift"
            onOpenChange={vi.fn()}
        />,
    );
    await screen.findByText(/Restricting the folder again cannot recall/);
    expect(
        screen.queryByText(/^(Shared now|Waiting for their owner): 0$/),
    ).toBeNull();
    expect(screen.queryByText("Organization retention")).toBeNull();
    if (group !== "empty")
        expect(
            screen.getByText(
                group === "sharedNow"
                    ? "Shared now: 1"
                    : "Waiting for their owner: 1",
            ),
        ).toBeTruthy();
});

it.each([
    "audio",
    "mail",
    "search",
])("uses restricted folder icons on %s row labels", (kind) => {
    const { container } = mount(
        <ConfirmDialogProvider>
            <RecordingRow
                recording={{
                    ...record,
                    kind: kind === "mail" ? "mail" : "audio",
                }}
                isSelected={false}
                inFlight={undefined}
                snippet={kind === "search" ? "Found content" : null}
                isCompact={false}
                rowPadding="p-2"
                dateTimeFormat="iso"
                onSelect={vi.fn()}
                onDelete={vi.fn()}
                registerRef={vi.fn()}
                folderLocations={[openFolder, locked]}
            />
        </ConfirmDialogProvider>,
    );
    const name = screen.getByText(locked.name);
    expect(
        name.parentElement?.querySelector(
            ".lucide-folder-lock.text-restricted",
        ),
    ).toBeTruthy();
    expect(
        screen
            .getByText(openFolder.name)
            .parentElement?.querySelector(".lucide-folder.text-organization"),
    ).toBeTruthy();
    expect(container.querySelectorAll(".lucide-folder-lock")).toHaveLength(1);
});

it("uses the restricted icon on the first-folder metadata fallback", () => {
    const { container } = mount(
        <ConfirmDialogProvider>
            <RecordingRow
                recording={record}
                isSelected={false}
                inFlight={undefined}
                snippet={null}
                isCompact={false}
                rowPadding="p-2"
                dateTimeFormat="iso"
                onSelect={vi.fn()}
                onDelete={vi.fn()}
                registerRef={vi.fn()}
                firstFolder={{
                    folder: locked,
                    path: "Organization / Acme pilot",
                }}
            />
        </ConfirmDialogProvider>,
    );
    expect(
        container.querySelector(
            '[title="Organization / Acme pilot"] .lucide-folder-lock.text-restricted',
        ),
    ).toBeTruthy();
});

it("passes authorized folder metadata to agenda rows", () => {
    vi.stubGlobal(
        "IntersectionObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
    const { container } = mount(
        <RecordingList
            recordings={[]}
            meetings={[
                meetingRow({
                    folders: [
                        {
                            id: locked.id,
                            name: locked.name,
                            parentId: root.id,
                            userId: "organization",
                        },
                    ],
                }),
            ]}
            onSelectMeeting={vi.fn()}
            transcriptions={new Map()}
            currentRecording={null}
            pendingUploads={[]}
            inFlightActions={new Map()}
            onSelect={vi.fn()}
            onDelete={vi.fn()}
            initialDateTimeFormat="iso"
            initialSortOrder="newest"
            initialChunkSize={20}
            folders={[root, locked]}
        />,
    );
    expect(screen.getByText(locked.name)).toBeTruthy();
    expect(
        container.querySelector(".lucide-folder-lock.text-restricted"),
    ).toBeTruthy();
});
