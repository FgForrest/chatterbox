import { normalizeLocale } from "@/lib/i18n/config";

/** Label retained profile history in the viewer's UI language. */
export function profileHistoryName(
    name: string,
    deletedAt: Date | string | null | undefined,
    locale: string | null | undefined,
): string {
    if (!deletedAt) return name;
    return `${name} (${normalizeLocale(locale) === "cs-CZ" ? "smazaný" : "deleted"})`;
}
