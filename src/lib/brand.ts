/** Returns the product name for the current interface language. */
export function productName(locale: string): string {
    return locale === "cs-CZ" ? "Klepna" : "Chatterbox";
}
