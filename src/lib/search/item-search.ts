import {
    and,
    desc,
    eq,
    inArray,
    isNotNull,
    isNull,
    lt,
    or,
    type SQL,
} from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    type ChatterItemKind,
    chatterItems,
    mailContents,
    mailParticipants,
    transcriptions,
} from "@/db/schema";
import type { ContentSegment } from "@/lib/content/types";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { secretAddressMasker } from "@/lib/mail/redact";
import { searchableMailParts } from "@/lib/mail/searchable-parts";
import { decodeKeyset, encodeKeyset } from "@/lib/mcp/cursor";
import { boundedScan } from "@/lib/mcp/scan";
import { getOrgUserId } from "@/lib/org/config";
import { snippetBounds } from "@/lib/search/snippets";
import { sharedItemCondition } from "@/lib/sharing/shared";
import type { RecordingView } from "@/lib/sharing/view";

const BATCH = 50;
const SCAN_LIMIT = 1_000;
const DEADLINE_MS = 5_000;
const MAX_RESULTS = 100;
const SNIPPET_CHARS = 140;

/** A field the bounded item search reads. */
export type ItemSearchScope = "title" | "content" | "summary";

/** An item a search found, with a few of its words around the match. */
export interface ItemSearchHit {
    id: string;
    kind: ChatterItemKind;
    snippet: string | null;
}

export interface ItemSearchResult {
    hits: ItemSearchHit[];
    scanned: number;
    /** The search reached the oldest item. */
    complete: boolean;
    /** Pass back as `before` to search further back. */
    continueBefore: string | null;
}

interface LoadedItem {
    id: string;
    userId: string;
    kind: ChatterItemKind;
    occurredAt: Date;
    title: string;
    contentTexts: string[];
    summaryTexts: string[];
}

/** Lowercase, without accents: "Příliš" and "prilis" are one word. */
export function foldForSearch(text: string): string {
    return text
        .normalize("NFKD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();
}

function snippetOf(texts: readonly string[], word: string): string | null {
    for (const text of texts) {
        const at = foldForSearch(text).indexOf(word);
        if (at < 0) continue;
        const rawStart = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
        const { start, end } = snippetBounds(
            text,
            rawStart,
            rawStart + SNIPPET_CHARS,
            { start: at, end: at + word.length },
        );
        const piece = text.slice(start, end).replace(/\s+/g, " ").trim();
        return `${start > 0 ? "…" : ""}${piece}${end < text.length ? "…" : ""}`;
    }
    return null;
}

/**
 * Items newest first after `before`, with what each says: a recording's
 * transcripts (every one its owner holds), a mail's sender, body and quoted
 * parts. A quoted part is skipped when its original is in `scope` too,
 * where it matches on its own. `occurred_at` is written from JavaScript
 * dates, so millisecond cursors compare exactly against the column, and its
 * index serves the order.
 */
async function loadBatch(
    scope: SQL,
    before: string | null,
    searchScopes: ReadonlySet<ItemSearchScope>,
    signal?: AbortSignal,
): Promise<LoadedItem[]> {
    const after = before ? decodeKeyset(before) : null;
    const rows = await db
        .select({
            id: chatterItems.id,
            userId: chatterItems.userId,
            kind: chatterItems.kind,
            occurredAt: chatterItems.occurredAt,
            title: chatterItems.title,
        })
        .from(chatterItems)
        .where(
            and(
                scope,
                isNull(chatterItems.deletedAt),
                after
                    ? or(
                          lt(chatterItems.occurredAt, after.at),
                          and(
                              eq(chatterItems.occurredAt, after.at),
                              lt(chatterItems.id, after.id),
                          ),
                      )
                    : undefined,
            ),
        )
        .orderBy(desc(chatterItems.occurredAt), desc(chatterItems.id))
        .limit(BATCH);
    signal?.throwIfAborted();
    if (rows.length === 0) return [];
    const ownerOf = new Map(rows.map((row) => [row.id, row.userId]));
    const ownerIds = [...new Set(rows.map((row) => row.userId))];
    const mailIds = rows.filter((row) => row.kind === "mail").map((r) => r.id);
    const audioIds = rows
        .filter((row) => row.kind === "audio")
        .map((r) => r.id);
    const [contents, senders, transcripts, summaries] = await Promise.all([
        searchScopes.has("content") && mailIds.length > 0
            ? db
                  .select({
                      itemId: mailContents.itemId,
                      userId: mailContents.userId,
                      segments: mailContents.segments,
                  })
                  .from(mailContents)
                  .where(
                      and(
                          inArray(mailContents.itemId, mailIds),
                          inArray(mailContents.userId, ownerIds),
                      ),
                  )
            : [],
        searchScopes.has("content") && mailIds.length > 0
            ? db
                  .select({
                      itemId: mailParticipants.itemId,
                      userId: mailParticipants.userId,
                      roles: mailParticipants.roles,
                      name: mailParticipants.name,
                      address: mailParticipants.address,
                  })
                  .from(mailParticipants)
                  .where(
                      and(
                          inArray(mailParticipants.itemId, mailIds),
                          inArray(mailParticipants.userId, ownerIds),
                      ),
                  )
            : [],
        searchScopes.has("content") && audioIds.length > 0
            ? db
                  .select({
                      itemId: transcriptions.recordingId,
                      userId: transcriptions.userId,
                      text: transcriptions.text,
                  })
                  .from(transcriptions)
                  .where(
                      and(
                          inArray(transcriptions.recordingId, audioIds),
                          inArray(transcriptions.userId, ownerIds),
                      ),
                  )
            : [],
        searchScopes.has("summary")
            ? db
                  .select({
                      itemId: aiEnhancements.itemId,
                      userId: aiEnhancements.userId,
                      summary: aiEnhancements.summary,
                  })
                  .from(aiEnhancements)
                  .where(
                      and(
                          inArray(
                              aiEnhancements.itemId,
                              rows.map((row) => row.id),
                          ),
                          inArray(aiEnhancements.userId, ownerIds),
                          isNotNull(aiEnhancements.summary),
                      ),
                  )
            : [],
    ]);
    signal?.throwIfAborted();
    const decryptedContents = contents
        .filter((row) => ownerOf.get(row.itemId) === row.userId)
        .map((row) => ({
            ...row,
            segments: decryptJsonField<ContentSegment[]>(row.segments) ?? [],
        }));
    const knownByOwner = new Map<string, Set<string>>();
    for (const row of decryptedContents) {
        for (const segment of row.segments) {
            if (segment.role !== "quoted" || !segment.knownItemId) continue;
            const ids = knownByOwner.get(row.userId) ?? new Set<string>();
            ids.add(segment.knownItemId);
            knownByOwner.set(row.userId, ids);
        }
    }
    const originals =
        knownByOwner.size > 0
            ? await db
                  .select({ id: chatterItems.id, userId: chatterItems.userId })
                  .from(chatterItems)
                  .where(
                      and(
                          or(
                              ...[...knownByOwner].map(([userId, ids]) =>
                                  and(
                                      eq(chatterItems.userId, userId),
                                      inArray(chatterItems.id, [...ids]),
                                  ),
                              ),
                          ),
                          scope,
                          isNull(chatterItems.deletedAt),
                      ),
                  )
            : [];
    signal?.throwIfAborted();
    const candidatesByOwner = new Map<string, Set<string>>();
    for (const row of originals) {
        const ids = candidatesByOwner.get(row.userId) ?? new Set<string>();
        ids.add(row.id);
        candidatesByOwner.set(row.userId, ids);
    }
    const contentTexts = new Map<string, string[]>();
    const summaryTexts = new Map<string, string[]>();
    const add = (
        destination: Map<string, string[]>,
        itemId: string,
        userId: string,
        values: string[],
    ) => {
        if (ownerOf.get(itemId) !== userId) return;
        destination.set(itemId, [
            ...(destination.get(itemId) ?? []),
            ...values,
        ]);
    };
    for (const row of senders) {
        if (!row.roles.includes("from")) continue;
        add(contentTexts, row.itemId, row.userId, [
            ...(row.name ? [decryptText(row.name)] : []),
            ...(row.address ? [decryptText(row.address)] : []),
        ]);
    }
    for (const row of decryptedContents) {
        add(
            contentTexts,
            row.itemId,
            row.userId,
            searchableMailParts(
                row.segments,
                candidatesByOwner.get(row.userId) ?? new Set<string>(),
            ).map((part) => part.text),
        );
    }
    for (const row of transcripts) {
        add(contentTexts, row.itemId, row.userId, [decryptText(row.text)]);
    }
    for (const row of summaries) {
        if (!row.summary) continue;
        add(summaryTexts, row.itemId, row.userId, [decryptText(row.summary)]);
    }
    return rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        kind: row.kind,
        occurredAt: row.occurredAt,
        title: decryptText(row.title),
        contentTexts: contentTexts.get(row.id) ?? [],
        summaryTexts: summaryTexts.get(row.id) ?? [],
    }));
}

/**
 * Search the items of one library for every word of `query` (case and
 * accents ignored): `private`, the viewer's own; `org`, those shared into
 * the Organization. Titles, a mail's sender, body and quoted text, and a
 * recording's transcripts are read; everything is encrypted, so the
 * search decrypts newest first and stops at a bound, saying where to go
 * on. `scopes` limits the scan to titles, transcripts/message text, and
 * summaries. A mail of someone else's has its secret addresses masked.
 * Known quotes are skipped only when their originals are candidates in
 * the same library, ignoring `before`.
 */
export async function searchItems({
    viewerUserId,
    view,
    query,
    before = null,
    scopes = ["title", "content", "summary"],
    signal,
}: {
    viewerUserId: string;
    view: RecordingView;
    query: string;
    before?: string | null;
    scopes?: readonly ItemSearchScope[];
    signal?: AbortSignal;
}): Promise<ItemSearchResult> {
    signal?.throwIfAborted();
    const words = foldForSearch(query).split(/\s+/).filter(Boolean);
    const searchScopes = new Set(scopes);
    // A colleague's mail is searched as it reads to the viewer: matched
    // on its secret addresses, a search would spell out their tokens.
    const masked = async (items: LoadedItem[]): Promise<LoadedItem[]> => {
        const foreign = items.filter(
            (item) => item.kind === "mail" && item.userId !== viewerUserId,
        );
        if (foreign.length === 0) return items;
        const mask = await secretAddressMasker(
            foreign.flatMap((item) => [
                item.title,
                ...item.contentTexts,
                ...item.summaryTexts,
            ]),
        );
        return items.map((item) =>
            foreign.includes(item)
                ? {
                      ...item,
                      title: mask(item.title),
                      contentTexts: item.contentTexts.map(mask),
                      summaryTexts: item.summaryTexts.map(mask),
                  }
                : item,
        );
    };
    if (words.length === 0 || searchScopes.size === 0) {
        return { hits: [], scanned: 0, complete: true, continueBefore: null };
    }
    let scope: SQL;
    if (view === "org") {
        const orgUserId = await getOrgUserId();
        if (!orgUserId) {
            return {
                hits: [],
                scanned: 0,
                complete: true,
                continueBefore: null,
            };
        }
        scope = sharedItemCondition(orgUserId, chatterItems.id);
    } else {
        scope = eq(chatterItems.userId, viewerUserId);
    }
    const found: ItemSearchHit[] = [];
    const scan = await boundedScan({
        batches: async (stamp) =>
            masked(await loadBatch(scope, stamp, searchScopes, signal)),
        stampOf: (item) => encodeKeyset({ at: item.occurredAt, id: item.id }),
        visit: (item) => {
            const all = [
                ...(searchScopes.has("title") ? [item.title] : []),
                ...(searchScopes.has("content") ? item.contentTexts : []),
                ...(searchScopes.has("summary") ? item.summaryTexts : []),
            ];
            const folded = foldForSearch(all.join("\n"));
            if (!words.every((word) => folded.includes(word))) return null;
            const titleMatched =
                searchScopes.has("title") &&
                foldForSearch(item.title).includes(words[0] ?? "");
            const snippet = titleMatched
                ? null
                : snippetOf(
                      [...item.contentTexts, ...item.summaryTexts],
                      words[0] ?? "",
                  );
            found.push({ id: item.id, kind: item.kind, snippet });
            return item.id;
        },
        limit: SCAN_LIMIT,
        deadlineMs: DEADLINE_MS,
        maxResults: MAX_RESULTS,
        before,
        signal,
    });
    return {
        hits: found,
        scanned: scan.scanned,
        complete: scan.complete,
        continueBefore: scan.continueBefore,
    };
}
