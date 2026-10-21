// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as NextIntl from "next-intl";
import type { PropsWithChildren } from "react";
import type { TranslationValues } from "use-intl/core";
import { IntlProvider, useTranslations } from "use-intl/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { FirstLevelFolderDialog } from "@/components/dashboard/first-level-folder-dialog";
import { FolderRecordingPane } from "@/components/dashboard/folder-recording-pane";
import { FolderTree } from "@/components/dashboard/folder-tree";
import {
    UploadDialog,
    uploadFolderOptions,
    uploadFolderParents,
} from "@/components/dashboard/upload-dialog";
import { RecordingFolderTags } from "@/components/recordings/recording-folder-tags";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useFolderLabel } from "@/hooks/use-folder-label";
import {
    messagesForLocale,
    translatedSourceMessage,
} from "@/lib/i18n/messages";
import type { RecordingFolder } from "@/types/folder";

vi.mock("next-intl", async (importOriginal) => {
    const original = await importOriginal<typeof NextIntl>();
    return {
        ...original,
        useExtracted: () => {
            const translate = useTranslations();
            const ids = new Map(
                Object.entries(messagesForLocale("en")).map(([id, source]) => [
                    source,
                    id,
                ]),
            );
            return (message: string, values?: TranslationValues) =>
                translate(ids.get(message) ?? message, values);
        },
    };
});

const privateRoot: RecordingFolder = {
    id: "private-root",
    parentId: null,
    name: "Private",
    kind: "private",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};
const custom: RecordingFolder = {
    ...privateRoot,
    id: "custom",
    parentId: privateRoot.id,
    kind: "custom",
    name: "Private",
};
const nested: RecordingFolder = {
    ...custom,
    id: "nested",
    parentId: custom.id,
    name: "Notes",
};
const orgRoot: RecordingFolder = {
    ...privateRoot,
    id: "organization",
    kind: "public",
    scope: "org",
    name: "Stored organization name",
};
const folders = [privateRoot, custom, nested, orgRoot];
const cs = (source: string) => translatedSourceMessage("cs-CZ", source);

function Czech({ children }: PropsWithChildren) {
    return (
        <IntlProvider locale="cs-CZ" messages={messagesForLocale("cs-CZ")}>
            <TooltipProvider>
                <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
            </TooltipProvider>
        </IntlProvider>
    );
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("localized folder labels", () => {
    it("shows and searches the Czech root label, including accessible actions, without allowing rename", () => {
        render(
            <FolderTree
                folders={folders}
                assignments={[]}
                recordings={[]}
                selectedFolderId={null}
                onRecent={vi.fn()}
                onSelectFolder={vi.fn()}
                onCreateFolder={vi.fn()}
                onRenameFolder={vi.fn()}
                onMoveFolder={vi.fn()}
                onDeleteFolder={vi.fn()}
                onAssignRecording={vi.fn()}
            />,
            { wrapper: Czech },
        );
        expect(screen.getByRole("button", { name: /^Soukromé,/ })).toBeTruthy();
        expect(screen.getByRole("button", { name: /^Private,/ })).toBeTruthy();
        const actions = screen.getByRole("button", {
            name: translatedSourceMessage(
                "cs-CZ",
                "Folder actions for {folder}",
                { folder: "Soukromé" },
            ),
        });
        fireEvent.pointerDown(actions, { button: 0, ctrlKey: false });
        expect(
            screen.getByRole("menuitem", { name: cs("New subfolder") }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("menuitem", { name: cs("Rename") }),
        ).toBeNull();
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        fireEvent.change(
            screen.getByRole("textbox", { name: cs("Search folders") }),
            {
                target: { value: "Soukromé" },
            },
        );
        expect(screen.getByRole("button", { name: /^Soukromé,/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /^Private,/ })).toBeNull();
    });

    it.each([
        privateRoot,
        nested,
    ])("localizes the folder pane and breadcrumb for $id", (folder) => {
        render(
            <FolderRecordingPane
                folder={folder}
                folders={folders}
                assignments={[]}
                recordings={[]}
                dateTimeFormat="relative"
                onSelectRecording={vi.fn()}
                onRenameFolder={vi.fn()}
                onDeleteFolder={vi.fn()}
                hiddenOnMobile={false}
                onBackToFolders={vi.fn()}
                exportProviders={{
                    filesystem: false,
                    googleDrive: false,
                    mail: false,
                }}
            />,
            { wrapper: Czech },
        );
        expect(
            screen.getByRole("heading", {
                name: folder === privateRoot ? "Soukromé" : "Notes",
            }),
        ).toBeTruthy();
        expect(screen.getAllByText("Soukromé")).toHaveLength(
            folder === privateRoot ? 2 : 1,
        );
        if (folder === nested) {
            expect(
                screen.getByText("Private").parentElement?.parentElement
                    ?.textContent,
            ).toMatch(/^Soukromé\/Private\/Notes/);
        } else {
            expect(
                screen.queryByRole("button", { name: cs("Rename") }),
            ).toBeNull();
        }
        fireEvent.click(screen.getByRole("button", { name: cs("Export") }));
        expect(screen.getByRole("dialog").textContent).toContain(
            folder === privateRoot ? "Soukromé" : "Notes",
        );
    });

    it("localizes recording tags and removal labels while keeping a custom Private name", () => {
        render(
            <RecordingFolderTags
                recordingId="recording"
                folders={folders}
                assignments={[
                    { recordingId: "recording", folderId: privateRoot.id },
                    { recordingId: "recording", folderId: custom.id },
                ]}
                onSelectFolder={vi.fn()}
                onAdd={vi.fn()}
                onRemove={vi.fn()}
            />,
            { wrapper: Czech },
        );
        expect(screen.getByRole("button", { name: "Soukromé" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Private" })).toBeTruthy();
        expect(
            screen.getByRole("button", {
                name: translatedSourceMessage("cs-CZ", "Remove from {folder}", {
                    folder: "Soukromé",
                }),
            }),
        ).toBeTruthy();
    });

    it("localizes the first-level folder parent picker", () => {
        render(
            <FirstLevelFolderDialog
                folders={folders}
                includeOrganization
                open
                onOpenChange={vi.fn()}
                onCreated={vi.fn()}
            />,
            { wrapper: Czech },
        );
        fireEvent.click(
            screen.getByRole("combobox", { name: cs("Parent folder") }),
        );
        expect(screen.getByRole("option", { name: "Soukromé" })).toBeTruthy();
        expect(
            screen.getByRole("option", { name: cs("Organization") }),
        ).toBeTruthy();
    });

    it("localizes nested upload paths and new-folder parents", () => {
        function Upload() {
            const label = useFolderLabel();
            return (
                <UploadDialog
                    file={new File(["audio"], "notes.m4a")}
                    folders={uploadFolderOptions(folders, true, label)}
                    folderParents={uploadFolderParents(folders, true, label)}
                    open
                    onOpenChange={vi.fn()}
                    onUpload={vi.fn()}
                    selectedFolderId={nested.id}
                />
            );
        }
        render(<Upload />, { wrapper: Czech });
        expect(
            screen.getByRole("combobox", { name: cs("Folder") }).textContent,
        ).toBe("Soukromé / Private / Notes");
        fireEvent.click(screen.getByRole("button", { name: cs("New folder") }));
        fireEvent.click(
            screen.getByRole("combobox", { name: cs("Parent folder") }),
        );
        expect(screen.getByRole("option", { name: "Soukromé" })).toBeTruthy();
    });
});
