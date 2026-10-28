// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgendaFolderTags } from "@/components/meetings/agenda-folder-tags";
import type { RecordingFolder } from "@/types/folder";
import { detail } from "./ui-fixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/recordings/folder-picker", () => ({
    FolderPicker: ({
        folders,
        assignedIds,
        onSelect,
        onOpenChange,
        title,
    }: {
        folders: RecordingFolder[];
        assignedIds: Set<string>;
        title?: string;
        onSelect: (id: string) => Promise<void>;
        onOpenChange: (open: boolean) => void;
    }) => (
        <div role="dialog" aria-label={title ?? "Choose a folder"}>
            {folders
                .filter((folder) => !assignedIds.has(folder.id))
                .map((folder) => (
                    <button
                        type="button"
                        key={folder.id}
                        onClick={() => {
                            void onSelect(folder.id).then(() =>
                                onOpenChange(false),
                            );
                        }}
                    >
                        {folder.name}
                    </button>
                ))}
        </div>
    ),
}));
afterEach(cleanup);
const folders: RecordingFolder[] = ["First", "Second", "Third"].map(
    (name, index) => ({
        id: `folder-${index}`,
        name,
        scope: "personal",
        parentId: "root",
        kind: "custom",
        sortOrder: index,
        version: 0,
    }),
);
const agenda = detail({
    folders: folders.slice(0, 2).map((folder) => ({
        id: folder.id,
        name: folder.name,
        userId: "owner",
        parentId: "root",
    })),
});

it("shows every removable chip and supports Add and Move with a source choice", async () => {
    const mutate = vi.fn().mockResolvedValue(true);
    render(
        <AgendaFolderTags
            detail={agenda}
            userId="owner"
            folders={folders}
            disabled={false}
            mutate={mutate}
        />,
    );
    expect(
        screen.getByRole("button", { name: "Remove from First" }),
    ).toBeTruthy();
    expect(
        screen.getByRole("button", { name: "Remove from Second" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to folder" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move to…" }));
    expect(screen.getByRole("dialog", { name: "Move from…" })).toBeTruthy();
    await act(async () =>
        fireEvent.click(
            within(
                screen.getByRole("dialog", { name: "Move from…" }),
            ).getByRole("button", { name: "First" }),
        ),
    );
    expect(screen.getByRole("dialog", { name: "Move to…" })).toBeTruthy();
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Third" })),
    );
    expect(mutate).toHaveBeenCalledWith(
        "/api/recordings/meeting/folders",
        "PATCH",
        { fromFolderId: "folder-0", toFolderId: "folder-2", withdraw: true },
        expect.any(Function),
    );
    await act(async () =>
        fireEvent.click(
            screen.getByRole("button", { name: "Remove from Second" }),
        ),
    );
    expect(mutate).toHaveBeenCalledWith(
        "/api/recordings/meeting/folders",
        "DELETE",
        { folderId: "folder-1", withdraw: true },
        expect.any(Function),
    );
});
it("uses a received folder's local chip name and filing ID", async () => {
    const mutate = vi.fn().mockResolvedValue(true);
    render(
        <AgendaFolderTags
            detail={detail({
                folders: [
                    {
                        id: "source",
                        name: "Original",
                        userId: "other",
                        parentId: null,
                    },
                ],
            })}
            userId="owner"
            folders={[
                {
                    ...folders[0],
                    id: "attachment",
                    name: "Local name",
                    receivedFolder: {
                        sourceFolderId: "source",
                        shareId: "share",
                        shareVersion: 0,
                        ownerName: "Colleague",
                        originalName: "Original",
                    },
                },
            ]}
            disabled={false}
            mutate={mutate}
        />,
    );
    expect(
        screen.getByRole("button", { name: "Remove from Local name" }),
    ).toBeTruthy();
    expect(
        screen.queryByRole("button", { name: "Remove from Original" }),
    ).toBeNull();
    await act(async () =>
        fireEvent.click(
            screen.getByRole("button", { name: "Remove from Local name" }),
        ),
    );
    expect(mutate).toHaveBeenCalledWith(
        "/api/recordings/meeting/folders",
        "DELETE",
        { folderId: "attachment", withdraw: true },
        expect.any(Function),
    );
    const optimistic = mutate.mock.calls[0][3];
    expect(
        optimistic(
            detail({
                folders: [
                    {
                        id: "source",
                        name: "Original",
                        userId: "other",
                        parentId: null,
                    },
                ],
            }),
        ).folders,
    ).toEqual([]);
});
it("keeps absorbed agenda chips readable and disables filing actions", () => {
    render(
        <AgendaFolderTags
            detail={agenda}
            userId="owner"
            folders={folders}
            disabled
            mutate={vi.fn()}
        />,
    );
    expect(screen.getByRole("button", { name: "First" })).toBeTruthy();
    expect(
        screen.queryByRole("button", { name: "Remove from First" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Add to folder" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to…" })).toBeNull();
});
