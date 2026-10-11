const ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    nbsp: " ",
};

function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name) => {
        if (name.startsWith("#x") || name.startsWith("#X")) {
            return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
        }
        if (name.startsWith("#")) {
            return String.fromCodePoint(Number(name.slice(1)));
        }
        return ENTITIES[name.toLowerCase()] ?? whole;
    });
}

/**
 * A rendered email's text as a reader skims it: blocks on their own
 * lines, a rule as `---`, a link as its text and `[url]`, the hidden
 * preview line left out.
 */
export function plainTextOf(html: string): string {
    return decodeEntities(
        html
            .replace(/<head[\s\S]*?<\/head>/gi, "")
            .replace(
                /<div[^>]*data-skip-in-text="true"[\s\S]*?<\/div><\/div>/i,
                "",
            )
            .replace(/<!--[\s\S]*?-->/g, "")
            .replace(
                /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
                (_whole, href: string, inner: string) => `${inner} [${href}]`,
            )
            .replace(/<hr\b[^>]*>/gi, "\n---\n")
            .replace(/<\/?(p|h[1-6]|div|tr|table|li|br)\b[^>]*>/gi, "\n")
            .replace(/<[^>]+>/g, ""),
    )
        .replace(/[ \t ]+/g, " ")
        .replace(/\s*\n\s*/g, "\n")
        .trim();
}
