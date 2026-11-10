// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
    renderLinkedText,
    splitLinks,
} from "../../../extensions/recorder/lib/linkify.js";

const links = (value) => splitLinks(value).filter((segment) => segment.href);

describe("plain agenda links", () => {
    it.each([
        ["http://example.com/doc", "http://example.com/doc"],
        ["https://example.com/doc", "https://example.com/doc"],
        ["www.example.com/doc", "https://www.example.com/doc"],
        ["HTTPS://EXAMPLE.COM/doc", "HTTPS://EXAMPLE.COM/doc"],
    ])("links %s", (value, href) => {
        expect(links(value)).toEqual([
            { text: value, href, label: "example.com/doc" },
        ]);
    });

    it.each([
        ".",
        ",",
        ";",
        ":",
        "!",
        "?",
        ").",
        "].",
        "}.",
        "'",
        '"',
        "”",
        "’",
        "»",
    ])("leaves trailing %s as text", (suffix) => {
        const value = `Viz https://example.com/doc${suffix}`;
        expect(links(value)[0].href).toBe("https://example.com/doc");
        expect(
            splitLinks(value)
                .map((segment) => segment.text)
                .join(""),
        ).toBe(value);
        expect(splitLinks(value).at(-1).text).toBe(suffix);
    });

    it.each([
        "https://example.com/wiki/Plan_(draft)",
        "https://example.com/doc[a]",
        "https://example.com/doc{a}",
        "https://example.com/it's-ready",
        "https://example.com/doc?a=1&b=2#part",
    ])("keeps balanced brackets and URL contents: %s", (url) => {
        expect(links(`(${url}).`)[0].href).toBe(url);
    });

    it("preserves Czech prose and multiple URLs exactly", () => {
        const value =
            "Příprava: https://example.com/plán, potom www.example.org/úkol a http://example.net.";
        expect(links(value)).toHaveLength(3);
        expect(links(value).map((segment) => segment.href)).toEqual([
            "https://example.com/plán",
            "https://www.example.org/úkol",
            "http://example.net",
        ]);
        expect(
            splitLinks(value)
                .map((segment) => segment.text)
                .join(""),
        ).toBe(value);
    });

    it.each([
        "javascript:alert(1)",
        "data:text/html,test",
        "mailto:test@example.com",
        "mailto:www.example.com",
        "javascript:https://example.com",
        "data:https://example.com",
        "ftp://www.example.com",
        "user@www.example.com",
        "prefixhttps://example.com",
        "https://",
        "www.",
        "https://[broken]",
    ])("does not link unsafe, embedded or invalid URLs: %s", (value) => {
        expect(links(value)).toEqual([]);
        expect(
            splitLinks(value)
                .map((segment) => segment.text)
                .join(""),
        ).toBe(value);
    });

    it("shortens a long URL label without changing its target or stored text", () => {
        const value = `https://www.example.com/documents/${"a".repeat(500)}?draft=1`;
        const [link] = links(value);
        expect(link.label).toHaveLength(48);
        expect(link.label).toMatch(/^example\.com\/documents\/a+…$/u);
        expect(link.href).toBe(value);
        expect(link.text).toBe(value);
        const root = renderLinkedText(document.createElement("p"), value);
        expect(root.firstElementChild.title).toBe(value);
    });

    it("uses DOM text without interpreting HTML or Markdown", () => {
        const root = renderLinkedText(
            document.createElement("p"),
            '<img src=x onerror="alert(1)"> **text** [link](https://example.com)',
        );
        expect(root.querySelector("img")).toBeNull();
        expect(root.querySelector("strong")).toBeNull();
        expect(root.querySelectorAll("a")).toHaveLength(1);
        expect(root.textContent).toContain("**text** [link](");
        expect(root.querySelector("a").getAttribute("target")).toBe("_blank");
        expect(root.querySelector("a").rel).toBe("noopener noreferrer");
    });

    it("link clicks do not toggle a surrounding checklist label", () => {
        const label = document.createElement("label");
        const check = document.createElement("input");
        check.type = "checkbox";
        label.append(
            check,
            renderLinkedText(
                document.createElement("span"),
                "https://example.com",
            ),
        );
        label.querySelector("a").click();
        expect(check.checked).toBe(false);
    });
});
