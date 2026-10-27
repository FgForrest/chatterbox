import type { AnyColumn } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { ContentItemKind } from "@/db/schema";

/** Item kinds with processable content; planned meetings are excluded. */
export const ALL_ITEM_KINDS: readonly ContentItemKind[] = ["audio", "mail"];

/** Decode a content-bearing relation's kind, refusing a plan used as evidence. */
export function contentKindColumn(column: AnyColumn) {
    return sql`${column}`.mapWith((value: unknown): ContentItemKind => {
        if (value === "audio" || value === "mail") return value;
        throw new TypeError("A meeting agenda is a plan, not item content");
    });
}
