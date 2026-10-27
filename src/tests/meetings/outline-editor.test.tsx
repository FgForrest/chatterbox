// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import type { TranslationValues } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { outlineMove } from "@/components/meetings/outline";
import { OutlineEditor } from "@/components/meetings/outline-editor";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { detail, point } from "./ui-fixtures";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: TranslationValues) =>
        translatedSourceMessage("en", text, values),
    useFormatter: () => ({
        dateTime: (value: Date) => value.toISOString().slice(11, 16),
    }),
}));
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
function editor(
    points = [point("Root"), point("Second", { position: 1 })],
    overrides = {},
) {
    const props = {
        detail: detail({ points }),
        userId: "owner",
        pending: false,
        onPatch: vi.fn(),
        onRemove: vi.fn(),
        onAdd: vi.fn().mockResolvedValue(true),
        ...overrides,
    };
    const result = render(<OutlineEditor {...props} />);
    return { ...result, props };
}
describe("outline keyboard", () => {
    it("grows wrapped point text when the pane narrows without changing the text", () => {
        let resize = () => {};
        const disconnect = vi.fn();
        vi.stubGlobal(
            "ResizeObserver",
            class {
                constructor(callback: () => void) {
                    resize = callback;
                }
                observe() {}
                disconnect = disconnect;
            },
        );
        const { unmount } = editor([point("Long discussion point")]);
        const field = screen.getByLabelText("Discussion point");
        Object.defineProperty(field, "clientWidth", { value: 120 });
        Object.defineProperty(field, "scrollHeight", { value: 80 });
        act(() => resize());
        expect(field.style.height).toBe("80px");
        expect(field).toHaveProperty("value", "Long discussion point");
        unmount();
        expect(disconnect).toHaveBeenCalledOnce();
    });
    it("Enter creates a focused draft directly after a point and persists it once", async () => {
        const { props } = editor();
        fireEvent.keyDown(screen.getAllByLabelText("Discussion point")[0], {
            key: "Enter",
        });
        const draft = screen.getByLabelText("New discussion point");
        expect(document.activeElement).toBe(draft);
        fireEvent.change(draft, { target: { value: "New topic" } });
        await act(async () => fireEvent.keyDown(draft, { key: "Enter" }));
        expect(props.onAdd).toHaveBeenCalledExactlyOnceWith(
            "New topic",
            null,
            1,
        );
        expect(screen.getAllByLabelText("New discussion point")).toHaveLength(
            1,
        );
    });
    it("Tab indents and Shift+Tab outdents", () => {
        const { props, unmount } = editor();
        fireEvent.keyDown(screen.getAllByLabelText("Discussion point")[1], {
            key: "Tab",
        });
        expect(props.onPatch).toHaveBeenCalledWith(
            expect.objectContaining({ id: "Second" }),
            { parentId: "Root" },
        );
        unmount();
        const child = editor([
            point("Root"),
            point("Child", { parentId: "Root", position: 1 }),
        ]);
        fireEvent.keyDown(screen.getAllByLabelText("Discussion point")[1], {
            key: "Tab",
            shiftKey: true,
        });
        expect(child.props.onPatch).toHaveBeenCalledWith(
            expect.objectContaining({ id: "Child" }),
            { parentId: null, position: 1 },
        );
    });
    it("rejects fourth levels, cycles and moves that would deepen a subtree too far", () => {
        const points = [
            point("Root"),
            point("Child", { parentId: "Root", position: 1 }),
            point("Grandchild", { parentId: "Child", position: 2 }),
            point("Other", { parentId: "Child", position: 3 }),
        ];
        const { props } = editor(points);
        fireEvent.keyDown(screen.getAllByLabelText("Discussion point")[3], {
            key: "Tab",
        });
        expect(props.onPatch).not.toHaveBeenCalled();
        expect(outlineMove(points, "Root", false)).toBeNull();
    });
    it("Backspace on an empty point merges upward and focuses the preceding point", () => {
        const { props } = editor();
        const input = screen.getAllByLabelText("Discussion point")[1];
        fireEvent.change(input, { target: { value: "" } });
        fireEvent.keyDown(input, { key: "Backspace" });
        expect(props.onRemove).toHaveBeenCalledWith(
            expect.objectContaining({ id: "Second" }),
            true,
        );
        expect(document.activeElement).toBe(
            screen.getAllByLabelText("Discussion point")[0],
        );
    });
    it("offers touch indentation buttons with the same limits", () => {
        const { props } = editor();
        const buttons = screen.getAllByRole("button", { name: "Indent point" });
        expect(buttons[0]).toHaveProperty("disabled", true);
        fireEvent.click(buttons[1]);
        expect(props.onPatch).toHaveBeenCalledWith(
            expect.objectContaining({ id: "Second" }),
            { parentId: "Root" },
        );
    });
    it("retains the focused draft across a polling update", () => {
        const { props, rerender } = editor();
        const input = screen.getAllByLabelText("Discussion point")[0];
        act(() => input.focus());
        fireEvent.change(input, { target: { value: "Local draft" } });
        rerender(
            <OutlineEditor
                {...props}
                detail={detail({
                    points: [
                        point("Root", { text: "Colleague edit", version: 1 }),
                        point("New colleague point", { position: 1 }),
                    ],
                })}
            />,
        );
        expect(screen.getAllByLabelText("Discussion point")[0]).toHaveProperty(
            "value",
            "Local draft",
        );
        expect(screen.getAllByLabelText("Discussion point")[1]).toHaveProperty(
            "value",
            "New colleague point",
        );
    });
    it("does not structurally edit colleagues’ points", () => {
        editor([point("Colleague", { authorUserId: "colleague" })], {
            detail: detail({
                permissions: { view: true, edit: true, manage: false },
                points: [point("Colleague", { authorUserId: "colleague" })],
            }),
        });
        expect(screen.queryByLabelText("Discussion point")).toBeNull();
    });
    it("waits for saved identities before editing new points and changing structure", () => {
        const points = [
            point("Root"),
            point("Second", { position: 1 }),
            point("pending-new", { text: "New topic", position: 2 }),
        ];
        const { props, rerender } = editor(points, { pending: true });
        expect(screen.getAllByLabelText("Discussion point")).toHaveLength(2);
        expect(screen.getByText("New topic")).toBeTruthy();
        const second = screen.getAllByLabelText("Discussion point")[1];
        fireEvent.keyDown(second, { key: "Tab" });
        fireEvent.change(second, { target: { value: "" } });
        fireEvent.keyDown(second, { key: "Backspace" });
        expect(props.onPatch).not.toHaveBeenCalled();
        expect(props.onRemove).not.toHaveBeenCalled();
        rerender(
            <OutlineEditor
                {...props}
                pending={false}
                detail={detail({
                    points: [
                        points[0],
                        points[1],
                        point("saved-new", {
                            text: "New topic",
                            position: 2,
                        }),
                    ],
                })}
            />,
        );
        expect(screen.getAllByLabelText("Discussion point")).toHaveLength(3);
    });
    it("keeps failed new text available for retry", async () => {
        const { props } = editor([], {
            onAdd: vi.fn().mockResolvedValue(false),
        });
        fireEvent.click(screen.getByRole("button", { name: "Add a point…" }));
        fireEvent.change(screen.getByLabelText("New discussion point"), {
            target: { value: "Retry me" },
        });
        await act(async () =>
            fireEvent.keyDown(screen.getByLabelText("New discussion point"), {
                key: "Enter",
            }),
        );
        expect(props.onAdd).toHaveBeenCalledOnce();
        expect(screen.getByLabelText("New discussion point")).toHaveProperty(
            "value",
            "Retry me",
        );
    });
});
