// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { FolderTree } from "@/components/dashboard/folder-tree";
import { LibraryLocationHeader } from "@/components/dashboard/library-location-header";
import { RecordingList } from "@/components/dashboard/recording-list";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
    RECORDING_DRAG_TYPE,
    RECORDING_OTHER_OWNER_DRAG_TYPE,
    RECORDING_SOURCE_FOLDER_DRAG_TYPE,
    RECORDING_SOURCE_SCOPE_DRAG_TYPES,
} from "@/lib/folders/drag";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

const root: RecordingFolder = {
    id: "private",
    name: "Private",
    parentId: null,
    kind: "private",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};
const org: RecordingFolder = {
    ...root,
    id: "org",
    name: "Organization",
    kind: "public",
    scope: "org",
};
const children: RecordingFolder[] = Array.from({ length: 12 }, (_, index) => ({
    ...root,
    id: `f${index}`,
    name: `Folder ${index}`,
    parentId: root.id,
    kind: "custom",
    sortOrder: index,
}));
const nested: RecordingFolder = {
    ...children[0],
    id: "nested",
    parentId: "f0",
    name: "Nested",
};
const folders = [root, org, ...children, nested];
const recordings: Recording[] = children.map((_folder, index) => ({
    id: `r${index}`,
    filename: `Item ${index}`,
    duration: 1000 * index,
    filesize: 100 * (12 - index),
    startTime: new Date(index * 1000).toISOString(),
    deviceSn: "local",
}));
const assignments = children.map((folder, index) => ({
    folderId: folder.id,
    recordingId: `r${index}`,
}));
const assign = vi.fn().mockResolvedValue(undefined);
const move = vi.fn().mockResolvedValue(undefined);
let intersect: IntersectionObserverCallback;
let rootObserved: Element | Document | null | undefined;
class Observer {
    constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
    ) {
        intersect = callback;
        rootObserved = options?.root;
    }
    observe() {}
    disconnect() {}
}
const treeProps: ComponentProps<typeof FolderTree> = {
    folders,
    assignments,
    recordings,
    selectedFolderId: null,
    onRecent: vi.fn(),
    onSettings: vi.fn(),
    onSelectFolder: vi.fn(),

    onMoveFolder: vi.fn(),

    onAssignRecording: assign,
    onMoveRecording: move,
};
const headerProps: Omit<
    ComponentProps<typeof LibraryLocationHeader>,
    "variant"
> = {
    organization: { folders, assignments },
    recordings,
    folder: null,
    onNavigate: vi.fn(),
    onSettings: vi.fn(),
    onNewFolder: vi.fn(),
    onAssign: assign,
    onMove: move,
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IntersectionObserver", Observer);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
            unobserve() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({
            matches: true,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function transfer() {
    const data = new Map<string, string>();
    return {
        get types() {
            return [...data.keys()];
        },
        effectAllowed: "none",
        dropEffect: "none",
        setData: (key: string, value: string) => data.set(key, value),
        getData: (key: string) => data.get(key) ?? "",
    };
}

const orgSource: RecordingFolder = {
    ...nested,
    id: "org-source",
    parentId: org.id,
    scope: "org",
    name: "Shared source",
};
const orgTarget: RecordingFolder = {
    ...orgSource,
    id: "org-target",
    name: "Shared target",
};
const sharedFolders = [root, org, orgSource, orgTarget, children[0]];
const roles = [
    {
        role: "owner",
        isOwn: true,
        canCurate: false,
        isOrgAccount: false,
    },
    {
        role: "curator",
        isOwn: false,
        canCurate: true,
        isOrgAccount: false,
    },
    {
        role: "organization account",
        isOwn: false,
        canCurate: false,
        isOrgAccount: true,
    },
    {
        role: "member",
        isOwn: false,
        canCurate: false,
        isOrgAccount: false,
    },
];

function organizationDropTests(variant: "rail" | "walk") {
    it.each(
        roles.flatMap((role) =>
            [false, true].map((fromFolder) => ({ ...role, fromFolder })),
        ),
    )("files or moves shared items for $role: fromFolder=$fromFolder", ({
        isOwn,
        canCurate,
        fromFolder,
    }) => {
        const item = { ...recordings[0], view: "org" as const, isOwn };
        const placements = [{ recordingId: item.id, folderId: orgSource.id }];
        render(
            variant === "rail" ? (
                <FolderTree
                    {...treeProps}
                    folders={sharedFolders}
                    recordings={[item]}
                    assignments={placements}
                    canCurate={canCurate}
                />
            ) : (
                <LibraryLocationHeader
                    {...headerProps}
                    variant="walk"
                    organization={{
                        folders: sharedFolders,
                        assignments: placements,
                    }}
                    recordings={[item]}
                    folder={org}
                    canCurate={canCurate}
                />
            ),
        );
        const dataTransfer = transfer();
        dataTransfer.setData(RECORDING_DRAG_TYPE, item.id);
        if (fromFolder) {
            dataTransfer.setData(
                RECORDING_SOURCE_FOLDER_DRAG_TYPE,
                orgSource.id,
            );
            dataTransfer.setData(RECORDING_SOURCE_SCOPE_DRAG_TYPES.org, "org");
        }
        if (!isOwn)
            dataTransfer.setData(RECORDING_OTHER_OWNER_DRAG_TYPE, "true");
        const target = screen.getByRole("button", { name: /^Shared target/ });
        fireEvent.dragOver(target, { dataTransfer });
        expect(dataTransfer.dropEffect).toBe(fromFolder ? "move" : "copy");
        fireEvent.drop(target, { dataTransfer });
        if (fromFolder) {
            expect(move).toHaveBeenCalledExactlyOnceWith(
                item.id,
                orgSource.id,
                orgTarget.id,
            );
            expect(assign).not.toHaveBeenCalled();
        } else {
            expect(assign).toHaveBeenCalledExactlyOnceWith(
                item.id,
                orgTarget.id,
            );
            expect(move).not.toHaveBeenCalled();
        }
    });
    it.each(
        roles
            .filter((role) => !role.isOwn)
            .flatMap((role) =>
                [false, true].map((marked) => ({ ...role, marked })),
            ),
    )("refuses a colleague's item on a personal target for $role: marked=$marked", ({
        canCurate,
        marked,
    }) => {
        const item = { ...recordings[0], view: "org" as const, isOwn: false };
        render(
            variant === "rail" ? (
                <FolderTree
                    {...treeProps}
                    folders={sharedFolders}
                    recordings={[item]}
                    canCurate={canCurate}
                />
            ) : (
                <LibraryLocationHeader
                    {...headerProps}
                    variant="walk"
                    organization={{ folders: sharedFolders, assignments: [] }}
                    recordings={[item]}
                    folder={root}
                    canCurate={canCurate}
                />
            ),
        );
        const dataTransfer = transfer();
        dataTransfer.setData(RECORDING_DRAG_TYPE, item.id);
        if (marked)
            dataTransfer.setData(RECORDING_OTHER_OWNER_DRAG_TYPE, "true");
        const target = screen.getByRole("button", { name: /^Folder 0/ });
        fireEvent.dragOver(target, { dataTransfer });
        if (marked) expect(dataTransfer.dropEffect).toBe("none");
        fireEvent.drop(target, { dataTransfer });
        expect(dataTransfer.dropEffect).toBe("none");
        expect(move).not.toHaveBeenCalled();
        expect(assign).not.toHaveBeenCalled();
    });
}

describe("library rail", () => {
    organizationDropTests("rail");
    it.each([
        ["MacIntel", "⌘K"],
        ["Linux x86_64", "Ctrl K"],
    ])("uses the platform shortcut for %s", (platform, hint) => {
        const platformSpy = vi
            .spyOn(navigator, "platform", "get")
            .mockReturnValue(platform);
        render(<FolderTree {...treeProps} />);
        expect(screen.getByText(hint)).toBeTruthy();
        platformSpy.mockRestore();
    });
    it("uses an icon collapse button beside the folder filter and shows Recent's count", () => {
        const collapse = vi.fn();
        render(
            <TooltipProvider>
                <FolderTree {...treeProps} onCollapse={collapse} />
            </TooltipProvider>,
        );
        const button = screen.getByRole("button", { name: "Hide folders" });
        expect(button.textContent).toBe("");
        expect(button.querySelector("svg")).toBeTruthy();
        expect(
            button.parentElement?.contains(
                screen.getByPlaceholderText("Find a folder"),
            ),
        ).toBe(true);
        expect(screen.getByText("Ctrl K")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Recent12" })).toBeTruthy();
        fireEvent.click(button);
        expect(collapse).toHaveBeenCalledOnce();
    });
    it("allows the current path to collapse after expanding it on navigation", () => {
        render(<FolderTree {...treeProps} selectedFolderId="nested" />);
        const row = screen.getByRole("button", {
            name: "Folder 0, 1 recording",
        });
        const toggle = within(row.parentElement as HTMLElement).getByRole(
            "button",
            { name: "Collapse folder" },
        );
        fireEvent.click(toggle);
        expect(
            screen.queryByRole("button", { name: "Nested, 0 recordings" }),
        ).toBeNull();
        fireEvent.click(toggle);
        expect(
            screen.getByRole("button", { name: "Nested, 0 recordings" }),
        ).toBeTruthy();
    });
    it("shows eight folders by activity in normal order and includes the current path", () => {
        render(
            <ConfirmDialogProvider>
                <FolderTree {...treeProps} selectedFolderId="nested" />
            </ConfirmDialogProvider>,
        );
        expect(
            screen.getByRole("button", { name: "Folder 0, 1 recording" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Nested, 0 recordings" }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Folder 1, 1 recording" }),
        ).toBeNull();
        const rows = screen.getAllByRole("button", { name: /^Folder \d+,/ });
        expect(rows.map((row) => row.textContent)).toEqual([
            "Folder 01",
            "Folder 51",
            "Folder 61",
            "Folder 71",
            "Folder 81",
            "Folder 91",
            "Folder 101",
            "Folder 111",
        ]);
        fireEvent.click(screen.getByRole("button", { name: "All 12 folders" }));
        expect(
            screen.getAllByRole("button", { name: /^Folder \d+,/ }),
        ).toHaveLength(12);
    });
    it("collapses below the first level and searches all path matches", () => {
        render(
            <ConfirmDialogProvider>
                <FolderTree {...treeProps} />
            </ConfirmDialogProvider>,
        );
        expect(screen.queryByRole("button", { name: /Nested,/ })).toBeNull();
        fireEvent.change(
            screen.getByRole("textbox", { name: "Search folders" }),
            { target: { value: "nested" } },
        );
        expect(screen.getByRole("button", { name: /Nested,/ })).toBeTruthy();
    });
    it("files a cross-scope drop without withdrawing its source assignment", () => {
        render(
            <ConfirmDialogProvider>
                <FolderTree {...treeProps} />
            </ConfirmDialogProvider>,
        );
        const dataTransfer = transfer();
        dataTransfer.setData(RECORDING_DRAG_TYPE, "r0");
        dataTransfer.setData(RECORDING_SOURCE_FOLDER_DRAG_TYPE, "f0");
        dataTransfer.setData(
            RECORDING_SOURCE_SCOPE_DRAG_TYPES.personal,
            "personal",
        );
        fireEvent.dragOver(
            screen.getByRole("button", { name: "Organization, 0 recordings" }),
            { dataTransfer },
        );
        expect(dataTransfer.dropEffect).toBe("copy");
        fireEvent.drop(
            screen.getByRole("button", { name: "Organization, 0 recordings" }),
            { dataTransfer },
        );
        expect(assign).toHaveBeenCalledWith("r0", "org");
        expect(move).not.toHaveBeenCalled();
    });
    it.each([
        false,
        true,
    ])("a row dropped on a rail folder %s moves or files it", (fromFolder) => {
        render(
            <ConfirmDialogProvider>
                <FolderTree {...treeProps} />
                <RecordingList
                    recordings={[recordings[0]]}
                    transcriptions={new Map()}
                    currentRecording={null}
                    pendingUploads={[]}
                    inFlightActions={new Map()}
                    onSelect={vi.fn()}
                    onDelete={vi.fn()}
                    initialDateTimeFormat="relative"
                    initialSortOrder="newest"
                    initialChunkSize={50}
                    folder={fromFolder ? children[0] : null}
                    folders={folders}
                    rowLocations={new Map([["r0", [children[0]]]])}
                    assignments={assignments}
                    onAssignRecording={assign}
                    onMoveRecording={move}
                />
            </ConfirmDialogProvider>,
        );
        const dataTransfer = transfer();
        fireEvent.dragStart(screen.getByRole("button", { name: /Item 0/ }), {
            dataTransfer,
        });
        expect(dataTransfer.getData(RECORDING_DRAG_TYPE)).toBe("r0");
        if (fromFolder)
            expect(
                dataTransfer.getData(RECORDING_SOURCE_FOLDER_DRAG_TYPE),
            ).toBe("f0");
        fireEvent.dragOver(
            screen.getByRole("button", { name: "Folder 11, 1 recording" }),
            { dataTransfer },
        );
        expect(dataTransfer.dropEffect).toBe(fromFolder ? "move" : "copy");
        fireEvent.drop(
            screen.getByRole("button", { name: "Folder 11, 1 recording" }),
            { dataTransfer },
        );
        if (fromFolder) expect(move).toHaveBeenCalledWith("r0", "f0", "f11");
        else expect(assign).toHaveBeenCalledWith("r0", "f11");
    });
});

describe("rail tiles", () => {
    it("renders nothing without walking the folder hierarchy", () => {
        const parent = vi.fn(() => nested.parentId);
        const tracked = {
            ...nested,
            get parentId() {
                return parent();
            },
        };
        render(
            <LibraryLocationHeader
                {...headerProps}
                organization={{ folders: [tracked], assignments: [] }}
                navigation={{
                    entries: [],
                    counts: new Map(),
                    activity: new Map(),
                }}
                folder={tracked}
                variant="rail"
                part="tiles"
            />,
        );
        expect(screen.queryByRole("region")).toBeNull();
        expect(parent).not.toHaveBeenCalled();
    });
});

describe("walk-in navigation", () => {
    organizationDropTests("walk");
    it("shows root tiles with item and folder counts", () => {
        render(<LibraryLocationHeader {...headerProps} variant="walk" />);
        expect(
            screen.getByRole("button", {
                name: /Private.*12 items.*13 folders/,
            }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", {
                name: /Organization.*0 items.*0 folders/,
            }),
        ).toBeTruthy();
    });
    it("shows six active subfolders, a breadcrumb and expands all folders", () => {
        render(
            <LibraryLocationHeader
                {...headerProps}
                folder={root}
                variant="walk"
            />,
        );
        const tiles = screen.getAllByRole("button", { name: /^Folder \d+/ });
        expect(tiles).toHaveLength(6);
        expect(tiles.map((tile) => tile.textContent)).toEqual([
            "Folder 61",
            "Folder 71",
            "Folder 81",
            "Folder 91",
            "Folder 101",
            "Folder 111",
        ]);
        fireEvent.click(screen.getByRole("button", { name: "All 12 folders" }));
        expect(
            screen.getAllByRole("button", { name: /^Folder \d+/ }),
        ).toHaveLength(12);
        expect(screen.queryByRole("textbox")).toBeNull();
    });
    it("moves a row dragged from a folder onto a walk-in subfolder tile", () => {
        render(
            <ConfirmDialogProvider>
                <LibraryLocationHeader
                    {...headerProps}
                    folder={root}
                    variant="walk"
                />
                <RecordingList
                    recordings={[recordings[0]]}
                    transcriptions={new Map()}
                    currentRecording={null}
                    pendingUploads={[]}
                    inFlightActions={new Map()}
                    onSelect={vi.fn()}
                    onDelete={vi.fn()}
                    initialDateTimeFormat="relative"
                    initialSortOrder="newest"
                    initialChunkSize={50}
                    folder={children[0]}
                    folders={folders}
                    rowLocations={new Map([["r0", [children[0]]]])}
                    assignments={assignments}
                    onAssignRecording={assign}
                    onMoveRecording={move}
                />
            </ConfirmDialogProvider>,
        );
        const dataTransfer = transfer();
        fireEvent.dragStart(screen.getByRole("button", { name: /Item 0/ }), {
            dataTransfer,
        });
        fireEvent.drop(screen.getByRole("button", { name: "Folder 111" }), {
            dataTransfer,
        });
        expect(move).toHaveBeenCalledWith("r0", "f0", "f11");
        expect(assign).not.toHaveBeenCalled();
    });
    it("accepts a recording dropped onto a subfolder", () => {
        render(
            <LibraryLocationHeader
                {...headerProps}
                folder={root}
                variant="walk"
            />,
        );
        const dataTransfer = transfer();
        dataTransfer.setData(RECORDING_DRAG_TYPE, "r0");
        fireEvent.drop(screen.getByRole("button", { name: "Folder 111" }), {
            dataTransfer,
        });
        expect(assign).toHaveBeenCalledWith("r0", "f11");
    });
});

describe.each(["rail", "walk"] as const)("%s location header", (variant) => {
    it("marks the same current location and opens its settings", () => {
        render(
            <LibraryLocationHeader
                {...headerProps}
                folder={nested}
                variant={variant}
                part="header"
                shownCount={3}
                onKnowledge={vi.fn()}
            />,
        );
        const nav = screen.getByRole("navigation", { name: "Folder path" });
        const current = within(nav).getByRole("button", {
            name: "Folder settings for Nested",
        });
        expect(current.getAttribute("aria-current")).toBe("location");
        fireEvent.click(current);
        expect(headerProps.onSettings).toHaveBeenCalledWith(nested);
        fireEvent.click(
            screen.getByRole("button", { name: "Folder settings" }),
        );
        expect(headerProps.onSettings).toHaveBeenCalledTimes(2);
        expect(
            screen.getByRole("button", { name: "Knowledge" }).textContent,
        ).toBe("");
        expect(screen.getByText("3 items, including subfolders")).toBeTruthy();
    });

    it("hides the count of an empty list", () => {
        render(
            <LibraryLocationHeader
                {...headerProps}
                folder={nested}
                variant={variant}
                part="header"
                shownCount={0}
            />,
        );
        expect(screen.queryByText(/including subfolders/)).toBeNull();
    });

    it("names each icon action in a tooltip on focus", async () => {
        render(
            <LibraryLocationHeader
                {...headerProps}
                folder={nested}
                variant={variant}
                part="header"
                onKnowledge={vi.fn()}
                onShowRail={vi.fn()}
            />,
        );
        const names =
            variant === "walk"
                ? [
                      "Back to parent folder",
                      "Knowledge",
                      "Folder settings",
                      "Show folders",
                  ]
                : ["Knowledge", "Folder settings"];
        for (const name of names) {
            const button = screen.getByRole("button", { name });
            expect(button.title).toBe("");
            fireEvent.focus(button);
            expect(await screen.findByRole("tooltip", { name })).toBeTruthy();
        }
    });
});

it("shows the breadcrumb without the rail and only the folder beside it", () => {
    const walk = render(
        <LibraryLocationHeader
            {...headerProps}
            folder={nested}
            variant="walk"
            part="header"
        />,
    );
    const walkPath = screen.getByRole("navigation", { name: "Folder path" });
    fireEvent.click(within(walkPath).getByRole("button", { name: "Private" }));
    expect(headerProps.onNavigate).toHaveBeenCalledWith(root);
    walk.unmount();

    render(
        <LibraryLocationHeader
            {...headerProps}
            folder={nested}
            variant="rail"
            part="header"
        />,
    );
    const railPath = screen.getByRole("navigation", { name: "Folder path" });
    expect(within(railPath).getAllByRole("button")).toHaveLength(1);
    expect(railPath.title).toBe("Private › Folder 0 › Nested");
});

it("offers no folder settings for a received folder", () => {
    const received: RecordingFolder = {
        ...nested,
        id: "received",
        name: "Shared research",
        receivedFolder: {
            shareId: "share",
            shareVersion: 1,
            ownerName: "Alex Morgan",
            originalName: "Research",
        },
    };
    render(
        <LibraryLocationHeader
            {...headerProps}
            organization={{ folders: [...folders, received], assignments }}
            folder={received}
            variant="rail"
            part="header"
            onKnowledge={vi.fn()}
        />,
    );
    expect(
        screen.queryByRole("button", { name: "Folder settings" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Knowledge" })).toBeNull();
    expect(
        screen.getByRole("button", {
            name: "Folder actions for Shared research",
        }),
    ).toBeTruthy();
});

describe("library item list", () => {
    it.each(
        roles.flatMap((role) =>
            [false, true].map((fromFolder) => ({ ...role, fromFolder })),
        ),
    )("allows dragging and row filing for $role: fromFolder=$fromFolder", async ({
        isOwn,
        canCurate,
        isOrgAccount,
        fromFolder,
    }) => {
        const item = { ...recordings[0], view: "org" as const, isOwn };
        const select = vi.fn();
        render(
            <ConfirmDialogProvider>
                <RecordingList
                    recordings={[item]}
                    transcriptions={new Map()}
                    currentRecording={null}
                    pendingUploads={[]}
                    inFlightActions={new Map()}
                    onSelect={select}
                    onDelete={vi.fn()}
                    initialDateTimeFormat="relative"
                    initialSortOrder="newest"
                    initialChunkSize={50}
                    folder={fromFolder ? orgSource : org}
                    folders={sharedFolders}
                    rowLocations={new Map([[item.id, [orgSource]]])}
                    assignments={[
                        { recordingId: item.id, folderId: orgSource.id },
                    ]}
                    onAssignRecording={assign}
                    onMoveRecording={move}
                    canCurate={canCurate}
                    isOrgAccount={isOrgAccount}
                />
            </ConfirmDialogProvider>,
        );
        const row = screen.getByRole("button", { name: /Item 0/ });
        expect(row.draggable).toBe(true);
        const dataTransfer = transfer();
        fireEvent.dragStart(row, { dataTransfer });
        expect(dataTransfer.getData(RECORDING_DRAG_TYPE)).toBe(item.id);
        expect(dataTransfer.getData(RECORDING_OTHER_OWNER_DRAG_TYPE)).toBe(
            isOwn ? "" : "true",
        );
        expect(dataTransfer.getData(RECORDING_SOURCE_FOLDER_DRAG_TYPE)).toBe(
            fromFolder ? orgSource.id : "",
        );
        fireEvent.click(row);
        expect(select).toHaveBeenCalledWith(item);
        fireEvent.pointerDown(
            screen.getByRole("button", { name: "Row actions" }),
            { button: 0, ctrlKey: false },
        );
        fireEvent.click(
            screen.getByRole("menuitem", {
                name: fromFolder ? "Move to…" : "Add to folder",
            }),
        );
        expect(
            screen.queryByRole("option", { name: "Folder 0" }) !== null,
        ).toBe(isOwn && !fromFolder);
        fireEvent.click(screen.getByRole("option", { name: "Shared target" }));
        await act(async () => {});
        if (fromFolder) {
            expect(move).toHaveBeenCalledExactlyOnceWith(
                item.id,
                orgSource.id,
                orgTarget.id,
            );
            expect(assign).not.toHaveBeenCalled();
        } else {
            expect(assign).toHaveBeenCalledExactlyOnceWith(
                item.id,
                orgTarget.id,
            );
            expect(move).not.toHaveBeenCalled();
        }
    });

    it("observes the page below lg and keeps header and toolbar outside the desktop scroller", () => {
        vi.stubGlobal(
            "matchMedia",
            vi.fn(() => ({
                matches: false,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            })),
        );
        render(
            <ConfirmDialogProvider>
                <RecordingList
                    recordings={recordings}
                    transcriptions={new Map()}
                    currentRecording={null}
                    pendingUploads={[]}
                    inFlightActions={new Map()}
                    onSelect={vi.fn()}
                    onDelete={vi.fn()}
                    initialDateTimeFormat="relative"
                    initialSortOrder="newest"
                    initialChunkSize={2}
                    header={(shown) => <span>Location header {shown}</span>}
                    navigationContent={<span>Folder tiles</span>}
                />
            </ConfirmDialogProvider>,
        );
        expect(rootObserved).toBeNull();
        const scroller = document.querySelector(
            "[data-library-scroll]",
        ) as HTMLElement;
        expect(scroller.contains(screen.getByText("Location header 12"))).toBe(
            false,
        );
        expect(
            scroller.contains(
                screen.getByRole("textbox", { name: "Search recordings" }),
            ),
        ).toBe(false);
        expect(scroller.contains(screen.getByText("Folder tiles"))).toBe(true);
        expect(scroller.className).toContain("lg:overflow-y-auto");
    });
    it.each([
        ["private", false],
        ["org", false],
        ["org", true],
    ] as const)("offers Delete for the owner's private view or Organization account: view=%s, account=%s", (view, isOrgAccount) => {
        const item = { ...recordings[0], view, isOwn: true };
        render(
            <ConfirmDialogProvider>
                <RecordingList
                    recordings={[item]}
                    isOrgAccount={isOrgAccount}
                    transcriptions={new Map()}
                    currentRecording={null}
                    pendingUploads={[]}
                    inFlightActions={new Map()}
                    sharedItemIds={new Set([item.id])}
                    onSelect={vi.fn()}
                    onDelete={vi.fn()}
                    initialDateTimeFormat="relative"
                    initialSortOrder="newest"
                    initialChunkSize={50}
                />
            </ConfirmDialogProvider>,
        );
        fireEvent.pointerDown(
            screen.getByRole("button", { name: "Row actions" }),
            { button: 0, ctrlKey: false },
        );
        if (view === "org" && !isOrgAccount)
            expect(
                screen.queryByRole("menuitem", { name: "Delete" }),
            ).toBeNull();
        else {
            fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
            expect(
                screen.getByText(
                    "This recording is shared with the Organization. It will be taken out of the Organization first, and colleagues will no longer see it.",
                ),
            ).toBeTruthy();
        }
    });
    it.each([
        root,
        org,
        children[0],
    ])("uses the same filing or moving source for a row's label and action in $id", async (folder) => {
        render(
            <ConfirmDialogProvider>
                <RecordingList
                    recordings={[recordings[0]]}
                    transcriptions={new Map()}
                    currentRecording={null}
                    pendingUploads={[]}
                    inFlightActions={new Map()}
                    onSelect={vi.fn()}
                    onDelete={vi.fn()}
                    initialDateTimeFormat="relative"
                    initialSortOrder="newest"
                    initialChunkSize={50}
                    folder={folder}
                    folders={folders}
                    rowLocations={new Map([["r0", [children[0]]]])}
                    assignments={assignments}
                    onAssignRecording={assign}
                    onMoveRecording={move}
                />
            </ConfirmDialogProvider>,
        );
        fireEvent.pointerDown(
            screen.getByRole("button", { name: "Row actions" }),
            { button: 0, ctrlKey: false },
        );
        fireEvent.click(
            screen.getByRole("menuitem", {
                name: folder.kind === "custom" ? "Move to…" : "Add to folder",
            }),
        );
        fireEvent.click(screen.getByRole("option", { name: "Folder 11" }));
        await act(async () => {});
        if (folder.kind === "custom")
            expect(move).toHaveBeenCalledWith("r0", "f0", "f11");
        else expect(assign).toHaveBeenCalledWith("r0", "f11");
    });
    it("loads more using its own scroll container", () => {
        render(
            <ConfirmDialogProvider>
                <RecordingList
                    recordings={recordings}
                    transcriptions={new Map()}
                    currentRecording={null}
                    pendingUploads={[]}
                    inFlightActions={new Map()}
                    onSelect={vi.fn()}
                    onDelete={vi.fn()}
                    initialDateTimeFormat="relative"
                    initialSortOrder="newest"
                    initialChunkSize={2}
                />
            </ConfirmDialogProvider>,
        );
        expect(rootObserved).toBe(
            document.querySelector("[data-library-scroll]"),
        );
        expect(screen.queryByText("Item 9")).toBeNull();
        act(() =>
            intersect(
                [{ isIntersecting: true } as IntersectionObserverEntry],
                {} as IntersectionObserver,
            ),
        );
        expect(screen.getByText("Item 9")).toBeTruthy();
    });
    it.each([
        "duration",
        "size",
    ] as const)("sorts by %s and preserves download actions", (sort) => {
        render(
            <ConfirmDialogProvider>
                <RecordingList
                    recordings={recordings.slice(0, 3)}
                    transcriptions={new Map()}
                    currentRecording={null}
                    pendingUploads={[]}
                    inFlightActions={new Map()}
                    onSelect={vi.fn()}
                    onDelete={vi.fn()}
                    initialDateTimeFormat="relative"
                    initialSortOrder={sort}
                    initialChunkSize={50}
                />
            </ConfirmDialogProvider>,
        );
        const titles = screen
            .getAllByRole("heading", { level: 3 })
            .map((heading) => heading.textContent);
        expect(titles).toEqual(
            sort === "duration"
                ? ["Item 2", "Item 1", "Item 0"]
                : ["Item 0", "Item 1", "Item 2"],
        );
        fireEvent.pointerDown(
            screen.getAllByRole("button", { name: "Row actions" })[0],
            { button: 0, ctrlKey: false },
        );
        expect(
            screen.getByRole("menuitem", { name: "Download audio" }),
        ).toBeTruthy();
    });
});
