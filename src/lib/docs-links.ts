/** Make bare Markdown filenames resolvable by the documentation source loader. */
export function normalizeDocsHref(href: string): string {
    if (
        href.startsWith("/") ||
        href.startsWith("./") ||
        href.startsWith("../") ||
        /^[a-z][a-z0-9+.-]*:/i.test(href)
    ) {
        return href;
    }

    const path = href.split(/[?#]/, 1)[0];
    return path.endsWith(".md") || path.endsWith(".mdx") ? `./${href}` : href;
}
