// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

    it("preselects the workstation folder and submits a changed folder", () => {
        const onUpload = vi.fn();
        render(
            <UploadDialog
                file={new File(["audio"], "meeting.m4a")}
                folders={folders}
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
                open
                onOpenChange={vi.fn()}
                onUpload={vi.fn()}
                selectedFolderId="missing"
            />,
        );

        expect(
            screen.getByRole("combobox", { name: "Folder" }).textContent,
        ).toBe("File later");
        expect(
            screen.getByText("Create folders from the Folders sidebar."),
        ).toBeTruthy();
    });
});
