// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderCombobox } from "@/components/recordings/folder-combobox";
import { SearchCombobox } from "@/components/ui/search-combobox";

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe.each(["folder", "search"] as const)("%s combobox focus", (variant) => {
    it.each([
        "before",
        "after",
    ])("dismisses on focus moving to a control %s the trigger", async (direction) => {
        const onValueChange = vi.fn();
        render(
            <>
                <button type="button">before</button>
                {variant === "folder" ? (
                    <FolderCombobox
                        entries={[]}
                        value=""
                        onValueChange={onValueChange}
                    />
                ) : (
                    <SearchCombobox
                        options={[{ value: "one", label: "One" }]}
                        value=""
                        onValueChange={onValueChange}
                        aria-label="Choice"
                    />
                )}
                <button type="button">after</button>
            </>,
        );
        const trigger = screen.getByRole("combobox");
        fireEvent.click(trigger);
        expect(screen.getByRole("listbox")).toBeTruthy();
        const outside = screen.getByRole("button", { name: direction });
        act(() => outside.focus());
        await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        expect(document.activeElement).toBe(outside);
        expect(onValueChange).not.toHaveBeenCalled();
    });
});
