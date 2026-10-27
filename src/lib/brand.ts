/** The upstream project name: the hosted product and its historical notices. */
export const UPSTREAM_PRODUCT_NAME = "Riffado";

export type ProductNameCase = "nominative" | "accusative" | "genitive";

/** Returns the product name for the current interface language and grammatical case. */
export function productName(
    locale: string,
    grammaticalCase: ProductNameCase = "nominative",
): string {
    if (locale === "cs-CZ") {
        if (grammaticalCase === "genitive") return "Klepny";
        return grammaticalCase === "accusative" ? "Klepnu" : "Klepna";
    }
    return "Chatterbox";
}
