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
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { RecordingList } from "@/components/dashboard/recording-list";
import { RecordingRow } from "@/components/dashboard/recording-row";
import { RecordingFolderTags } from "@/components/recordings/recording-folder-tags";
import { RestrictedAudienceDialog } from "@/components/sharing/restricted-audience-dialog";
import { RestrictedFolderProvider } from "@/components/sharing/restricted-folder-context";
import { FolderTasksPanel } from "@/components/tasks/folder-tasks-panel";
import { folderRowLocations } from "@/lib/folders/navigation";
import { row as meetingRow } from "@/tests/meetings/ui-fixtures";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

const { errorToast, refresh } = vi.hoisted(() => ({
    errorToast: vi.fn(),
    refresh: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: errorToast } }));
vi.mock("@/hooks/use-dashboard-refresh", () => ({
    useDashboardRefresh: () => refresh,
}));
vi.mock("@/hooks/use-task-list-data", () => ({
    useTaskListData: () => ({
        tasks: [
            {
                id: "task",
                own: false,
                recording: { id: "recording", view: "org" },
            },
        ],
        sortedAssignees: [],
        openCount: 1,
        selectedPrivate: null,
    }),
}));
vi.mock("@/components/tasks/task-row", () => ({
    TaskRow: () => <p>Available task</p>,
}));

const root: RecordingFolder = {
    id: "org",
    name: "Organization",
    parentId: null,
    kind: "public",
    scope: "org",
    version: 0,
    sortOrder: 0,
};
const locked: RecordingFolder = {
    ...root,
    id: "locked",
    name: "Restricted project",
    parentId: root.id,
    kind: "custom",
    restricted: true,
    access: false,
};
const open: RecordingFolder = {
    ...root,
    id: "open",
    name: "Open project",
    parentId: root.id,
    kind: "custom",
};
const folders = [root, locked, open];
const recording: Recording = {
    id: "recording",
    filename: "Available recording",
    duration: 1000,
    filesize: 42,
    deviceSn: "local",
    startTime: "2026-11-01T12:00:00Z",
    view: "org",
    isOwn: false,
    ownerName: "Robin Fields",
};
const assignments = [locked, open].map((folder) => ({
    recordingId: recording.id,
    folderId: folder.id,
}));
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock
        .mockReset()
        .mockImplementation(async () =>
            Response.json({ hits: [], complete: true, continueBefore: null }),
        );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
        "IntersectionObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function showList(props: Partial<ComponentProps<typeof RecordingList>> = {}) {
    return render(
        <ConfirmDialogProvider>
            <RecordingList
                recordings={[recording]}
                transcriptions={new Map()}
                currentRecording={null}
                pendingUploads={[]}
                inFlightActions={new Map()}
                onSelect={vi.fn()}
                onDelete={vi.fn()}
                initialDateTimeFormat="iso"
                initialSortOrder="newest"
                initialChunkSize={50}
                folders={folders}
                assignments={assignments}
                searchView="org"
                {...props}
            />
        </ConfirmDialogProvider>,
    );
}

describe.each([
    false,
    true,
])("Organization placement privacy (search=%s)", (search) => {
    it.each([
        null,
        root,
    ])("skips inaccessible first placements in location $id", async (folder) => {
        const { container } = showList({
            folder,
            rowLocations: folderRowLocations(folders, assignments, folder),
        });
        if (search) {
            fireEvent.change(
                screen.getByRole("searchbox", { name: "Search recordings" }),
                { target: { value: "Available" } },
            );
            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(
                    expect.stringContaining("view=org"),
                    expect.anything(),
                ),
            );
        }
        const row = screen.getByRole("button", { name: /Available recording/ });
        expect(within(row).getByText(open.name)).toBeTruthy();
        expect(container.textContent).not.toContain(locked.name);
        expect(container.querySelector(`[title*="${locked.name}"]`)).toBeNull();
        expect(container.querySelector(".lucide-folder-lock")).toBeNull();
    });
});

it("does not render inaccessible agenda placements", () => {
    showList({
        recordings: [],
        meetings: [
            meetingRow({
                folders: [locked, open].map((folder) => ({
                    id: folder.id,
                    name: folder.name,
                    parentId: root.id,
                    userId: "organization",
                })),
            }),
        ],
        onSelectMeeting: vi.fn(),
    });
    expect(screen.getByText(open.name)).toBeTruthy();
    expect(screen.queryByText(locked.name)).toBeNull();
});

it("filters stale row locations and first-folder metadata", () => {
    const { container } = render(
        <ConfirmDialogProvider>
            <RecordingRow
                recording={recording}
                isSelected={false}
                inFlight={undefined}
                snippet={null}
                isCompact={false}
                rowPadding="p-2"
                dateTimeFormat="iso"
                onSelect={vi.fn()}
                onDelete={vi.fn()}
                registerRef={vi.fn()}
                folderLocations={[locked, open]}
                firstFolder={{
                    folder: locked,
                    path: `Organization / ${locked.name}`,
                }}
            />
        </ConfirmDialogProvider>,
    );
    expect(screen.getByText(open.name)).toBeTruthy();
    expect(container.textContent).not.toContain(locked.name);
    expect(container.querySelector(`[title*="${locked.name}"]`)).toBeNull();
});

it("does not group an openly visible task under its inaccessible placement", () => {
    render(
        <FolderTasksPanel
            folder={root}
            organization={{ folders, assignments }}
            isOrgAccount
            onBack={vi.fn()}
        />,
    );
    expect(screen.getByText("Available task")).toBeTruthy();
    expect(screen.getByText("Organization / Open project")).toBeTruthy();
    expect(screen.queryByText(/Restricted project/)).toBeNull();
});

it.each([
    { isOwn: false, folder: { ...locked, access: true }, removable: false },
    {
        isOwn: false,
        folder: {
            ...locked,
            access: true,
            restricted: undefined,
            restricting: true,
        },
        removable: false,
    },
    { isOwn: false, folder: open, removable: true },
    { isOwn: true, folder: locked, removable: true },
    {
        isOwn: true,
        folder: { ...locked, restricted: undefined, restricting: true },
        removable: true,
    },
] satisfies {
    isOwn: boolean;
    folder: RecordingFolder;
    removable: boolean;
}[])("Organization withdrawal respects restriction and ownership: $isOwn / $folder.id / $folder.restricting", ({
    isOwn,
    folder,
    removable,
}) => {
    const remove = vi.fn().mockResolvedValue(undefined);
    render(
        <RecordingFolderTags
            recordingId={recording.id}
            kind="meeting"
            folders={[root, folder]}
            assignments={[{ recordingId: recording.id, folderId: folder.id }]}
            isOwn={isOwn}
            canWithdraw
            organizationOnly
            onSelectFolder={vi.fn()}
            onAdd={vi.fn()}
            onRemove={remove}
        />,
    );
    const button = screen.queryByRole("button", { name: /^Remove from / });
    expect(Boolean(button)).toBe(removable);
    if (button) {
        fireEvent.click(button);
        expect(remove).toHaveBeenCalledWith(recording.id, folder.id, true);
    }
});

it("hides inaccessible detail chips for another owner's item and keeps its open chip", () => {
    const { container } = render(
        <RecordingFolderTags
            recordingId={recording.id}
            folders={folders}
            assignments={assignments}
            isOwn={false}
            canWithdraw
            onSelectFolder={vi.fn()}
            onAdd={vi.fn()}
            onRemove={vi.fn()}
        />,
    );
    expect(screen.getByRole("button", { name: open.name })).toBeTruthy();
    expect(container.textContent).not.toContain(locked.name);
    expect(fetchMock).not.toHaveBeenCalled();
});

const member = {
    userId: "viewer",
    name: "Lada Cloudfern",
    email: "lada@example.com",
    role: "manager",
    ownsItems: false,
};
const colleague = {
    userId: "colleague",
    name: "Robin Fields",
    email: "robin@example.com",
    role: "member",
    ownsItems: false,
};
const newcomer = {
    id: "new",
    name: "Jitka Dvořáková",
    email: "jitka@example.com",
};

it.each([
    "add",
    "remove",
    "approve",
    "decline",
] as const)("rolls back optimistic audience %s after a rejected fetch", async (action) => {
    const close = vi.fn();
    let rejectWrite: (error: Error) => void = () => {};
    fetchMock.mockImplementation(async (url, init) => {
        if (init?.method && init.method !== "GET")
            return new Promise<Response>((_resolve, reject) => {
                rejectWrite = reject;
            });
        if (String(url).includes("/shares/people"))
            return Response.json({ people: [newcomer] });
        if (String(url).endsWith("/access-requests"))
            return Response.json({
                requests: [
                    {
                        id: "request",
                        userId: newcomer.id,
                        name: newcomer.name,
                        email: newcomer.email,
                        state: "pending",
                    },
                ],
            });
        return Response.json({ role: "manager", members: [member, colleague] });
    });
    render(
        <RestrictedFolderProvider writable userId="viewer">
            <RestrictedAudienceDialog
                folder={{ ...locked, access: true }}
                onOpenChange={close}
            />
        </RestrictedFolderProvider>,
    );
    await screen.findByText(colleague.name);
    if (action === "add") {
        fireEvent.change(screen.getByRole("searchbox"), {
            target: { value: "Jitka" },
        });
        fireEvent.click(
            await screen.findByRole("button", { name: newcomer.name }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Add people" }));
        expect(screen.getAllByText("Audience member")).toHaveLength(2);
    } else if (action === "remove") {
        fireEvent.click(
            within(
                screen.getByText(colleague.name).parentElement
                    ?.parentElement as HTMLElement,
            ).getByRole("button", { name: "Remove" }),
        );
        expect(screen.queryByText(colleague.name)).toBeNull();
    } else {
        fireEvent.click(
            screen.getByRole("button", {
                name: action === "approve" ? "Approve" : "Decline",
            }),
        );
        expect(screen.queryByText(newcomer.name)).toBeNull();
        expect(screen.getByText("No pending requests.")).toBeTruthy();
    }
    await act(async () => rejectWrite(new TypeError("Failed to fetch")));
    expect(errorToast).toHaveBeenCalledWith("Failed to fetch");
    expect(screen.getByText(colleague.name)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toHaveProperty(
        "disabled",
        false,
    );
    expect(screen.getByRole("button", { name: "Decline" })).toHaveProperty(
        "disabled",
        false,
    );
    expect(screen.getAllByText("Audience member")).toHaveLength(1);
    if (action === "add") {
        expect(
            screen.getByRole("button", { name: `Remove ${newcomer.name}` }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Add people" }),
        ).toHaveProperty("disabled", false);
    }
    expect(close).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(
        fetchMock.mock.calls.filter(
            ([, init]) => init?.method && init.method !== "GET",
        ),
    ).toHaveLength(1);
});
