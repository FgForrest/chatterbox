import type { Keyset } from "@/lib/db/keyset";
import { McpToolError } from "@/lib/mcp/errors";

const TOKEN = /^[A-Za-z0-9_-]{1,512}$/;
const MAX_ID_LENGTH = 200;
const MAX_OFFSET = 1_000_000;

/** An opaque cursor for a keyset position. */
export function encodeKeyset(keyset: Keyset): string {
    return Buffer.from(`${keyset.at.toISOString()}|${keyset.id}`).toString(
        "base64url",
    );
}

/** The keyset a cursor names, or null for anything that is not a cursor. */
export function decodeKeyset(cursor: string): Keyset | null {
    if (!TOKEN.test(cursor)) return null;
    const plain = Buffer.from(cursor, "base64url").toString("utf8");
    const split = plain.indexOf("|");
    if (split < 0) return null;
    const iso = plain.slice(0, split);
    const id = plain.slice(split + 1);
    if (!id || id.length > MAX_ID_LENGTH || /\p{Cc}/u.test(id)) return null;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime()) || at.toISOString() !== iso) return null;
    return { at, id };
}

/**
 * The keyset of a cursor argument: null when none was given, and
 * `McpToolError("Invalid cursor")` for one that is not a cursor.
 */
export function parseKeyset(cursor: string | null | undefined): Keyset | null {
    if (cursor === null || cursor === undefined) return null;
    const keyset = decodeKeyset(cursor);
    if (!keyset) throw new McpToolError("Invalid cursor");
    return keyset;
}

/** An opaque cursor for a position in a list held in memory. */
export function encodeOffset(offset: number): string {
    return Buffer.from(`o:${offset}`).toString("base64url");
}

/**
 * The position an offset cursor names: 0 when none was given, and
 * `McpToolError("Invalid cursor")` for one that is not a cursor.
 */
export function parseOffset(cursor: string | null | undefined): number {
    if (cursor === null || cursor === undefined) return 0;
    const plain = TOKEN.test(cursor)
        ? Buffer.from(cursor, "base64url").toString("utf8")
        : "";
    const match = /^o:(0|[1-9]\d{0,6})$/.exec(plain);
    const offset = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(offset) || offset > MAX_OFFSET) {
        throw new McpToolError("Invalid cursor");
    }
    return offset;
}
