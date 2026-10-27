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

it("saves the version captured at focus and preserves a refused draft through readback", async () => {
    const onPatch = vi.fn().mockResolvedValue(false);
    const { props, rerender } = editor([point("Root")], { onPatch });
    const input = screen.getByLabelText("Discussion point");
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "My change" } });
    const remote = detail({
        points: [point("Root", { text: "Their change", version: 4 })],
    });
    rerender(<OutlineEditor {...props} detail={remote} />);
    await act(async () => input.blur());
    expect(onPatch).toHaveBeenCalledWith(
        expect.objectContaining({ version: 0 }),
        { text: "My change" },
    );
    rerender(<OutlineEditor {...props} detail={{ ...remote, version: 8 }} />);
    expect(input).toHaveProperty("value", "My change");
    expect(screen.getByRole("alert").textContent).toContain(
        "Your text is kept",
    );
    act(() => input.focus());
    await act(async () => input.blur());
    expect(onPatch).toHaveBeenLastCalledWith(
        expect.objectContaining({ version: 4 }),
        { text: "My change" },
    );
});
it("queues Enter while another write is pending, preserving both points in order", async () => {
    let finish: (value: boolean) => void = () => {};
    const onAdd = vi
        .fn()
        .mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    finish = resolve;
                }),
        )
        .mockResolvedValue(true);
    const { props, rerender } = editor([], { pending: true, onAdd });
    fireEvent.click(screen.getByRole("button", { name: "Add a point…" }));
    const input = screen.getByLabelText("New discussion point");
    fireEvent.change(input, { target: { value: "First queued" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).not.toHaveBeenCalled();
    rerender(<OutlineEditor {...props} pending={false} />);
    expect(onAdd).toHaveBeenCalledExactlyOnceWith("First queued", null, 0);
    fireEvent.change(input, { target: { value: "Second queued" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(onAdd).toHaveBeenLastCalledWith("Second queued", null, 1);
});
it.each([
    false,
    true,
])("Escape releases Tab in the %s draft field", async (draft) => {
    editor();
    if (draft)
        fireEvent.click(screen.getByRole("button", { name: "Add a point…" }));
    const input = screen.getAllByLabelText(
        draft ? "New discussion point" : "Discussion point",
    )[0];
    act(() => input.focus());
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).toBe(
        screen.getByText(/Escape, then Tab: leave editor/),
    );
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
    expect(screen.getByText(/Escape, then Tab: leave editor/)).toBeTruthy();
});
it("does not send a note for a pending point and respects composition on saved notes", async () => {
    const { props, rerender } = editor([point("pending-new")], {
        live: true,
        pending: true,
    });
    expect(screen.queryByLabelText("Point note")).toBeNull();
    rerender(
        <OutlineEditor
            {...props}
            live
            pending={false}
            detail={detail({ points: [point("saved")] })}
        />,
    );
    const note = screen.getByLabelText("Point note");
    act(() => note.focus());
    fireEvent.change(note, { target: { value: "Příští krok" } });
    fireEvent.keyDown(note, { key: "Enter", isComposing: true });
    expect(document.activeElement).toBe(note);
    expect(props.onPatch).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(note, { key: "Enter" }));
    expect(props.onPatch).toHaveBeenCalledWith(
        expect.objectContaining({ id: "saved" }),
        { note: "Příští krok" },
    );
});

it("keeps focus at the end of the outline after Escape queues a filled draft", async () => {
    const { props } = editor();
    fireEvent.click(screen.getByRole("button", { name: "Add a point…" }));
    const input = screen.getByLabelText("New discussion point");
    fireEvent.change(input, { target: { value: "Save and leave" } });
    await act(async () => fireEvent.keyDown(input, { key: "Escape" }));
    expect(props.onAdd).toHaveBeenCalledExactlyOnceWith(
        "Save and leave",
        null,
        2,
    );
    expect(document.activeElement).toBe(
        screen.getByText(/Escape, then Tab: leave editor/),
    );
});

it("keeps a failed queued point without overwriting text typed during the request", async () => {
    let finish: (saved: boolean) => void = () => {};
    const onAdd = vi
        .fn()
        .mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    finish = resolve;
                }),
        )
        .mockResolvedValue(true);
    editor([], { onAdd });
    fireEvent.click(screen.getByRole("button", { name: "Add a point…" }));
    const input = screen.getByLabelText("New discussion point");
    fireEvent.change(input, { target: { value: "Failed point" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "Still typing" } });
    await act(async () => finish(false));
    expect(input).toHaveProperty("value", "Still typing");
    expect(screen.getByText("Failed point")).toBeTruthy();
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Try again" })),
    );
    expect(onAdd).toHaveBeenLastCalledWith("Failed point", null, 0);
});

it("saves text and indentation in one versioned patch when Tab leaves an edited point", async () => {
    const { props } = editor(undefined, {
        onPatch: vi.fn().mockResolvedValue(true),
    });
    const field = screen.getAllByLabelText("Discussion point")[1];
    act(() => field.focus());
    fireEvent.change(field, { target: { value: "Edited second point" } });
    await act(async () => fireEvent.keyDown(field, { key: "Tab" }));
    expect(props.onPatch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "Second", version: 0 }),
        { text: "Edited second point", parentId: "Root" },
    );
});
