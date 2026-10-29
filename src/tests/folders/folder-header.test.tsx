// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryLocationHeader } from "@/components/dashboard/library-location-header";
import type { RecordingFolder } from "@/types/folder";

const root: RecordingFolder = {
    id: "root",
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
afterEach(cleanup);
function header(
    variant: "rail" | "walk",
    target: RecordingFolder | null = folder,
    canCurate = false,
) {
    const create = vi.fn(),
        move = vi.fn(),
        settings = vi.fn(),
        agenda = vi.fn();
    function Header() {
        const [view, setView] = useState<"tasks" | "knowledge" | null>(null);
        return (
            <LibraryLocationHeader
                variant={variant}
                part="header"
                organization={{
                    folders: [root, ...(target ? [target] : [])],
                    assignments: [],
                }}
                folder={target}
                recordings={[]}
                shownCount={7}
                canCurate={canCurate}
                onNavigate={vi.fn()}
                onSettings={settings}
                onTasks={() => setView(view === "tasks" ? null : "tasks")}
                tasksOpen={view === "tasks"}
                onKnowledge={() =>
                    setView(view === "knowledge" ? null : "knowledge")
                }
                knowledgeOpen={view === "knowledge"}
                onNewFolder={create}
                onMoveFolder={move}
                onPrepareMeeting={agenda}
                onAssign={vi.fn()}
                onMove={vi.fn()}
            />
        );
    }
    render(<Header />);
    return { create, move, settings, agenda };
}
describe.each(["rail", "walk"] as const)("%s folder header", (variant) => {
    it("puts the count at the right of the name row and orders the separate action toolbar", () => {
        const { create, move, settings, agenda } = header(variant);
        const toolbar = screen.getByRole("toolbar", { name: "Folder actions" });
        const count = screen.getByTitle("7 items, including subfolders");
        expect(count.classList.contains("ml-auto")).toBe(true);
        expect(count.classList.contains("tabular-nums")).toBe(true);
        expect(count.parentElement?.lastElementChild).toBe(count);
        expect(toolbar.previousElementSibling?.contains(count)).toBe(true);
        expect(
            toolbar.previousElementSibling?.querySelector(".lucide-folder"),
        ).toBeTruthy();
        expect(
            within(toolbar)
                .getAllByRole("button")
                .map((button) => button.getAttribute("aria-label")),
        ).toEqual([
            "Prepare an agenda",
            "Folder tasks",
            "Knowledge",
            "New subfolder",
            "Move to…",
            "Folder settings",
        ]);
        expect(toolbar.querySelectorAll(".w-px")).toHaveLength(2);
        for (const [name, callback] of [
            ["Prepare an agenda", agenda],
            ["New subfolder", create],
            ["Move to…", move],
            ["Folder settings", settings],
        ] as const) {
            const button = within(toolbar).getByRole("button", { name });
            expect(
                button.querySelector("svg")?.getAttribute("class"),
            ).not.toMatch(/text-(meeting|tasks|knowledge|organization)/);
            fireEvent.click(button);
            expect(callback).toHaveBeenCalledOnce();
        }
    });
    it("colours only the open view and closes it on a second click", () => {
        header(variant, { ...folder, scope: "org" });
        const tasks = screen.getByRole("button", { name: "Folder tasks" });
        const knowledge = screen.getByRole("button", { name: "Knowledge" });
        expect(tasks.getAttribute("aria-pressed")).toBe("false");
        expect(knowledge.getAttribute("aria-pressed")).toBe("false");
        expect(
            knowledge.querySelector("svg")?.getAttribute("class"),
        ).not.toMatch(/text-(knowledge|organization)/);
        fireEvent.click(tasks);
        expect(tasks.getAttribute("aria-pressed")).toBe("true");
        expect(tasks.classList.contains("bg-accent")).toBe(true);
        expect(tasks.querySelector(".text-tasks")).toBeTruthy();
        fireEvent.click(knowledge);
        expect(tasks.getAttribute("aria-pressed")).toBe("false");
        expect(tasks.querySelector(".text-tasks")).toBeNull();
        expect(knowledge.getAttribute("aria-pressed")).toBe("true");
        expect(knowledge.querySelector(".text-knowledge")).toBeTruthy();
        fireEvent.click(knowledge);
        expect(knowledge.getAttribute("aria-pressed")).toBe("false");
        fireEvent.click(tasks);
        fireEvent.click(tasks);
        expect(tasks.getAttribute("aria-pressed")).toBe("false");
    });
    it("keeps received-folder scope and menu, with Tasks but without owner actions", () => {
        header(variant, {
            ...folder,
            receivedFolder: {
                shareId: "share",
                shareVersion: 1,
                ownerName: "Lada Cloudfern",
                originalName: "Shared",
            },
        });
        const toolbar = screen.getByRole("toolbar");
        expect(
            within(toolbar)
                .getAllByRole("button")
                .map((button) => button.getAttribute("aria-label")),
        ).toEqual([
            "Prepare an agenda",
            "Folder tasks",
            "Folder actions for Projects",
        ]);
        expect(
            toolbar.previousElementSibling?.querySelector(".text-person-share"),
        ).toBeTruthy();
    });
    it("lets members create below Organization folders but reserves moving for curators", () => {
        header(variant, { ...folder, scope: "org" });
        expect(
            screen.getByRole("button", { name: "New subfolder" }),
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Move to…" })).toBeNull();
        cleanup();
        header(variant, { ...folder, scope: "org", parentId: null });
        expect(
            screen.queryByRole("button", { name: "New subfolder" }),
        ).toBeNull();
        cleanup();
        header(variant, { ...folder, scope: "org" }, true);
        expect(screen.getByRole("button", { name: "Move to…" })).toBeTruthy();
    });
    it("keeps Recent's count on the right without folder-specific actions", () => {
        header(variant, null);
        const count = screen.getByTitle("7 items");
        expect(count.classList.contains("ml-auto")).toBe(true);
        expect(
            within(screen.getByRole("toolbar")).getAllByRole("button"),
        ).toHaveLength(1);
    });
});
