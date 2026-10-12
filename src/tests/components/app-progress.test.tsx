// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
    pathname: "/dashboard",
    search: "",
}));

vi.mock("next/navigation", () => ({
    usePathname: () => navigation.pathname,
    useSearchParams: () => new URLSearchParams(navigation.search),
}));

import { AppProgress } from "@/components/app-progress";

// Next's Link cancels the browser's own navigation in the bubble phase;
// so does this, keeping jsdom from trying to navigate.
const cancelNavigation = (event: Event) => event.preventDefault();

function bar(): HTMLElement | null {
    return document.querySelector('[data-slot="navigation-progress"]');
}

function barValue(): number {
    const inner = bar()?.firstElementChild as HTMLElement | null;
    const shift = /translate3d\((-?[\d.]+)%/.exec(inner?.style.transform ?? "");
    return shift ? 1 + Number(shift[1]) / 100 : Number.NaN;
}

function link(
    href: string,
    attributes: Record<string, string> = {},
): HTMLAnchorElement {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", href);
    for (const [name, value] of Object.entries(attributes)) {
        anchor.setAttribute(name, value);
    }
    anchor.textContent = "Go";
    document.body.append(anchor);
    return anchor;
}

function click(element: Element, init: MouseEventInit = {}): void {
    act(() => {
        element.dispatchEvent(
            new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                ...init,
            }),
        );
    });
}

function rendered() {
    return render(
        <AppProgress>
            <p>page</p>
        </AppProgress>,
    );
}

describe("AppProgress", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        navigation.pathname = "/dashboard";
        navigation.search = "";
        window.history.replaceState(null, "", "/dashboard");
        document.addEventListener("click", cancelNavigation);
    });

    afterEach(() => {
        cleanup();
        document.removeEventListener("click", cancelNavigation);
        document.body.replaceChildren();
        vi.useRealTimers();
    });

    it("runs from a link's click until the page changes, then fades out", () => {
        const view = rendered();
        expect(view.getByText("page")).toBeTruthy();
        expect(bar()).toBeNull();

        click(link("/settings"));
        expect(barValue()).toBeCloseTo(0.08);

        act(() => vi.advanceTimersByTime(2000));
        const trickled = barValue();
        expect(trickled).toBeGreaterThan(0.5);
        expect(trickled).toBeLessThan(1);

        navigation.pathname = "/settings";
        view.rerender(
            <AppProgress>
                <p>page</p>
            </AppProgress>,
        );
        expect(barValue()).toBe(1);

        act(() => vi.advanceTimersByTime(200));
        expect(bar()?.style.opacity).toBe("0");
        act(() => vi.advanceTimersByTime(200));
        expect(bar()).toBeNull();
    });

    it("never reaches the end by trickling", () => {
        rendered();
        click(link("/settings"));
        act(() => vi.advanceTimersByTime(600_000));
        expect(barValue()).toBeCloseTo(0.994);
    });

    it("finishes when the router pushes a history entry", () => {
        rendered();
        click(link("/settings"));
        act(() => window.history.pushState(null, "", "/settings"));
        expect(barValue()).toBe(1);
        expect(window.location.pathname).toBe("/settings");
    });

    it("gives history.pushState back when it unmounts", () => {
        const original = window.history.pushState;
        const view = rendered();
        expect(window.history.pushState).not.toBe(original);
        view.unmount();
        expect(window.history.pushState).toBe(original);
    });

    it.each([
        ["the same page with another query", "/dashboard?folder=1", {}, {}],
        ["the same page's anchor", "#top", {}, {}],
        ["a new tab", "/settings", { target: "_blank" }, {}],
        ["a named window", "/settings", { target: "help" }, {}],
        ["a download", "/api/export", { download: "" }, {}],
        ["a mail address", "mailto:someone@example.test", {}, {}],
        ["a script", "javascript:void(0)", {}, {}],
        ["a modifier key", "/settings", {}, { ctrlKey: true }],
        ["a middle click", "/settings", {}, { button: 1 }],
    ])("shows nothing for %s", (_name, href, attributes, init) => {
        rendered();
        click(link(href, attributes), init);
        expect(bar()).toBeNull();
    });

    it("shows nothing for an anchor without an address", () => {
        rendered();
        const anchor = document.createElement("a");
        anchor.textContent = "Not a link";
        document.body.append(anchor);
        click(anchor);
        expect(bar()).toBeNull();
    });

    it("starts from an element inside the link", () => {
        rendered();
        const anchor = link("/settings");
        const icon = document.createElement("span");
        anchor.append(icon);
        click(icon);
        expect(bar()).not.toBeNull();
    });
});
