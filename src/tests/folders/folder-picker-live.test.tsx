// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderPicker } from "@/components/recordings/folder-picker";
import { LibraryPreferencesContext } from "@/hooks/use-library-preferences";
import type { RecordingFolder } from "@/types/folder";

const root: RecordingFolder = {
    id: "root-velno",
    name: "Private",
    parentId: null,
    kind: "private",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};
const parent: RecordingFolder = {
    ...root,
    id: "folder-tavri",
    name: "Tavri",
    parentId: root.id,
    kind: "custom",
};
const child: RecordingFolder = {
    ...parent,
    id: "folder-zulno",
    name: "Zulno",
    parentId: parent.id,
};
const added: RecordingFolder = {
    ...parent,
    id: "folder-felvo",
    name: "Felvo",
    sortOrder: -1,
};
const org: RecordingFolder = {
    ...root,
    id: "root-nelvi",
    name: "Organization",
    kind: "public",
    scope: "org",
};
const onSelect = vi.fn().mockResolvedValue(undefined);
const onOpenChange = vi.fn();
const assignedIds = new Set<string>();
class Observer {
    observe() {}
    disconnect() {}
    unobserve() {}
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", Observer);
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function picker(folders: RecordingFolder[]) {
    return (
        <FolderPicker
            folders={folders}
            assignedIds={assignedIds}
            open
            onOpenChange={onOpenChange}
            onSelect={onSelect}
        />
    );
}

describe("FolderPicker live folders", () => {
    it("updates an open search, keeps its query and active folder, and falls back when that folder is deleted", async () => {
        const { rerender } = render(picker([root, parent, child]));
        const dialog = screen.getByRole("dialog");
        const input = screen.getByPlaceholderText("Find a folder…");
        fireEvent.change(input, { target: { value: "tavri" } });
        fireEvent.keyDown(input, { key: "ArrowDown" });
        const active = screen.getByRole("option", {
            name: "Zulno Private › Tavri",
        });
        expect(active.getAttribute("aria-selected")).toBe("true");
        const newChild = { ...added, parentId: parent.id };
        rerender(picker([root, parent, child, newChild]));
        expect(screen.getByRole("dialog")).toBe(dialog);
        expect(screen.getByPlaceholderText("Find a folder…")).toBe(input);
        expect(input).toHaveProperty("value", "tavri");
        expect(
            screen.getByRole("option", { name: "Felvo Private › Tavri" }),
        ).toBeTruthy();
        expect(active.getAttribute("aria-selected")).toBe("true");
        expect(input.getAttribute("aria-activedescendant")).toBe(active.id);
        rerender(picker([root, parent, newChild]));
        const first = screen.getAllByRole("option")[0];
        expect(first.getAttribute("aria-selected")).toBe("true");
        expect(input.getAttribute("aria-activedescendant")).toBe(first.id);
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(parent.id));
    });

    it("refreshes ancestor paths, Organization marks and recent rows without stale labels", () => {
        const preferences = {
            ready: true,
            preferences: {
                expanded: null,
                recent: [child.id],
                collapsed: false,
            },
            setPreferences: vi.fn(),
            recentFolders: [child],
            rememberFolder: vi.fn(),
        };
        const view = (folders: RecordingFolder[]) => (
            <LibraryPreferencesContext.Provider value={preferences}>
                {picker(folders)}
            </LibraryPreferencesContext.Provider>
        );
        const { rerender } = render(view([root, parent, child, org]));
        expect(
            screen.getAllByRole("option")[0].getAttribute("aria-label"),
        ).toBe("Zulno Private › Tavri");
        const renamed = { ...parent, name: "Felvora" };
        rerender(view([root, renamed, child, org]));
        expect(
            screen.getAllByRole("option")[0].getAttribute("aria-label"),
        ).toBe("Zulno Private › Felvora");
        const input = screen.getByPlaceholderText("Find a folder…");
        fireEvent.change(input, { target: { value: "zulno" } });
        const moved = { ...child, parentId: org.id, scope: "org" as const };
        rerender(view([root, renamed, moved, org]));
        const option = screen.getByRole("option", {
            name: "Zulno Organization",
        });
        expect(option.querySelector("svg.text-organization")).toBeTruthy();
        expect(option.closest("[role=group]")).toBeNull();
        expect(
            screen.queryByText("Organization", {
                selector: "[cmdk-group-heading]",
            }),
        ).toBeNull();
        expect(option.getAttribute("aria-selected")).toBe("true");
        expect(input).toHaveProperty("value", "zulno");
        fireEvent.change(input, { target: { value: "" } });
        rerender(view([root, renamed, org]));
        expect(screen.queryByText("Recently used")).toBeNull();
        expect(screen.queryByText("Zulno")).toBeNull();
    });

    it("keeps the highlighted row after a failed filing", async () => {
        let reject: (reason: Error) => void = () => {};
        const pending = new Promise<void>((_resolve, fail) => {
            reject = fail;
        });
        onSelect.mockReturnValueOnce(pending);
        render(picker([root, parent, child]));
        const input = screen.getByPlaceholderText("Find a folder…");
        fireEvent.keyDown(input, { key: "ArrowDown" });
        const active = screen.getByRole("option", { name: "Zulno" });
        expect(active.getAttribute("aria-selected")).toBe("true");
        fireEvent.keyDown(input, { key: "Enter" });
        expect(active.getAttribute("aria-disabled")).toBe("true");
        expect(active.getAttribute("aria-selected")).toBe("true");
        await act(async () => reject(new Error("Filing failed")));
        expect(active.getAttribute("aria-disabled")).toBe("false");
        expect(active.getAttribute("aria-selected")).toBe("true");
        expect(input.getAttribute("aria-activedescendant")).toBe(active.id);
        expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("lets Dialog handle Escape exactly once and sees Tab", () => {
        render(picker([root, parent]));
        const input = screen.getByPlaceholderText("Find a folder…");
        fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
        expect(document.activeElement).toBe(
            screen.getByRole("button", { name: "Close" }),
        );
        fireEvent.keyDown(input, { key: "Escape" });
        expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    });

    it("ranks Organization name matches before private ancestor matches for acme", () => {
        const ancestor = { ...parent, name: "Acme" };
        const organizationMatch = {
            ...added,
            name: "Acme",
            parentId: org.id,
            scope: "org" as const,
        };
        render(picker([root, ancestor, child, org, organizationMatch]));
        fireEvent.change(screen.getByPlaceholderText("Find a folder…"), {
            target: { value: "acme" },
        });
        const options = screen.getAllByRole("option");
        expect(
            options.map((option) => option.getAttribute("aria-label")),
        ).toEqual([
            "Acme Private",
            "Acme Organization",
            "Zulno Private › Acme",
        ]);
        expect(options[1].querySelector("svg.text-organization")).toBeTruthy();
        expect(
            screen.queryByText("Private", { selector: "[cmdk-group-heading]" }),
        ).toBeNull();
    });

    it("offers a folder created in its own form while the picker stays open after a filing failure", async () => {
        const created = { ...added, name: "Felvora" };
        const fetchMock = vi
            .fn()
            .mockResolvedValue(Response.json({ folder: created }));
        vi.stubGlobal("fetch", fetchMock);
        const select = vi.fn().mockRejectedValue(new Error("Filing failed"));
        function Library() {
            const [folders, setFolders] = useState([root, parent]);
            return (
                <FolderPicker
                    folders={folders}
                    assignedIds={assignedIds}
                    open
                    onOpenChange={onOpenChange}
                    onSelect={select}
                    onCreated={(folder) =>
                        setFolders((current) => [...current, folder])
                    }
                />
            );
        }
        render(<Library />);
        const dialog = screen.getByRole("dialog");
        fireEvent.change(screen.getByPlaceholderText("Find a folder…"), {
            target: { value: "Felvora" },
        });
        fireEvent.click(
            screen.getByRole("option", { name: "Create folder “Felvora”" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
        await waitFor(() => expect(select).toHaveBeenCalledWith(created.id));
        expect(screen.getByRole("dialog")).toBe(dialog);
        expect(screen.getByPlaceholderText("Find a folder…")).toHaveProperty(
            "value",
            "Felvora",
        );
        expect(
            screen
                .getByRole("option", { name: "Felvora Private" })
                .getAttribute("aria-disabled"),
        ).toBe("false");
        expect(onOpenChange).not.toHaveBeenCalled();
    });
});
