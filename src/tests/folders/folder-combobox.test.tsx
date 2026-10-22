// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderCombobox } from "@/components/recordings/folder-combobox";
import { LibraryPreferencesContext } from "@/hooks/use-library-preferences";
import * as navigation from "@/lib/folders/navigation";
import { matchFolders } from "@/lib/folders/navigation";
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
const grove: RecordingFolder = {
    ...root,
    id: "grove",
    name: "Zářivý háj",
    parentId: root.id,
    kind: "custom",
};
const branch: RecordingFolder = {
    ...grove,
    id: "branch",
    name: "Nápady",
    parentId: grove.id,
};
const leaf: RecordingFolder = {
    ...grove,
    id: "leaf",
    name: "Pokusy",
    parentId: branch.id,
};
const org: RecordingFolder = {
    ...root,
    id: "org",
    name: "Organization",
    kind: "public",
    scope: "org",
};
const orgChild: RecordingFolder = {
    ...grove,
    id: "org-child",
    parentId: org.id,
    scope: "org",
    name: "Měsíční plán",
};
const entries = matchFolders(
    [root, grove, branch, leaf, org, orgChild],
    "",
).filter(({ folder }) => folder.parentId !== null);
const onValueChange = vi.fn();
const rememberFolder = vi.fn();

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
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function combobox(
    props: Partial<React.ComponentProps<typeof FolderCombobox>> = {},
) {
    return render(
        <FolderCombobox
            entries={entries}
            value=""
            onValueChange={onValueChange}
            {...props}
        />,
    );
}

function open() {
    const trigger = screen.getByRole("combobox", { name: "Folder" });
    fireEvent.click(trigger);
    return { trigger, input: screen.getByPlaceholderText("Find a folder…") };
}

describe("FolderCombobox", () => {
    it("opens with search focused and exposes the controlled listbox", () => {
        combobox();
        const { trigger, input } = open();
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        expect(trigger.getAttribute("aria-controls")).toBe(
            screen.getByRole("listbox").id,
        );
        expect(document.activeElement).toBe(input);
        expect(input.getAttribute("aria-controls")).toBe(
            screen.getByRole("listbox").id,
        );
    });

    it("matches accents and middle path segments, keeping long paths readable", () => {
        combobox();
        const { input } = open();
        fireEvent.change(input, { target: { value: "napady" } });
        expect(
            screen
                .getAllByRole("option")
                .map((option) => option.getAttribute("aria-label")),
        ).toEqual([
            "Nápady Private › Zářivý háj",
            "Pokusy Private › Zářivý háj › Nápady",
        ]);
        expect(
            screen.getByRole("option", { name: /Pokusy/ }).querySelector("span")
                ?.className,
        ).toContain("[overflow-wrap:anywhere]");
        fireEvent.change(input, { target: { value: "mesicni" } });
        expect(screen.getAllByRole("option")).toHaveLength(1);
        expect(screen.getByRole("option").textContent).toContain(
            "Měsíční plán",
        );
        fireEvent.change(input, {
            target: { value: "Unseen invented folder" },
        });
        expect(screen.getByText("No folders match your search.")).toBeTruthy();
    });

    it("opens by typing and selects with arrows and Enter, then restores focus", async () => {
        combobox();
        const trigger = screen.getByRole("combobox", { name: "Folder" });
        fireEvent.keyDown(trigger, { key: "n" });
        const input = screen.getByPlaceholderText("Find a folder…");
        expect(input).toHaveProperty("value", "n");
        fireEvent.change(input, { target: { value: "napady" } });
        fireEvent.keyDown(input, { key: "ArrowDown" });
        expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() => expect(onValueChange).toHaveBeenCalledWith("leaf"));
        expect(screen.queryByRole("listbox")).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it("closes on Escape and outside pointer click", () => {
        combobox();
        const { trigger, input } = open();
        fireEvent.keyDown(input, { key: "Escape" });
        expect(screen.queryByRole("listbox")).toBeNull();
        expect(document.activeElement).toBe(trigger);
        open();
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole("listbox")).toBeNull();
        expect(onValueChange).not.toHaveBeenCalled();
    });

    it("groups Organization folders and marks both results and selected value", () => {
        combobox({ value: "org-child" });
        const { trigger } = open();
        expect(trigger.textContent).toContain("Organization › Měsíční plán");
        expect(trigger.querySelector("svg.text-organization")).toBeTruthy();
        expect(
            screen.getByText("Private", { selector: "[cmdk-group-heading]" }),
        ).toBeTruthy();
        expect(
            screen.getByText("Organization", {
                selector: "[cmdk-group-heading]",
            }),
        ).toBeTruthy();
        expect(
            screen
                .getByRole("option", { name: /Měsíční plán/ })
                .querySelector("svg.text-organization"),
        ).toBeTruthy();
    });

    it("shows recent folders first on empty query and remembers selections", () => {
        render(
            <LibraryPreferencesContext.Provider
                value={{
                    ready: true,
                    preferences: {
                        expanded: null,
                        recent: ["leaf"],
                        collapsed: false,
                    },
                    setPreferences: vi.fn(),
                    recentFolders: [leaf],
                    rememberFolder,
                }}
            >
                <FolderCombobox
                    entries={entries}
                    value=""
                    onValueChange={onValueChange}
                />
            </LibraryPreferencesContext.Provider>,
        );
        const { input } = open();
        expect(screen.getAllByRole("option")[0].textContent).toContain(
            "Pokusy",
        );
        expect(screen.getByText("Recently used")).toBeTruthy();
        fireEvent.change(input, { target: { value: "mesicni" } });
        expect(screen.queryByText("Recently used")).toBeNull();
        fireEvent.click(screen.getByRole("option"));
        expect(rememberFolder).toHaveBeenCalledWith("org-child");
        expect(onValueChange).toHaveBeenCalledWith("org-child");
        expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("updates an open list without losing its query or surviving active option", () => {
        const { rerender } = combobox();
        const { input } = open();
        fireEvent.change(input, { target: { value: "napady" } });
        fireEvent.keyDown(input, { key: "ArrowDown" });
        const active = screen.getByRole("option", { name: /Pokusy/ });
        expect(active.getAttribute("aria-selected")).toBe("true");
        const added = { ...branch, id: "new-leaf", name: "Nápady Velno" };
        const updated = matchFolders(
            [root, grove, branch, leaf, added],
            "",
        ).filter(({ folder }) => folder.parentId !== null);
        rerender(
            <FolderCombobox
                entries={updated}
                value=""
                onValueChange={onValueChange}
            />,
        );
        expect(screen.getByPlaceholderText("Find a folder…")).toBe(input);
        expect(input).toHaveProperty("value", "napady");
        expect(
            screen.getByRole("option", { name: /Nápady Velno/ }),
        ).toBeTruthy();
        expect(active.getAttribute("aria-selected")).toBe("true");
        expect(input.getAttribute("aria-activedescendant")).toBe(active.id);
        rerender(
            <FolderCombobox
                entries={updated.filter(({ folder }) => folder.id !== leaf.id)}
                value=""
                onValueChange={onValueChange}
            />,
        );
        expect(
            screen.getAllByRole("option")[0].getAttribute("aria-selected"),
        ).toBe("true");
        fireEvent.keyDown(input, { key: "Enter" });
        expect(onValueChange).toHaveBeenCalledWith("branch");
    });

    it("refreshes renamed ancestor paths and moves across groups while preserving the active folder", () => {
        const { rerender } = combobox({ value: leaf.id });
        const { input, trigger } = open();
        fireEvent.change(input, { target: { value: "pokusy" } });
        const renamed = { ...grove, name: "Velno" };
        const moved = { ...leaf, parentId: orgChild.id, scope: "org" as const };
        const updated = matchFolders(
            [
                root,
                renamed,
                branch,
                { ...grove, id: "pokusy-velno", name: "Pokusy Velno" },
                org,
                orgChild,
                moved,
            ],
            "",
        ).filter(({ folder }) => folder.parentId !== null);
        rerender(
            <FolderCombobox
                entries={updated}
                value={leaf.id}
                onValueChange={onValueChange}
            />,
        );
        expect(trigger.textContent).toBe(
            "Organization › Měsíční plán › Pokusy",
        );
        expect(trigger.querySelector("svg.text-organization")).toBeTruthy();
        expect(input).toHaveProperty("value", "pokusy");
        const option = screen.getByRole("option", {
            name: "Pokusy Organization › Měsíční plán",
        });
        expect(option.getAttribute("aria-selected")).toBe("true");
        expect(input.getAttribute("aria-activedescendant")).toBe(option.id);
        fireEvent.change(input, { target: { value: "velno" } });
        expect(
            screen.getByRole("option", { name: "Nápady Private › Velno" }),
        ).toBeTruthy();
        expect(screen.queryByText(/Zářivý háj/)).toBeNull();
        expect(onValueChange).not.toHaveBeenCalled();
    });

    it("keeps an owner's missing value through loading and filtering", () => {
        const { rerender } = combobox({ entries: [], value: leaf.id });
        const trigger = screen.getByRole("combobox", { name: "Folder" });
        expect(trigger.textContent).toBe("Choose a folder");
        expect(onValueChange).not.toHaveBeenCalled();
        rerender(
            <FolderCombobox
                entries={entries}
                value={leaf.id}
                onValueChange={onValueChange}
            />,
        );
        expect(trigger.textContent).toContain("Pokusy");
        rerender(
            <FolderCombobox
                entries={entries.filter(({ folder }) => folder.id !== leaf.id)}
                value={leaf.id}
                onValueChange={onValueChange}
            />,
        );
        expect(trigger.textContent).toBe("Choose a folder");
        expect(onValueChange).not.toHaveBeenCalled();
    });

    it.each([
        false,
        true,
    ])("closes on Tab with shift=%s and lets the browser continue from the trigger", (shiftKey) => {
        combobox();
        const { trigger, input } = open();
        const unhandled = fireEvent.keyDown(input, { key: "Tab", shiftKey });
        expect(unhandled).toBe(true);
        expect(screen.queryByRole("listbox")).toBeNull();
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        expect(document.activeElement).toBe(trigger);
    });

    it("does not rematch folders or rebuild the DOM lookup when only the highlight changes", () => {
        const match = vi.spyOn(navigation, "matchFolderEntries");
        combobox();
        const { input } = open();
        const lookup = vi.spyOn(
            input.closest("[cmdk-root]") as HTMLElement,
            "querySelectorAll",
        );
        match.mockClear();
        fireEvent.keyDown(input, { key: "ArrowDown" });
        const option = screen.getByRole("option", { name: /Měsíční plán/ });
        fireEvent.pointerMove(option);
        expect(option.getAttribute("aria-selected")).toBe("true");
        expect(match).not.toHaveBeenCalled();
        expect(lookup).not.toHaveBeenCalledWith("[cmdk-item]");
    });

    it("ranks Organization name matches ahead of private path matches for acme", () => {
        combobox({
            entries: [
                {
                    folder: { ...branch, name: "Velno" },
                    path: "Private › Acme",
                    depth: 2,
                    nameMatch: true,
                },
                {
                    folder: { ...orgChild, name: "Acme" },
                    path: "Organization",
                    depth: 1,
                    nameMatch: true,
                },
            ],
        });
        const { input } = open();
        fireEvent.change(input, { target: { value: "acme" } });
        const options = screen.getAllByRole("option");
        expect(within(options[0]).getByText("Acme")).toBeTruthy();
        expect(options[0].querySelector("svg.text-organization")).toBeTruthy();
        expect(within(options[1]).getByText("Velno")).toBeTruthy();
        expect(
            screen.queryByText("Private", { selector: "[cmdk-group-heading]" }),
        ).toBeNull();
    });

    it("refreshes recent rows from current entries and the current recent ordering", () => {
        const preferences = {
            ready: true,
            preferences: {
                expanded: null,
                recent: [leaf.id],
                collapsed: false,
            },
            setPreferences: vi.fn(),
            recentFolders: [leaf],
            rememberFolder,
        };
        const view = (
            folders: RecordingFolder[],
            recentFolders = preferences.recentFolders,
        ) => (
            <LibraryPreferencesContext.Provider
                value={{ ...preferences, recentFolders }}
            >
                <FolderCombobox
                    entries={matchFolders(folders, "").filter(
                        ({ folder }) => folder.parentId !== null,
                    )}
                    value=""
                    onValueChange={onValueChange}
                />
            </LibraryPreferencesContext.Provider>
        );
        const { rerender } = render(view([root, grove, branch, leaf]));
        const { input } = open();
        const renamed = { ...branch, name: "Velno" };
        const newLeaf = { ...leaf, name: "Zulno" };
        rerender(view([root, grove, renamed, newLeaf]));
        expect(
            screen.getAllByRole("option")[0].getAttribute("aria-label"),
        ).toBe("Zulno Private › Zářivý háj › Velno");
        expect(screen.queryByText("Pokusy")).toBeNull();
        rerender(view([root, grove, renamed, newLeaf], [renamed, newLeaf]));
        expect(screen.getAllByRole("option")[0].textContent).toContain("Velno");
        rerender(view([root, grove, renamed], [newLeaf, renamed]));
        expect(
            screen.getAllByRole("option")[0].getAttribute("aria-label"),
        ).toBe("Velno Private › Zářivý háj");
        expect(screen.queryByText("Zulno")).toBeNull();
        expect(input).toHaveProperty("value", "");
    });

    it("offers the optional New folder action even after filtering", () => {
        const onCreate = vi.fn();
        combobox({ onCreate });
        const { input } = open();
        fireEvent.change(input, { target: { value: "Invented new branch" } });
        fireEvent.click(screen.getByRole("option", { name: "New folder…" }));
        expect(onCreate).toHaveBeenCalledExactlyOnceWith("Invented new branch");
        expect(onValueChange).not.toHaveBeenCalled();
        expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("cannot open when disabled", () => {
        combobox({ disabled: true });
        const trigger = screen.getByRole("combobox", { name: "Folder" });
        expect(trigger.hasAttribute("disabled")).toBe(true);
        fireEvent.click(trigger);
        fireEvent.keyDown(trigger, { key: "n" });
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("ignores list scrolls, coalesces positioning events and removes listeners on close", () => {
        vi.useFakeTimers();
        const viewport = Object.assign(new EventTarget(), {
            offsetTop: 0,
            offsetLeft: 0,
            height: 700,
            width: 400,
        });
        vi.stubGlobal("visualViewport", viewport);
        const schedule = vi.fn((callback: FrameRequestCallback) =>
            window.setTimeout(() => callback(performance.now()), 16),
        );
        const cancel = vi.fn((id: number) => window.clearTimeout(id));
        vi.stubGlobal("requestAnimationFrame", schedule);
        vi.stubGlobal("cancelAnimationFrame", cancel);
        const windowAdd = vi.spyOn(window, "addEventListener");
        const windowRemove = vi.spyOn(window, "removeEventListener");
        const viewportAdd = vi.spyOn(viewport, "addEventListener");
        const viewportRemove = vi.spyOn(viewport, "removeEventListener");
        const disconnect = vi.spyOn(Observer.prototype, "disconnect");
        combobox();
        const { input } = open();
        const trigger = screen.getByRole("combobox", { name: "Folder" });
        const measure = vi.spyOn(trigger, "getBoundingClientRect");
        schedule.mockClear();
        fireEvent.scroll(screen.getByRole("listbox"));
        expect(schedule).not.toHaveBeenCalled();
        fireEvent.scroll(window);
        fireEvent.resize(window);
        act(() => viewport.dispatchEvent(new Event("scroll")));
        act(() => viewport.dispatchEvent(new Event("resize")));
        expect(schedule).toHaveBeenCalledOnce();
        act(() => vi.advanceTimersByTime(16));
        expect(measure).toHaveBeenCalledOnce();
        fireEvent.scroll(window);
        fireEvent.keyDown(input, { key: "Escape" });
        expect(cancel).toHaveBeenCalled();
        expect(disconnect).toHaveBeenCalledOnce();
        for (const type of ["scroll", "resize"]) {
            const windowCall = windowAdd.mock.calls.find(
                ([event]) => event === type,
            );
            expect(windowCall).toBeTruthy();
            expect(windowRemove.mock.calls).toContainEqual(windowCall);
            const viewportCall = viewportAdd.mock.calls.find(
                ([event]) => event === type,
            );
            expect(viewportCall).toBeTruthy();
            expect(viewportRemove.mock.calls).toContainEqual(viewportCall);
        }
        act(() => vi.advanceTimersByTime(16));
        expect(measure).toHaveBeenCalledOnce();
    });

    it("opens above a low trigger and fits a 400px viewport", () => {
        vi.stubGlobal("innerWidth", 400);
        vi.stubGlobal("innerHeight", 700);
        vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
            x: 320,
            y: 620,
            top: 620,
            left: 320,
            right: 390,
            bottom: 656,
            width: 70,
            height: 36,
            toJSON: () => ({}),
        });
        combobox();
        open();
        const panel = screen
            .getByRole("listbox")
            .closest("[style]") as HTMLElement;
        expect(panel.style.position).toBe("fixed");
        expect(panel.style.top).toBe("616px");
        expect(panel.style.transform).toBe("translateY(-100%)");
        expect(panel.style.left).toBe("112px");
        expect(panel.style.width).toBe("280px");
        expect(panel.style.maxHeight).toBe("384px");
    });

    it("opens below with room and clamps to the visible viewport when a phone keyboard appears", async () => {
        vi.stubGlobal("innerWidth", 400);
        vi.stubGlobal("innerHeight", 700);
        vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
            x: 20,
            y: 100,
            top: 100,
            left: 20,
            right: 380,
            bottom: 136,
            width: 360,
            height: 36,
            toJSON: () => ({}),
        });
        const viewport = Object.assign(new EventTarget(), {
            offsetTop: 0,
            offsetLeft: 0,
            height: 700,
            width: 400,
        });
        vi.stubGlobal("visualViewport", viewport);
        combobox();
        open();
        const panel = screen
            .getByRole("listbox")
            .closest("[style]") as HTMLElement;
        expect(panel.style.top).toBe("140px");
        expect(panel.style.width).toBe("360px");
        viewport.height = 90;
        act(() => viewport.dispatchEvent(new Event("resize")));
        await waitFor(() => expect(panel.style.top).toBe("82px"));
        expect(panel.style.transform).toBe("translateY(-100%)");
        expect(panel.style.maxHeight).toBe("74px");
    });
});
