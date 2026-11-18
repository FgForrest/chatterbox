/** Fold case and diacritics for person search and exact-name comparison. */
export function foldPersonSearch(value: string): string {
    return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/** Search terms can start at any word, including the parts of an email address. */
export function personSearchWords(value: string): string[] {
    return foldPersonSearch(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Every search term must start a word of the name or of the displayed email. */
export function matchesPersonSearch(
    terms: readonly string[],
    name: string,
    email?: string | null,
): boolean {
    return [name, email ?? ""].some((value) => {
        const words = personSearchWords(value);
        return terms.every((term) =>
            words.some((word) => word.startsWith(term)),
        );
    });
}
