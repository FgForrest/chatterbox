// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutlineEditor } from "@/components/meetings/outline-editor";
import * as navigation from "@/components/meetings/point-navigation";
import { detail, point } from "./ui-fixtures";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string) => text,
    useFormatter: () => ({ dateTime: () => "10:00" }),
}));
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});
const plain = {
    key: "ArrowUp",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    selectionStart: 3,
    selectionEnd: 3,
};

describe("visual boundary decisions", () => {
    it.each([
        [0, -1, null],
        [24, null, null],
        [48, null, 1],
    ])("uses measured caret top %s", (caretTop, up, down) => {
        const lines = { firstTop: 0, caretTop, lastTop: 48 };
        expect(navigation.pointArrowDirection(plain, lines)).toBe(up);
        expect(
            navigation.pointArrowDirection(
                { ...plain, key: "ArrowDown" },
                lines,
            ),
        ).toBe(down);
    });
    it.each([
        "altKey",
        "ctrlKey",
        "metaKey",
        "shiftKey",
        "isComposing",
    ])("ignores %s", (key) => {
        expect(
            navigation.pointArrowDirection(
                { ...plain, [key]: true },
                { firstTop: 0, caretTop: 0, lastTop: 0 },
            ),
        ).toBeNull();
    });
    it("ignores selections and other keys", () => {
        const lines = { firstTop: 0, caretTop: 0, lastTop: 0 };
        expect(
            navigation.pointArrowDirection(
                { ...plain, selectionEnd: 5 },
                lines,
            ),
        ).toBeNull();
        expect(
            navigation.pointArrowDirection({ ...plain, key: "Home" }, lines),
        ).toBeNull();
    });
    it("falls back to a single line in jsdom and removes the mirror", () => {
        const input = document.createElement("textarea");
        input.value = "A point with visual wrapping";
        document.body.append(input);
        expect(navigation.measureCaretLines(input)).toEqual({
            firstTop: 0,
            caretTop: 0,
            lastTop: 0,
        });
        Object.defineProperty(input, "clientWidth", { value: 100 });
        expect(navigation.measureCaretLines(input)).toEqual({
            firstTop: 0,
            caretTop: 0,
            lastTop: 0,
        });
        expect(document.body.children).toHaveLength(1);
        input.remove();
    });
    it("mirrors width, font, padding and spacing and reads each visual line", () => {
        const input = document.createElement("textarea");
        input.style.cssText =
            "width: 120px; font: 14px monospace; line-height: 24px; padding: 4px; letter-spacing: 1px";
        input.value = "A long point";
        input.setSelectionRange(4, 4);
        Object.defineProperty(input, "clientWidth", { value: 120 });
        document.body.append(input);
        let count = 0;
        vi.spyOn(Element.prototype, "getClientRects").mockImplementation(
            function (this: Element) {
                const mirror = this.parentElement;
                expect(mirror?.style.width).toBe("120px");
                expect(mirror?.style.fontFamily).toBe("monospace");
                expect(mirror?.style.padding).toBe("4px");
                expect(mirror?.style.letterSpacing).toBe("1px");
                expect(mirror?.style.whiteSpace).toBe("pre-wrap");
                return [
                    { top: [0, 24, 48][count++] },
                ] as unknown as DOMRectList;
            },
        );
        expect(navigation.measureCaretLines(input)).toEqual({
            firstTop: 0,
            caretTop: 24,
            lastTop: 48,
        });
        expect(document.body.children).toHaveLength(1);
        input.remove();
    });
});
function mount() {
    const onPatch = vi.fn().mockResolvedValue(true);
    render(
        <OutlineEditor
            userId="owner"
            detail={detail({
                permissions: { view: true, edit: true, manage: false },
                points: [
                    point("First"),
                    point("Child", { parentId: "First", position: 1 }),
                    point("Other author", {
                        position: 2,
                        authorUserId: "other",
                    }),
                    point("Last", { position: 3 }),
                ],
            })}
            onPatch={onPatch}
            onRemove={vi.fn()}
            onAdd={vi.fn().mockResolvedValue(true)}
        />,
    );
    const fields =
        screen.getAllByLabelText<HTMLTextAreaElement>("Discussion point");
    return { fields, onPatch };
}
describe("point focus navigation", () => {
    it("visits sub-points, skips noneditable points, places the caret and saves on blur", async () => {
        const {
            fields: [first, child, last],
            onPatch,
        } = mount();
        act(() => first.focus());
        fireEvent.change(first, { target: { value: "Edited first" } });
        first.setSelectionRange(3, 3);
        await act(async () => fireEvent.keyDown(first, { key: "ArrowDown" }));
        expect(document.activeElement).toBe(child);
        expect(child.selectionStart).toBe(0);
        expect(onPatch).toHaveBeenCalledWith(
            expect.objectContaining({ id: "First" }),
            { text: "Edited first" },
        );
        fireEvent.keyDown(child, { key: "ArrowDown" });
        expect(document.activeElement).toBe(last);
        expect(last.selectionStart).toBe(0);
        fireEvent.keyDown(last, { key: "ArrowUp" });
        expect(document.activeElement).toBe(child);
        expect(child.selectionStart).toBe(child.value.length);
        expect(child.selectionEnd).toBe(child.value.length);
    });
    it("moves from the last point to Add a point and back", () => {
        const { fields } = mount();
        const last = fields[fields.length - 1];
        act(() => last.focus());
        fireEvent.keyDown(last, { key: "ArrowDown" });
        const add = screen.getByLabelText("New discussion point");
        expect(document.activeElement).toBe(add);
        fireEvent.keyDown(add, { key: "ArrowUp" });
        expect(document.activeElement).toBe(last);
        expect(last.selectionStart).toBe(last.value.length);
        fireEvent.keyDown(last, { key: "ArrowDown" });
        expect(document.activeElement).toBe(add);
    });
    it("keeps focus inside wrapped middle lines and moves at the last visual line", () => {
        const measure = vi
            .spyOn(navigation, "measureCaretLines")
            .mockReturnValue({ firstTop: 0, caretTop: 24, lastTop: 48 });
        const {
            fields: [first, child],
        } = mount();
        act(() => first.focus());
        expect(fireEvent.keyDown(first, { key: "ArrowUp" })).toBe(true);
        expect(fireEvent.keyDown(first, { key: "ArrowDown" })).toBe(true);
        expect(document.activeElement).toBe(first);
        measure.mockReturnValue({ firstTop: 0, caretTop: 48, lastTop: 48 });
        expect(fireEvent.keyDown(first, { key: "ArrowDown" })).toBe(false);
        expect(document.activeElement).toBe(child);
    });
    it.each([
        { shiftKey: true },
        { ctrlKey: true },
        { metaKey: true },
        { isComposing: true },
        { altKey: true },
    ])("ignores modified/composing arrows %j", (modifier) => {
        const {
            fields: [first],
            onPatch,
        } = mount();
        act(() => first.focus());
        fireEvent.keyDown(first, { key: "ArrowDown", ...modifier });
        expect(document.activeElement).toBe(first);
        if ("altKey" in modifier) expect(onPatch).toHaveBeenCalled();
        else expect(onPatch).not.toHaveBeenCalled();
    });
    it("preserves selections and leaves the first point's Up to native behavior", () => {
        const {
            fields: [first],
        } = mount();
        act(() => first.focus());
        first.setSelectionRange(0, 2);
        expect(fireEvent.keyDown(first, { key: "ArrowDown" })).toBe(true);
        expect(document.activeElement).toBe(first);
        first.setSelectionRange(0, 0);
        expect(fireEvent.keyDown(first, { key: "ArrowUp" })).toBe(true);
        expect(document.activeElement).toBe(first);
    });
    it.each([
        { shiftKey: true },
        { altKey: true },
        { ctrlKey: true },
        { metaKey: true },
        { isComposing: true },
    ])("ignores modified/composing arrows in the add input %j", (modifier) => {
        mount();
        fireEvent.click(screen.getByRole("button", { name: "Add a point…" }));
        const add = screen.getByLabelText("New discussion point");
        fireEvent.keyDown(add, { key: "ArrowUp", ...modifier });
        expect(document.activeElement).toBe(add);
    });
});
