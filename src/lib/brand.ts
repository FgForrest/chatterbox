/** The upstream project name: the hosted product and its historical notices. */
export const UPSTREAM_PRODUCT_NAME = "Riffado";

/** Returns the product name for the current interface language. */
export function productName(locale: string): string {
    return locale === "cs-CZ" ? "Klepna" : "Chatterbox";
}
