// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string) => text,
}));

import { UploadDialog } from "@/components/dashboard/upload-dialog";

afterEach(cleanup);

describe("UploadDialog", () => {
    const folders = [
        {
            id: "personal-project",
            name: "Project",
            path: "Private / Project",
            scope: "personal" as const,
        },
        {
            id: "org-sales",
            name: "Sales",
            path: "Organization / Sales",
            scope: "org" as const,
        },
    ];
    const folderParents = [{ id: "personal-root", path: "Private" }];

    it("preselects the workstation folder and submits a changed folder", () => {
        const onUpload = vi.fn();
        render(
            <UploadDialog
                file={new File(["audio"], "meeting.m4a")}
                folders={folders}
                folderParents={folderParents}
                open
                onOpenChange={vi.fn()}
                onUpload={onUpload}
                selectedFolderId="org-sales"
            />,
        );

        const picker = screen.getByRole("combobox", { name: "Folder" });
        expect(picker.textContent).toContain("Organization / Sales");

        fireEvent.click(picker);
        fireEvent.click(
            screen.getByRole("option", { name: "Private / Project" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Upload" }));

        expect(onUpload).toHaveBeenCalledWith("personal-project");
    });

    it("uses File later when the workstation folder is not offered", () => {
        render(
            <UploadDialog
                file={new File(["audio"], "meeting.m4a")}
                folders={folders}
                folderParents={folderParents}
                open
                onOpenChange={vi.fn()}
                onUpload={vi.fn()}
                selectedFolderId="missing"
            />,
        );

        expect(
            screen.getByRole("combobox", { name: "Folder" }).textContent,
        ).toBe("File later");
        expect(screen.getByRole("button", { name: "New folder" })).toBeTruthy();
    });

    it("creates a folder and selects it for upload", async () => {
        const onUpload = vi.fn();
        const onFolderCreated = vi.fn();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            expect(String(input)).toBe("/api/folders");
            return Response.json(
                {
                    folder: {
                        id: "personal-new",
                        parentId: "personal-root",
                        name: "New folder",
                        scope: "personal",
                    },
                },
                { status: 201 },
            );
        });
        vi.stubGlobal("fetch", fetchMock);

        render(
            <UploadDialog
                file={new File(["audio"], "meeting.m4a")}
                folders={folders}
                folderParents={folderParents}
                open
                onOpenChange={vi.fn()}
                onUpload={onUpload}
                onFolderCreated={onFolderCreated}
                selectedFolderId={null}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "New folder" }));
        fireEvent.change(screen.getByLabelText("Folder name"), {
            target: { value: "New folder" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Create folder" }));

        await waitFor(() =>
            expect(
                screen.getByRole("combobox", { name: "Folder" }).textContent,
            ).toBe("Private / New folder"),
        );
        expect(onFolderCreated).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "personal-new",
                parentId: "personal-root",
                name: "New folder",
                scope: "personal",
            }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Upload" }));
        expect(onUpload).toHaveBeenCalledWith("personal-new");
    });
});
