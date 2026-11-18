function surname(name: string): string {
    const withoutSuffix = name.replace(/\s*\([^()]*\)(?:\s*,.*)?\s*$|,.*$/, "");
    return withoutSuffix.trim().split(/\s+/).at(-1) ?? "";
}

/** Compare display names by surname, then by full name, in the given locale. */
export function compareNamesBySurname(locale: string) {
    const { compare } = new Intl.Collator(locale);
    return (a: string, b: string) =>
        compare(surname(a), surname(b)) || compare(a, b);
}
