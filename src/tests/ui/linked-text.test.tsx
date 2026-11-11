// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { LinkedText } from "@/components/ui/linked-text";

afterEach(cleanup);

it("renders accessible, styled links with full targets and tooltips", () => {
    const long = `https://www.example.com/documents/${"path/".repeat(30)}`;
    render(
        <p>
            <LinkedText text={`Podklady ${long}, a www.example.org!`} />
        </p>,
    );
    const links = screen.getAllByRole<HTMLAnchorElement>("link");
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toMatch(/^example\.com\/documents\/.+…$/u);
    expect(links[0].title).toBe(long);
    expect(links[0].getAttribute("href")).toBe(long);
    expect(links[1].getAttribute("href")).toBe("https://www.example.org");
    for (const link of links) {
        expect(link.target).toBe("_blank");
        expect(link.rel).toBe("noopener noreferrer");
        expect(link.tabIndex).toBe(0);
        expect(link.className).toContain("text-primary");
        expect(link.className).toContain("focus-visible:outline-ring");
        link.focus();
        expect(document.activeElement).toBe(link);
    }
});

it("renders markup and unsafe schemes as text without interpreting HTML or Markdown", () => {
    const text =
        '<img src=x onerror="alert(1)"> **bold** javascript:alert(1) data:text/plain,hello mailto:hello@example.com';
    const { container } = render(<LinkedText text={text} />);
    expect(container.textContent).toBe(text);
    expect(container.querySelector("img, strong, script, a")).toBeNull();
});
