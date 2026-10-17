// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeSelect } from "@/components/ui/native-select";

afterEach(cleanup);

describe("NativeSelect", () => {
    it("forwards native select props and hides its chevron", () => {
        const ref = createRef<HTMLSelectElement>();
        const onChange = vi.fn();
        const view = render(
            <NativeSelect
                ref={ref}
                aria-label="Provider"
                value="second"
                onChange={onChange}
            >
                <option value="first">First</option>
                <option value="second">Second</option>
            </NativeSelect>,
        );
        const select = screen.getByRole("combobox", { name: "Provider" });

        expect(select).toBe(ref.current);
        expect((select as HTMLSelectElement).value).toBe("second");
        fireEvent.change(select, { target: { value: "first" } });
        expect(onChange).toHaveBeenCalledTimes(1);

        view.rerender(
            <NativeSelect
                ref={ref}
                aria-label="Provider"
                value="second"
                onChange={onChange}
                disabled
            >
                <option value="first">First</option>
                <option value="second">Second</option>
            </NativeSelect>,
        );
        expect((select as HTMLSelectElement).disabled).toBe(true);
        expect(
            view.container.querySelector("svg")?.getAttribute("aria-hidden"),
        ).toBe("true");
    });
});
