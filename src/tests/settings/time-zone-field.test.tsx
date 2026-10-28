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
import { TimeZoneField } from "@/components/settings/time-zone-field";

beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
describe.each([
    false,
    true,
])("time zone field (Organization: %s)", (organization) => {
    it("searches IANA zones and clears the explicit preference", async () => {
        const onChange = vi.fn();
        const label = organization ? "Organization time zone" : "Time zone";
        const automatic = organization
            ? "No default (UTC)"
            : "Automatic (from your browser)";
        const { rerender } = render(
            <TimeZoneField
                organization={organization}
                value={null}
                onChange={onChange}
            />,
        );
        fireEvent.click(screen.getByRole("combobox", { name: label }));
        const search = screen.getByPlaceholderText("Search…");
        fireEvent.change(search, { target: { value: "Prague" } });
        await waitFor(() =>
            expect(
                screen.getByRole("option", { name: "Europe/Prague" }),
            ).toBeTruthy(),
        );
        await act(async () =>
            fireEvent.click(
                screen.getByRole("option", { name: "Europe/Prague" }),
            ),
        );
        expect(onChange).toHaveBeenCalledWith("Europe/Prague");
        rerender(
            <TimeZoneField
                organization={organization}
                value="Europe/Prague"
                onChange={onChange}
            />,
        );
        fireEvent.click(screen.getByRole("combobox", { name: label }));
        await act(async () =>
            fireEvent.click(screen.getByRole("option", { name: automatic })),
        );
        expect(onChange).toHaveBeenLastCalledWith(null);
    });
});
