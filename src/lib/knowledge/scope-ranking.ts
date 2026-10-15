import type { AlmanacUsageRow } from "@/db/queries/almanac-usage";

/** Almanac usage keyed by the person or entity it names. */
export function almanacUsageById(
    rows: readonly AlmanacUsageRow[],
): ReadonlyMap<string, AlmanacUsageRow> {
    const usage = new Map<string, AlmanacUsageRow>();
    for (const row of rows) {
        const id = row.personId ?? row.entityId;
        if (id) usage.set(id, row);
    }
    return usage;
}

/** Compare two knowledge ids by folder-scope use, best first. */
export function compareScopeUsage(
    aId: string,
    bId: string,
    usage: ReadonlyMap<string, AlmanacUsageRow>,
): number {
    const a = usage.get(aId);
    const b = usage.get(bId);
    return (
        Number(b !== undefined) - Number(a !== undefined) ||
        (b?.recent ?? 0) - (a?.recent ?? 0) ||
        (b?.total ?? 0) - (a?.total ?? 0) ||
        (b?.lastAt.getTime() ?? 0) - (a?.lastAt.getTime() ?? 0)
    );
}
