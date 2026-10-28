import { normalizeLocale } from "@/lib/i18n/config";

/** Auto follows the dominant known source language, then the requester's resolved UI locale. */
export function suggestionLanguage(
    outputLanguage: string,
    items: readonly { itemId: string; language: string | null }[],
    uiLocale?: string | null,
): string {
    if (outputLanguage.trim().toLowerCase() !== "auto") return outputLanguage;
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    for (const item of items) {
        if (seen.has(item.itemId)) continue;
        seen.add(item.itemId);
        const code = item.language
            ?.trim()
            .replaceAll("_", "-")
            .toLowerCase()
            .split("-")[0];
        if (
            !code ||
            !/^[a-z]{2,3}$/.test(code) ||
            ["und", "mul", "auto"].includes(code)
        )
            continue;
        counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    const dominant = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    return dominant ?? (normalizeLocale(uiLocale) === "cs-CZ" ? "cs" : "en");
}
