// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { RecordingList } from "@/components/dashboard/recording-list";
import { folderRowLocations } from "@/lib/folders/navigation";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

const privateRoot: RecordingFolder = {
    id: "private",
    name: "Private",
    parentId: null,
    kind: "private",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};
const organization: RecordingFolder = {
    ...privateRoot,
    id: "org",
    name: "Organization",
    kind: "public",
    scope: "org",
};
const parent: RecordingFolder = {
    ...privateRoot,
    id: "parent",
    name: "Vespari",
    kind: "custom",
    parentId: privateRoot.id,
};
const nested: RecordingFolder = {
    ...parent,
    id: "nested",
    name: "Nerivo",
    parentId: parent.id,
};
const orgChild: RecordingFolder = {
    ...parent,
    id: "org-child",
    name: "Talvori",
    scope: "org",
    parentId: organization.id,
};
const folders = [privateRoot, organization, parent, nested, orgChild];
const recording: Recording = {
    id: "r1",
    filename: "Vespari review",
    duration: 60_000,
    filesize: 1_000,
    startTime: "2026-10-22T10:00:00.000Z",
    deviceSn: "local",
};
const transcript = "speaker_0: An unhelpful transcript opening.";

function showList(props: Partial<ComponentProps<typeof RecordingList>> = {}) {
    return render(
        <ConfirmDialogProvider>
            <RecordingList
                recordings={[recording]}
                transcriptions={new Map([[recording.id, { text: transcript }]])}
                currentRecording={null}
                pendingUploads={[]}
                inFlightActions={new Map()}
                onSelect={vi.fn()}
                onDelete={vi.fn()}
                initialDateTimeFormat="relative"
                initialSortOrder="newest"
                initialChunkSize={50}
                folders={folders}
                {...props}
            />
        </ConfirmDialogProvider>,
    );
}

function row() {
    return screen.getByRole("button", { name: /Vespari review/ });
}

beforeEach(() => {
    vi.stubGlobal(
        "IntersectionObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            Response.json({
                hits: [],
                complete: true,
                continueBefore: null,
            }),
        ),
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("recording row folder metadata", () => {
    it("shows the first assignment in Recent using Organization colour", () => {
        showList({
            assignments: [
                { recordingId: recording.id, folderId: orgChild.id },
                { recordingId: recording.id, folderId: nested.id },
            ],
        });
        const folder = within(row()).getByText(orgChild.name);
        expect(folder.parentElement?.title).toBe("Organization / Talvori");
        expect(
            folder.parentElement
                ?.querySelector("svg")
                ?.classList.contains("text-organization"),
        ).toBe(true);
        expect(within(row()).queryByText(nested.name)).toBeNull();
        expect(within(row()).queryByText(transcript)).toBeNull();
        expect(folder.classList.contains("truncate")).toBe(true);
        expect(folder.parentElement?.classList.contains("min-w-0")).toBe(true);
    });

    it("shows only the nested private folder name with a full path tooltip", () => {
        showList({
            assignments: [{ recordingId: recording.id, folderId: nested.id }],
        });
        const folder = within(row()).getByText(nested.name);
        expect(folder.parentElement?.title).toBe("Private / Vespari / Nerivo");
        expect(
            folder.parentElement
                ?.querySelector("svg")
                ?.classList.contains("text-primary"),
        ).toBe(true);
        expect(within(row()).queryByText(parent.name)).toBeNull();
    });

    it("shows only duration and date without an assignment", () => {
        showList();
        const metadata =
            row().querySelector("h3")?.parentElement?.nextElementSibling;
        expect(metadata?.children).toHaveLength(1);
        expect(metadata?.textContent).toContain("1:00");
        expect(metadata?.querySelector("svg")).toBeNull();
        expect(within(row()).queryByText(transcript)).toBeNull();
    });

    it.each([
        parent,
        organization,
    ])("does not repeat the current folder $id", (folder) => {
        const assignments = [
            { recordingId: recording.id, folderId: folder.id },
        ];
        showList({
            folder,
            assignments,
            rowLocations: folderRowLocations(folders, assignments, folder),
        });
        expect(row().querySelector("svg.lucide-folder")).toBeNull();
        expect(within(row()).queryByText(folder.name)).toBeNull();
    });

    it.each([
        { folder: parent, child: nested, colour: "text-primary" },
        { folder: organization, child: orgChild, colour: "text-organization" },
    ])("keeps the subfolder line once in $folder.id", ({
        folder,
        child,
        colour,
    }) => {
        const assignments = [{ recordingId: recording.id, folderId: child.id }];
        showList({
            folder,
            assignments,
            rowLocations: folderRowLocations(folders, assignments, folder),
        });
        expect(within(row()).getAllByText(child.name)).toHaveLength(1);
        expect(
            row()
                .querySelector("svg.lucide-folder")
                ?.classList.contains(colour),
        ).toBe(true);
        expect(row().querySelector("[title]")).toBeNull();
    });

    it("keeps the mail sender instead of folder or transcript", () => {
        showList({
            recordings: [
                {
                    ...recording,
                    kind: "mail",
                    mail: {
                        from: "Tavira <tavira@example.test>",
                        senderVerified: true,
                        hasAttachments: false,
                        waitingToShare: true,
                        autoGenerated: false,
                    },
                },
            ],
            assignments: [{ recordingId: recording.id, folderId: orgChild.id }],
        });
        expect(
            within(row()).getByText("Tavira <tavira@example.test>"),
        ).toBeTruthy();
        expect(within(row()).queryByText(orgChild.name)).toBeNull();
        expect(
            row()
                .querySelector("svg.lucide-share2")
                ?.classList.contains("text-organization"),
        ).toBe(true);
    });

    it.each([
        "audio",
        "mail",
    ] as const)("keeps a server search snippet for %s and restores the folder or sender on clear", async (kind) => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                Response.json({
                    hits: [
                        {
                            id: recording.id,
                            snippet: "The Talvori result in context",
                        },
                    ],
                    complete: true,
                    continueBefore: null,
                }),
            ),
        );
        showList({
            recordings: [
                {
                    ...recording,
                    kind,
                    ...(kind === "mail"
                        ? {
                              mail: {
                                  from: "Tavira",
                                  senderVerified: true,
                                  hasAttachments: false,
                                  waitingToShare: false,
                                  autoGenerated: false,
                              },
                          }
                        : {}),
                },
            ],
            assignments: [{ recordingId: recording.id, folderId: orgChild.id }],
        });
        const search = screen.getByRole("textbox", {
            name: "Search recordings",
        });
        fireEvent.change(search, { target: { value: "Talvori" } });
        await waitFor(() =>
            expect(
                within(row()).getByText("The Talvori result in context"),
            ).toBeTruthy(),
        );
        expect(within(row()).queryByText(orgChild.name)).toBeNull();
        fireEvent.change(search, { target: { value: "" } });
        expect(
            within(row()).queryByText("The Talvori result in context"),
        ).toBeNull();
        expect(
            within(row()).getByText(kind === "mail" ? "Tavira" : orgChild.name),
        ).toBeTruthy();
    });

    it("shows the local search match beyond the transcript opening", () => {
        showList({
            transcriptions: new Map([
                [
                    recording.id,
                    {
                        readText: `${"Unrelated words. ".repeat(30)}A Talvori decision was agreed.`,
                    },
                ],
            ]),
        });
        fireEvent.change(
            screen.getByRole("textbox", { name: "Search recordings" }),
            { target: { value: "Talvori" } },
        );
        expect(
            within(row()).getByText(/A Talvori decision was agreed/),
        ).toBeTruthy();
        expect(row().textContent).not.toContain("Unrelated words. ".repeat(20));
    });

    it("uses only Organization assignments in the Organization view", () => {
        showList({
            searchView: "org",
            recordings: [{ ...recording, view: "org" }],
            assignments: [
                { recordingId: recording.id, folderId: nested.id },
                { recordingId: recording.id, folderId: orgChild.id },
            ],
        });
        expect(within(row()).getByText(orgChild.name)).toBeTruthy();
        expect(within(row()).queryByText(nested.name)).toBeNull();
    });
});
