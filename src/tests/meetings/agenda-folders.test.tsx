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
    expect(
        screen.getByRole("combobox", { name: "Add to folder" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "Move to…" }));
    expect(screen.getByRole("heading", { name: "Move from…" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
        screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["FirstFirst", "SecondSecond"]);
    await act(async () =>
        fireEvent.click(screen.getByRole("option", { name: /^First/ })),
    );
    await screen.findByRole("heading", { name: "Move to…" });
    expect(
        screen
            .getByRole("option", { name: /^First/ })
            .getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () =>
        fireEvent.click(screen.getByRole("option", { name: /^Third/ })),
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
    expect(
        screen.queryByRole("combobox", { name: "Add to folder" }),
    ).toBeNull();
    expect(screen.queryByRole("combobox", { name: /Move/ })).toBeNull();
});

it.each([
    "source",
    "target",
])("Escape cancels the whole move in the %s step", async (step) => {
    const mutate = vi.fn();
    render(
        <AgendaFolderTags
            detail={agenda}
            userId="owner"
            folders={folders}
            disabled={false}
            mutate={mutate}
        />,
    );
    const trigger = screen.getByRole("combobox", { name: "Move to…" });
    fireEvent.click(trigger);
    if (step === "target") {
        fireEvent.click(screen.getByRole("option", { name: /^First/ }));
        await screen.findByRole("heading", { name: "Move to…" });
        await screen.findByPlaceholderText("Find a folder…");
    }
    fireEvent.keyDown(screen.getByPlaceholderText("Find a folder…"), {
        key: "Escape",
    });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    expect(screen.getByRole("heading", { name: "Move from…" })).toBeTruthy();
});
it("preselects the only source folder", async () => {
    const mutate = vi.fn().mockResolvedValue(true);
    render(
        <AgendaFolderTags
            detail={{ ...agenda, folders: agenda.folders.slice(0, 1) }}
            userId="owner"
            folders={folders}
            disabled={false}
            mutate={mutate}
        />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Move to…" }));
    expect(screen.getByRole("heading", { name: "Move to…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /^Third/ }));
    await waitFor(() =>
        expect(mutate).toHaveBeenCalledWith(
            expect.any(String),
            "PATCH",
            {
                fromFolderId: "folder-0",
                toFolderId: "folder-2",
                withdraw: true,
            },
            expect.any(Function),
        ),
    );
});
