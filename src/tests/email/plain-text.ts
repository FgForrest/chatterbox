const BLOCKS = "p, h1, h2, h3, h4, h5, h6, div, tr, table, li, br";

/**
 * A rendered email's text as a reader skims it: blocks on their own
 * lines, a rule as `---`, a link as its text and `[url]`, the hidden
 * preview line left out. Needs a DOM (the jsdom test environment).
 */
export function plainTextOf(html: string): string {
    const document = new DOMParser().parseFromString(html, "text/html");
    document.head.remove();
    for (const hidden of document.querySelectorAll(
        '[data-skip-in-text="true"]',
    )) {
        hidden.remove();
    }
    for (const rule of document.querySelectorAll("hr")) {
        rule.replaceWith("\n---\n");
    }
    for (const link of document.querySelectorAll("a[href]")) {
        link.append(` [${link.getAttribute("href")}]`);
    }
    for (const block of document.querySelectorAll(BLOCKS)) {
        block.before("\n");
        block.after("\n");
    }
    return (document.body.textContent ?? "")
        .replace(/[ \t ]+/g, " ")
        .replace(/\s*\n\s*/g, "\n")
        .trim();
}
