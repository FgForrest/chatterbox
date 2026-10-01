/**
 * The new people and things a Learn run proposes, as the items that refer
 * to them hold them: `{newRef}` where an id would stand. Pure, and shared
 * by the validation, the review's Finish and the review itself.
 */

export type RecordTarget = { personId: string } | { entityId: string };

/** The refs a payload refers to, each once, in order. */
export function refsIn(value: unknown): string[] {
    const found = new Set<string>();
    const walk = (inner: unknown) => {
        if (Array.isArray(inner)) {
            for (const item of inner) walk(item);
            return;
        }
        if (typeof inner !== "object" || inner === null) return;
        for (const [key, field] of Object.entries(inner)) {
            if (key === "newRef" && typeof field === "string") {
                found.add(field);
            } else {
                walk(field);
            }
        }
    };
    walk(value);
    return [...found];
}

/**
 * The payload with every `{newRef}` in it replaced by what `resolve` gives
 * for it (the record it became, or another ref), or null when one of them
 * resolves to nothing.
 */
export function replaceRefs<T>(
    value: T,
    resolve: (ref: string) => RecordTarget | { newRef: string } | undefined,
): T | null {
    let missing = false;
    const walk = (inner: unknown): unknown => {
        if (Array.isArray(inner)) return inner.map(walk);
        if (typeof inner !== "object" || inner === null) return inner;
        const record = inner as Record<string, unknown>;
        if (
            typeof record.newRef === "string" &&
            Object.keys(record).length === 1
        ) {
            const target = resolve(record.newRef);
            if (!target) missing = true;
            return target ?? inner;
        }
        return Object.fromEntries(
            Object.entries(record).map(([key, field]) => [key, walk(field)]),
        );
    };
    const replaced = walk(value) as T;
    return missing ? null : replaced;
}

/**
 * How a name is compared with the names the Almanac has: trimmed, one
 * space between words, NFC, lower case (`normalizeLabelForLookup`).
 */
export function recordNameKey(name: string): string {
    return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}
