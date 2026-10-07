import { type AnyColumn, type SQL, sql } from "drizzle-orm";

/** A position in a list ordered newest first: a time and an id. */
export interface Keyset {
    at: Date;
    id: string;
}

function millis(column: AnyColumn): SQL {
    return sql`date_trunc('milliseconds', ${column})`;
}

/**
 * The newest-first order a keyset walks: `at` (to the millisecond, as a
 * cursor holds it), then `id`, both descending.
 */
export function keysetOrder(at: AnyColumn, id: AnyColumn): SQL[] {
    return [sql`${millis(at)} desc`, sql`${id} desc`];
}

/**
 * SQL: the row comes after `keyset` in {@link keysetOrder}. `at` is a
 * `timestamp` (without time zone) column.
 */
export function keysetBefore(
    at: AnyColumn,
    id: AnyColumn,
    keyset: Keyset,
): SQL {
    return sql`(${millis(at)}, ${id}) < (${keyset.at.toISOString()}::timestamp, ${keyset.id})`;
}
