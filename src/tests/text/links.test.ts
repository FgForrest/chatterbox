import { describe, expect, it } from "vitest";
import { splitTextLinks } from "@/lib/text/links";

function links(text: string) {
    return splitTextLinks(text).filter((segment) => segment.type === "link");
}

describe("plain text web links", () => {
    it.each([
        ["http://example.com/path", "http://example.com/path"],
        ["https://example.com/path", "https://example.com/path"],
        ["www.example.com/path", "https://www.example.com/path"],
        ["HTTPS://WWW.EXAMPLE.COM/path", "HTTPS://WWW.EXAMPLE.COM/path"],
    ])("recognizes %s", (source, href) => {
        expect(links(source)).toEqual([
            {
                type: "link",
                text: source,
                start: 0,
                href,
                label: "example.com/path",
            },
        ]);
    });

    it.each([
        ".",
        ",",
        ";",
        ":",
        "!",
        "?",
        ")",
        "]",
        "}",
        '"',
        "'",
        "”",
        "’",
        "“",
        "»",
        "›",
        ").",
        "!?])”",
    ])("leaves trailing %s outside the URL", (punctuation) => {
        const source = `https://example.com/path${punctuation}`;
        expect(links(source)[0].text).toBe("https://example.com/path");
        expect(
            splitTextLinks(source)
                .map((segment) => segment.text)
                .join(""),
        ).toBe(source);
        expect(splitTextLinks(source).at(-1)?.text).toBe(punctuation);
    });

    it.each([
        "https://example.com/a(b)",
        "https://example.com/a[b]",
        "https://example.com/a{b}",
        "https://example.com/a(b(c))",
        "https://example.com/?q='word'",
        'https://example.com/?q="word"',
        "https://example.com/„text“",
    ])("preserves balanced punctuation in %s", (source) => {
        expect(links(`${source}).`)[0].text).toBe(source);
    });

    it.each([
        "javascript:alert(1)",
        "data:text/plain,example.com",
        "mailto:hello@example.com",
        "ftp://example.com",
        "mailto:www.example.com",
        "javascript:https://example.com",
        "data:text/plain,www.example.com",
        "javascript:alert('https://example.com')",
        "someone@www.example.com",
        "subwww.example.com",
        "example.com",
        "https://",
        "www.",
    ])("does not link %s", (source) => {
        expect(links(source)).toEqual([]);
        expect(
            splitTextLinks(source)
                .map((segment) => segment.text)
                .join(""),
        ).toBe(source);
    });

    it.each([
        ["Pozn.:https://example.com/a", "https://example.com/a"],
        ["URL:www.example.org/b", "https://www.example.org/b"],
        ["Zápis:https://example.net/c", "https://example.net/c"],
    ])("links a URL right after a label in %s", (source, href) => {
        expect(links(source).map((segment) => segment.href)).toEqual([href]);
    });

    it("keeps Czech text, punctuation and several URLs exactly as written", () => {
        const source =
            "Podklady: „https://example.com/plán“, pak (www.example.org/bod). A http://example.net?x=1&y=2!";
        expect(links(source).map((segment) => segment.href)).toEqual([
            "https://example.com/plán",
            "https://www.example.org/bod",
            "http://example.net?x=1&y=2",
        ]);
        expect(
            splitTextLinks(source)
                .map((segment) => segment.text)
                .join(""),
        ).toBe(source);
        for (const segment of splitTextLinks(source))
            expect(
                source.slice(
                    segment.start,
                    segment.start + segment.text.length,
                ),
            ).toBe(segment.text);
    });

    it("shortens long labels to the host and start of the path, keeping full targets", () => {
        const source = `https://www.example.com/documents/${"long-path/".repeat(100)}?query=value#section`;
        const [segment] = links(source);
        expect(segment.label).toHaveLength(60);
        expect(segment.label).toMatch(
            /^example\.com\/documents\/long-path\/.+…$/u,
        );
        expect(segment.text).toBe(source);
        expect(segment.href).toBe(source);
    });

    it("does not abbreviate the host even when it exceeds the label limit", () => {
        const host = `${"subdomain.".repeat(8)}example.com`;
        expect(links(`https://${host}/long/path`)[0].label).toBe(`${host}…`);
    });

    it("keeps markdown syntax as plain text", () => {
        const source = "**See** [document](https://example.com/path).";
        expect(splitTextLinks(source)[0].text).toBe("**See** [document](");
        expect(splitTextLinks(source).at(-1)?.text).toBe(").");
    });

    it("returns no segments for empty text", () =>
        expect(splitTextLinks("")).toEqual([]));
});
