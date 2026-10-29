// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderActionDialog } from "@/components/dashboard/folder-action-dialog";
import type { RecordingFolder } from "@/types/folder";

const root: RecordingFolder = {
    id: "private",
    parentId: null,
    kind: "private",
    scope: "personal",
    name: "Private",
    sortOrder: 0,
    version: 0,
};
const folder: RecordingFolder = {
    ...root,
    id: "folder",
    parentId: root.id,
    kind: "custom",
    name: "Projects",
};
const child: RecordingFolder = {
    ...folder,
    id: "child",
    parentId: folder.id,
    name: "Nested",
};
const other: RecordingFolder = { ...folder, id: "other", name: "Archive" };
const received: RecordingFolder = {
    ...folder,
    id: "received",
    receivedFolder: {
        shareId: "share",
        shareVersion: 1,
        ownerName: "Lada Cloudfern",
        originalName: "Shared",
    },
};
afterEach(cleanup);
function dialog(
    action: "create" | "move",
    target = folder,
    canCurate = false,
    reject = false,
) {
    const create = reject
        ? vi.fn().mockRejectedValue(new Error("Unavailable"))
        : vi.fn().mockResolvedValue(undefined);
    const move = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    render(
        <FolderActionDialog
            folder={target}
            folders={[root, folder, child, other, received]}
            action={action}
            open
            onOpenChange={close}
            onCreate={create}
            onMove={move}
            canCurate={canCurate}
        />,
    );
    return { create, move, close };
}
describe("dedicated folder dialogs", () => {
    it.each([
        { action: "create", exit: "Cancel" },
        { action: "create", exit: "Escape" },
        { action: "create", exit: "save" },
        { action: "move", exit: "Cancel" },
        { action: "move", exit: "Escape" },
    ] as const)("returns focus to the launcher after $action closes through $exit", async ({
        action,
        exit,
    }) => {
        const create = vi.fn().mockResolvedValue(undefined);
        function Launcher() {
            const [invoker, setInvoker] = useState<HTMLElement | null>(null);
            return (
                <>
                    <button
                        type="button"
                        onClick={() => {
                            if (document.activeElement instanceof HTMLElement)
                                setInvoker(document.activeElement);
                        }}
                    >
                        Launch folder action
                    </button>
                    {invoker && (
                        <FolderActionDialog
                            folder={folder}
                            folders={[root, folder, child, other]}
                            action={action}
                            open
                            returnFocusElement={invoker}
                            onOpenChange={(open) => {
                                if (!open) setInvoker(null);
                            }}
                            onCreate={create}
                            onMove={vi.fn()}
                        />
                    )}
                </>
            );
        }
        render(<Launcher />);
        const launcher = screen.getByRole("button", {
            name: "Launch folder action",
        });
        launcher.focus();
        fireEvent.click(launcher);
        const input = screen.getByRole(
            action === "create" ? "textbox" : "combobox",
        );
        await waitFor(() => expect(document.activeElement).toBe(input));
        if (exit === "save") {
            fireEvent.change(input, { target: { value: "Drafts" } });
            fireEvent.click(
                screen.getByRole("button", { name: "New subfolder" }),
            );
            await waitFor(() =>
                expect(create).toHaveBeenCalledWith(folder.id, "Drafts"),
            );
        } else if (exit === "Escape") {
            fireEvent.keyDown(input, { key: "Escape" });
        } else {
            fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        }
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(launcher));
    });
    it("creates a trimmed child and closes after saving", async () => {
        const { create, close } = dialog("create");
        expect(
            screen.getByRole("button", { name: "New subfolder" }),
        ).toHaveProperty("disabled", true);
        const input = screen.getByRole("textbox", {
            name: "New subfolder name",
        });
        expect(input.getAttribute("maxlength")).toBe("100");
        fireEvent.change(input, { target: { value: "  Drafts  " } });
        fireEvent.submit(input.closest("form") as HTMLFormElement);
        await waitFor(() =>
            expect(create).toHaveBeenCalledWith(folder.id, "Drafts"),
        );
        expect(close).toHaveBeenCalledWith(false);
    });
    it("preserves the draft on failure and cancels without saving", async () => {
        const { create, close } = dialog("create", folder, false, true);
        fireEvent.change(screen.getByRole("textbox"), {
            target: { value: "Drafts" },
        });
        fireEvent.click(screen.getByRole("button", { name: "New subfolder" }));
        await waitFor(() => expect(create).toHaveBeenCalledOnce());
        expect(close).not.toHaveBeenCalled();
        await waitFor(() =>
            expect(screen.getByRole("textbox")).toHaveProperty(
                "disabled",
                false,
            ),
        );
        expect(screen.getByRole("textbox")).toHaveProperty("value", "Drafts");
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(close).toHaveBeenCalledWith(false);
    });
    it("moves only to another folder of the same scope, excluding descendants and attachments", async () => {
        const { move, close } = dialog("move");
        const select = screen.getByRole("combobox", {
            name: "Destination folder",
        });
        expect(
            screen
                .getAllByRole("option")
                .map((option) => option.getAttribute("value")),
        ).toEqual(["private", "other"]);
        expect(screen.getByRole("button", { name: "Move to…" })).toHaveProperty(
            "disabled",
            true,
        );
        fireEvent.change(select, { target: { value: "other" } });
        fireEvent.click(screen.getByRole("button", { name: "Move to…" }));
        await waitFor(() =>
            expect(move).toHaveBeenCalledWith(folder.id, other.id),
        );
        expect(close).toHaveBeenCalledWith(false);
    });
    it.each([
        "create",
        "move",
    ] as const)("refuses %s for received folders", (action) => {
        dialog(action, received, true);
        expect(screen.queryByRole("dialog")).toBeNull();
    });
    it("allows member creation below an Organization folder but reserves its move for curators", () => {
        const org = { ...folder, scope: "org" as const };
        dialog("create", org);
        expect(screen.getByRole("dialog")).toBeTruthy();
        cleanup();
        dialog("move", org);
        expect(screen.queryByRole("dialog")).toBeNull();
        cleanup();
        dialog("create", { ...org, parentId: null });
        expect(screen.queryByRole("dialog")).toBeNull();
        cleanup();
        dialog("move", org, true);
        expect(screen.getByRole("dialog")).toBeTruthy();
    });
});
