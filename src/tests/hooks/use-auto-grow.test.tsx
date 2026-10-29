// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoGrow } from "@/hooks/use-auto-grow";

function Field({ value }: { value: string }) {
    const ref = useAutoGrow(value);
    return <textarea ref={ref} value={value} readOnly />;
}

function TypedField() {
    const [value, setValue] = useState("Draft");
    const ref = useAutoGrow(value);
    return (
        <textarea
            ref={ref}
            value={value}
            onChange={(event) => setValue(event.target.value)}
        />
    );
}

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function observeResizes() {
    const observe = vi.fn();
    const disconnect = vi.fn();
    let resize = () => {};
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe = observe;
            disconnect = disconnect;
            constructor(callback: () => void) {
                resize = callback;
            }
        },
    );
    return { observe, disconnect, resize: () => act(() => resize()) };
}

describe("useAutoGrow", () => {
    it.each([
        "\r\n",
        "\r",
    ])("sizes and observes a field whose %j line endings are normalized by the DOM", (ending) => {
        const observer = observeResizes();
        vi.spyOn(
            HTMLTextAreaElement.prototype,
            "scrollHeight",
            "get",
        ).mockReturnValue(240);
        const view = render(<Field value={`First${ending}Second`} />);
        const field = screen.getByRole<HTMLTextAreaElement>("textbox");
        expect(field.value).toBe("First\nSecond");
        expect(field.style.height).toBe("240px");
        expect(observer.observe).toHaveBeenCalledExactlyOnceWith(field);
        view.unmount();
        expect(observer.disconnect).toHaveBeenCalledOnce();
    });

    it("resets the current height before measuring so shorter content can shrink", () => {
        vi.spyOn(
            HTMLTextAreaElement.prototype,
            "scrollHeight",
            "get",
        ).mockImplementation(function (this: HTMLTextAreaElement) {
            const contentHeight = this.value.length * 10;
            return Math.max(
                contentHeight,
                Number.parseFloat(this.style.height) || 0,
            );
        });
        const view = render(<Field value={"x".repeat(60)} />);
        const field = screen.getByRole("textbox");
        expect(field.style.height).toBe("600px");
        view.rerender(<Field value={"x".repeat(12)} />);
        expect(field.style.height).toBe("120px");
    });

    it("measures a controlled field once per keystroke and keeps one observer", () => {
        let observers = 0;
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe = vi.fn();
                disconnect = vi.fn();
                constructor() {
                    observers++;
                }
            },
        );
        const height = vi
            .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
            .mockReturnValue(120);
        render(<TypedField />);
        const field = screen.getByRole("textbox");
        height.mockClear();
        fireEvent.input(field, { target: { value: "Draft, longer" } });
        fireEvent.input(field, { target: { value: "Draft, longer still" } });
        expect(field).toHaveProperty("value", "Draft, longer still");
        expect(height).toHaveBeenCalledTimes(2);
        expect(observers).toBe(1);
    });

    it("remeasures a hidden mount when its width becomes visible", () => {
        const observer = observeResizes();
        const width = vi
            .spyOn(HTMLTextAreaElement.prototype, "clientWidth", "get")
            .mockReturnValue(0);
        const height = vi
            .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
            .mockReturnValue(0);
        render(<Field value="A draft mounted in a hidden panel" />);
        const field = screen.getByRole("textbox");
        expect(field.style.height).toBe("0px");
        expect(observer.observe).toHaveBeenCalledWith(field);

        width.mockReturnValue(640);
        height.mockReturnValue(180);
        observer.resize();
        expect(field.style.height).toBe("180px");
    });
});
