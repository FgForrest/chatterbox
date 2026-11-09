// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgendaFolderTags } from "@/components/meetings/agenda-folder-tags";
import type { RecordingFolder } from "@/types/folder";
import { detail } from "./ui-fixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
beforeEach(() => {
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

it("lets the owner move by adding a folder and removing the old chip, without Move to", async () => {
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
    for (const name of ["First", "Second"])
        expect(
            screen.getByRole("button", { name: `Remove from ${name}` }),
        ).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Move to…" })).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "Add to folder" }));
    await act(async () =>
        fireEvent.click(screen.getByRole("option", { name: /^Third/ })),
    );
    expect(mutate).toHaveBeenCalledWith(
        "/api/recordings/meeting/folders",
        "POST",
        { folderId: "folder-2" },
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
    expect(
        screen.queryByRole("combobox", { name: "Add to folder" }),
    ).toBeNull();
    expect(screen.queryByRole("combobox", { name: /Move/ })).toBeNull();
});

it("keeps the Organization curator's Move to path", async () => {
    const mutate = vi.fn().mockResolvedValue(true);
    const organization = folders.map((folder) => ({
        ...folder,
        scope: "org" as const,
    }));
    render(
        <AgendaFolderTags
            detail={{
                ...agenda,
                folders: [{ ...agenda.folders[0], userId: "org" }],
            }}
            userId="curator"
            folders={organization}
            disabled={false}
            mutate={mutate}
        />,
    );
    expect(
        screen.queryByRole("combobox", { name: "Add to folder" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "Move to…" }));
    await act(async () =>
        fireEvent.click(screen.getByRole("option", { name: /^Third/ })),
    );
    expect(mutate).toHaveBeenCalledWith(
        "/api/recordings/meeting/folders",
        "PATCH",
        { fromFolderId: "folder-0", toFolderId: "folder-2", withdraw: true },
        expect.any(Function),
    );
});
