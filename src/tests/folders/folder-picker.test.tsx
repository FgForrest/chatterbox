// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderPicker } from "@/components/recordings/folder-picker";
import type { RecordingFolder } from "@/types/folder";

const root: RecordingFolder = {
    id: "private",
    name: "Private",
    parentId: null,
    kind: "private",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};
const meetings: RecordingFolder = {
    ...root,
    id: "meetings",
    parentId: root.id,
    name: "Porády",
    kind: "custom",
};
const child: RecordingFolder = {
    ...meetings,
    id: "child",
    parentId: meetings.id,
    name: "Vývoj",
};
const org: RecordingFolder = {
    ...root,
    id: "org",
    name: "Organization",
    scope: "org",
    kind: "public",
};
const orgChild: RecordingFolder = {
    ...meetings,
    id: "org-child",
    parentId: org.id,
    name: "Klienti",
    scope: "org",
};
const folders = [root, meetings, child, org, orgChild];
const onSelect = vi.fn().mockResolvedValue(undefined);
const onOpenChange = vi.fn();
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

function picker(assignedIds = new Set<string>(), canCurate = false) {
    return render(
        <FolderPicker
            folders={folders}
            assignedIds={assignedIds}
            open
            onOpenChange={onOpenChange}
            onSelect={onSelect}
            canCurate={canCurate}
        />,
    );
}

describe("searchable folder picker", () => {
    it("focuses search, groups the hierarchy and keeps assigned folders inert", () => {
        picker(new Set(["meetings"]));
        expect(document.activeElement).toBe(screen.getByRole("combobox"));
        expect(
            screen.getByText("Private", { selector: "[cmdk-group-heading]" }),
        ).toBeTruthy();
        expect(
            screen.getByText("Organization", {
                selector: "[cmdk-group-heading]",
            }),
        ).toBeTruthy();
        const option = screen.getByRole("option", { name: /Porády/ });
        expect(option.getAttribute("aria-disabled")).toBe("true");
        expect(
            option.querySelector('[aria-label="Already in this folder"]'),
        ).toBeTruthy();
        fireEvent.click(option);
        expect(onSelect).not.toHaveBeenCalled();
    });
    it("keeps a fixed top while results change and indents the grouped tree without repeating paths", () => {
        picker();
        const dialog = screen.getByRole("dialog");
        expect(dialog.className).toContain("top-[15vh]");
        expect(dialog.className).toContain("-translate-y-0");
        expect(
            screen.getByRole("option", { name: "Vývoj" }).querySelector("span")
                ?.style.paddingLeft,
        ).toBe("24px");
        fireEvent.change(screen.getByRole("combobox"), {
            target: { value: "vyvoj" },
        });
        expect(dialog.className).toContain("top-[15vh]");
        expect(
            screen.getByRole("option", { name: "Vývoj Private › Porády" }),
        ).toBeTruthy();
    });
    it("finds names and paths without diacritics", () => {
        picker();
        fireEvent.change(screen.getByRole("combobox"), {
            target: { value: "porady" },
        });
        const matches = screen.getAllByRole("option");
        expect(matches[0].getAttribute("aria-label")).toBe("Porády Private");
        expect(matches[1].getAttribute("aria-label")).toBe(
            "Vývoj Private › Porády",
        );
    });
    it("files with arrows and Enter, and closes with Escape", async () => {
        picker();
        const input = screen.getByRole("combobox");
        fireEvent.change(input, { target: { value: "vyvoj" } });
        fireEvent.keyDown(input, { key: "ArrowDown" });
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith("child"));
        expect(onOpenChange).toHaveBeenCalledWith(false);
        fireEvent.keyDown(input, { key: "Escape" });
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    it.each([
        false,
        true,
    ])("offers creation and enforces the top-level Organization curator rule: %s", (canCurate) => {
        picker(new Set(), canCurate);
        fireEvent.change(screen.getByRole("combobox"), {
            target: { value: "Invented folder" },
        });
        fireEvent.click(
            screen.getByRole("option", {
                name: "Create folder “Invented folder”",
            }),
        );
        const parents = screen.getByRole("combobox", { name: "Parent folder" });
        expect(parents.textContent).toContain("Private");
        expect(parents.textContent).toContain("Organization › Klienti");
        expect(
            screen.queryByRole("option", {
                name: "Organization",
            }) !== null,
        ).toBe(canCurate);
    });
    it("does not duplicate a filing failure toast after creating a folder", async () => {
        const error = vi
            .spyOn(toast, "error")
            .mockImplementation(() => "toast");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({ folder: { ...meetings, id: "created" } }),
            ),
        );
        onSelect.mockImplementationOnce(async () => {
            toast.error("Filing failed");
            throw new Error("Filing failed");
        });
        picker();
        fireEvent.change(screen.getByRole("combobox"), {
            target: { value: "Invented folder" },
        });
        fireEvent.click(
            screen.getByRole("option", {
                name: "Create folder “Invented folder”",
            }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
        await waitFor(() =>
            expect(error).toHaveBeenCalledExactlyOnceWith("Filing failed"),
        );
        error.mockRestore();
    });
    it("creates in the chosen parent and files into the returned folder", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            Response.json({
                folder: {
                    ...meetings,
                    id: "created",
                    name: "Invented folder",
                },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);
        picker();
        fireEvent.change(screen.getByRole("combobox"), {
            target: { value: "Invented folder" },
        });
        fireEvent.click(
            screen.getByRole("option", {
                name: "Create folder “Invented folder”",
            }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith("created"));
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/folders",
            expect.objectContaining({
                body: JSON.stringify({
                    parentId: "private",
                    name: "Invented folder",
                }),
            }),
        );
    });
});
