// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/dashboard/command-palette";
import {
    LibraryPreferencesContext,
    useLibraryPreferencesState,
} from "@/hooks/use-library-preferences";
import type { RecordingFolder } from "@/types/folder";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const root: RecordingFolder = {
    id: "root",
    name: "Private",
    parentId: null,
    kind: "private",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};
const child: RecordingFolder = {
    ...root,
    id: "child",
    parentId: root.id,
    name: "Vývoj",
    kind: "custom",
};
class Observer {
    observe() {}
    disconnect() {}
    unobserve() {}
}

beforeEach(() => {
    vi.stubGlobal("ResizeObserver", Observer);
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            Response.json({
                chatter: [],
                almanac: [],
                tasks: [],
                limited: false,
            }),
        ),
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("command palette folders", () => {
    it("shows only recently used folders before typing", () => {
        function Palette() {
            const preferences = useLibraryPreferencesState(
                undefined,
                [root, child],
                [{ recordingId: "own", folderId: child.id }],
                [
                    {
                        id: "own",
                        filename: "Own",
                        startTime: "2026-10-21T12:00:00Z",
                        filesize: 1,
                        duration: 1,
                        deviceSn: "local",
                    },
                ],
            );
            return (
                <LibraryPreferencesContext.Provider value={preferences}>
                    <CommandPalette
                        open
                        onOpenChange={vi.fn()}
                        folders={[root, child]}
                        onSelectFolder={vi.fn()}
                        currentTheme="system"
                        dateTimeFormat="relative"
                        onSync={vi.fn()}
                        onUpload={vi.fn()}
                        onOpenSettings={vi.fn()}
                        onOpenShortcuts={vi.fn()}
                        onSetTheme={vi.fn()}
                    />
                </LibraryPreferencesContext.Provider>
            );
        }
        render(<Palette />);
        const results = document.querySelectorAll(
            '[cmdk-item][data-value^="folder:"]',
        );
        expect(results).toHaveLength(1);
        expect(results[0].textContent).toContain("Vývoj");
    });
    it("does not list all folders for an empty query, caps ranked matches, and keeps its top fixed", () => {
        render(
            <CommandPalette
                open
                onOpenChange={vi.fn()}
                folders={[
                    root,
                    child,
                    ...Array.from({ length: 12 }, (_, index) => ({
                        ...child,
                        id: `folder-${index}`,
                        name: `Folder ${index}`,
                    })),
                ]}
                onSelectFolder={vi.fn()}
                currentTheme="system"
                dateTimeFormat="relative"
                onSync={vi.fn()}
                onUpload={vi.fn()}
                onOpenSettings={vi.fn()}
                onOpenShortcuts={vi.fn()}
                onSetTheme={vi.fn()}
            />,
        );
        expect(
            document.querySelectorAll('[cmdk-item][data-value^="folder:"]'),
        ).toHaveLength(0);
        const dialog = screen.getByRole("dialog");
        expect(dialog.className).toContain("top-[15vh]");
        fireEvent.change(screen.getByRole("combobox"), {
            target: { value: "folder" },
        });
        expect(
            document.querySelectorAll('[cmdk-item][data-value^="folder:"]'),
        ).toHaveLength(8);
        expect(dialog.className).toContain("-translate-y-0");
    });
    it("matches folders without diacritics and navigates to their location", async () => {
        const onSelect = vi.fn();
        const close = vi.fn();
        render(
            <CommandPalette
                open
                onOpenChange={close}
                folders={[root, child]}
                onSelectFolder={onSelect}
                currentTheme="system"
                dateTimeFormat="relative"
                onSync={vi.fn()}
                onUpload={vi.fn()}
                onOpenSettings={vi.fn()}
                onOpenShortcuts={vi.fn()}
                onSetTheme={vi.fn()}
            />,
        );
        fireEvent.change(screen.getByRole("combobox"), {
            target: { value: "vyvoj" },
        });
        fireEvent.click(screen.getByRole("option", { name: /VývojPrivate/ }));
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(child));
        expect(close).toHaveBeenCalledWith(false);
    });
});
