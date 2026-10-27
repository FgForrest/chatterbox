import type { AnyColumn } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { ContentItemKind } from "@/db/schema";

/** Item kinds with processable content; planned meetings are excluded. */
export const ALL_ITEM_KINDS: readonly ContentItemKind[] = ["audio", "mail"];

/** Decode a content-bearing relation's kind, returning null for a plan used as evidence. */
export function contentKindColumn(column: AnyColumn) {
    return sql`${column}`.mapWith((value: unknown): ContentItemKind | null => {
        if (value === "audio" || value === "mail") return value;
        return null;
    });
}

/** Narrow list rows after decoding, so an unexpected non-content kind is skipped. */
export function hasContentKind<
    K extends string,
    T extends Record<K, ContentItemKind | null>,
>(row: T, key: K): row is T & Record<K, ContentItemKind> {
    return row[key] === "audio" || row[key] === "mail";
}
