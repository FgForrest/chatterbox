// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstLevelFolderDialog } from "@/components/dashboard/first-level-folder-dialog";
import type { RecordingFolder } from "@/types/folder";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string) => text,
}));

const folders: RecordingFolder[] = [
    {
        id: "private-root",
        parentId: null,
        name: "Private",
        kind: "private",
        sortOrder: 0,
        scope: "personal",
        version: 1,
    },
    {
        id: "org-root",
        parentId: null,
        name: "Team",
        kind: "public",
        sortOrder: 0,
        scope: "org",
        version: 1,
    },
];

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("FirstLevelFolderDialog", () => {
    it("creates a folder under the chosen root and reports it", async () => {
        const created = {
            id: "org-new",
            parentId: "org-root",
            name: "Planning",
            kind: "custom" as const,
            sortOrder: 1000,
            scope: "org" as const,
            version: 1,
        };
        const fetch = vi.fn(async () =>
            Response.json({ folder: created }, { status: 201 }),
        );
        vi.stubGlobal("fetch", fetch);
        const onCreated = vi.fn();
        const onOpenChange = vi.fn();
        render(
            <FirstLevelFolderDialog
                folders={folders}
                includeOrganization
                open
                onOpenChange={onOpenChange}
                onCreated={onCreated}
            />,
        );

        fireEvent.click(
            screen.getByRole("combobox", { name: "Parent folder" }),
        );
        fireEvent.click(screen.getByRole("option", { name: "Organization" }));
        fireEvent.change(screen.getByLabelText("Folder name"), {
            target: { value: "Planning" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Create folder" }));

        await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
        expect(fetch).toHaveBeenCalledWith(
            "/api/folders",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    parentId: "org-root",
                    name: "Planning",
                }),
            }),
        );
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("does not offer the Organization root to a non-curator", () => {
        render(
            <FirstLevelFolderDialog
                folders={folders}
                includeOrganization={false}
                open
                onOpenChange={vi.fn()}
                onCreated={vi.fn()}
            />,
        );

        fireEvent.click(
            screen.getByRole("combobox", { name: "Parent folder" }),
        );
        expect(screen.getByRole("option", { name: "Private" })).toBeTruthy();
        expect(
            screen.queryByRole("option", { name: "Organization" }),
        ).toBeNull();
    });
});
