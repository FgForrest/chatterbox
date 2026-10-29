// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Textarea } from "@/components/ui/textarea";

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("Textarea", () => {
    it("sizes an auto-growing field on mount and value changes without a resize handle", () => {
        const height = vi
            .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
            .mockReturnValue(120);
        const view = render(<Textarea autoGrow value="Draft" readOnly />);
        const field = screen.getByRole("textbox");
        expect(field.style.height).toBe("120px");
        expect(field.classList.contains("resize-none")).toBe(true);
        expect(field.classList.contains("overflow-y-auto")).toBe(true);
        expect(field.classList.contains("resize-y")).toBe(false);

        height.mockReturnValue(360);
        view.rerender(<Textarea autoGrow value="Longer draft" readOnly />);
        expect(field.style.height).toBe("360px");
    });

    it("leaves ordinary fields resizable without an inline height or observer", () => {
        const observer = vi.fn();
        vi.stubGlobal("ResizeObserver", observer);
        render(<Textarea value="Draft" readOnly />);
        const field = screen.getByRole("textbox");
        expect(field.classList.contains("resize-y")).toBe(true);
        expect(field.classList.contains("resize-none")).toBe(false);
        expect(field.style.height).toBe("");
        expect(observer).not.toHaveBeenCalled();
    });

    it("forwards the caller's object ref while auto-growing and clears it on unmount", () => {
        const ref = createRef<HTMLTextAreaElement>();
        const view = render(<Textarea autoGrow ref={ref} />);
        expect(ref.current).toBe(screen.getByRole("textbox"));
        view.unmount();
        expect(ref.current).toBeNull();
    });

    it("forwards the caller's callback ref without detaching it on value changes", () => {
        const ref = vi.fn();
        const view = render(
            <Textarea autoGrow ref={ref} value="Draft" readOnly />,
        );
        const field = screen.getByRole("textbox");
        expect(ref).toHaveBeenCalledExactlyOnceWith(field);
        view.rerender(<Textarea autoGrow ref={ref} value="Updated" readOnly />);
        expect(ref).toHaveBeenCalledOnce();
        view.unmount();
        expect(ref).toHaveBeenLastCalledWith(null);
    });

    it("honors React 19 callback-ref cleanup in StrictMode", () => {
        const cleanupRef = vi.fn();
        const ref = vi.fn((_field: HTMLTextAreaElement | null) => cleanupRef);
        const view = render(
            <StrictMode>
                <Textarea autoGrow ref={ref} />
            </StrictMode>,
        );
        expect(ref).toHaveBeenLastCalledWith(screen.getByRole("textbox"));
        view.unmount();
        expect(cleanupRef).toHaveBeenCalledTimes(ref.mock.calls.length);
        expect(ref.mock.calls.every(([field]) => field !== null)).toBe(true);
    });

    it("merges caller classes and forwards native field attributes", () => {
        render(
            <Textarea
                autoGrow
                className="min-h-20 max-h-[50vh] px-4"
                id="note"
                aria-label="Note"
                aria-invalid
                maxLength={2000}
                placeholder="Draft"
                disabled
            />,
        );
        const field = screen.getByRole<HTMLTextAreaElement>("textbox", {
            name: "Note",
        });
        expect(field.dataset.slot).toBe("textarea");
        expect(field.id).toBe("note");
        expect(field.maxLength).toBe(2000);
        expect(field.placeholder).toBe("Draft");
        expect(field.disabled).toBe(true);
        expect(field.getAttribute("aria-invalid")).toBe("true");
        for (const className of [
            "border-input",
            "shadow-xs",
            "text-base",
            "md:text-sm",
            "leading-6",
            "min-h-20",
            "max-h-[50vh]",
            "px-4",
            "focus-visible:border-ring",
            "focus-visible:ring-ring/50",
            "focus-visible:ring-[3px]",
            "aria-invalid:border-destructive",
            "disabled:opacity-50",
        ])
            expect(field.classList.contains(className)).toBe(true);
        expect(field.classList.contains("px-3")).toBe(false);
    });

    it("can enable auto-growth after mounting an ordinary field", () => {
        vi.spyOn(
            HTMLTextAreaElement.prototype,
            "scrollHeight",
            "get",
        ).mockReturnValue(240);
        const view = render(<Textarea value="Draft" readOnly />);
        view.rerender(<Textarea autoGrow value="Draft" readOnly />);
        expect(screen.getByRole("textbox").style.height).toBe("240px");
    });

    it("releases its height when auto-growth is turned off and sizes again when turned back on", () => {
        vi.spyOn(
            HTMLTextAreaElement.prototype,
            "scrollHeight",
            "get",
        ).mockReturnValue(240);
        const view = render(<Textarea autoGrow value="Draft" readOnly />);
        const field = screen.getByRole("textbox");
        expect(field.style.height).toBe("240px");
        view.rerender(<Textarea value="Draft" readOnly />);
        expect(field.style.height).toBe("");
        view.rerender(<Textarea value="Updated" readOnly />);
        expect(field.style.height).toBe("");
        view.rerender(<Textarea autoGrow value="Updated" readOnly />);
        expect(field.style.height).toBe("240px");
    });

    it("grows an uncontrolled field as the user types", () => {
        const height = vi
            .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
            .mockReturnValue(40);
        render(<Textarea autoGrow defaultValue="Seed" />);
        const field = screen.getByRole("textbox");
        expect(field.style.height).toBe("40px");
        height.mockReturnValue(600);
        fireEvent.input(field, { target: { value: "A much longer draft" } });
        expect(field.style.height).toBe("600px");
    });
});
