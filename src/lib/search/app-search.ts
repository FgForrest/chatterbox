import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { knowledgeView } from "@/lib/knowledge/knowledge-loader";
import { vocabularyVisibleTo } from "@/lib/knowledge/vocabulary";
import { secretAddressMasker } from "@/lib/mail/redact";
import { getOrgUserId } from "@/lib/org/config";
import { foldForSearch, searchItems } from "@/lib/search/item-search";
import type {
    AlmanacSearchHit,
    AppSearchResults,
    AppSearchScope,
    ChatterSearchHit,
    TaskSearchHit,
} from "@/lib/search/types";
import { sharedItemCondition } from "@/lib/sharing/shared";
import type { TaskViewer } from "@/lib/tasks/access";
import { type CallerTaskQuery, listCallerTasks } from "@/lib/tasks/tasks";

const RESULT_LIMIT = 50;
const TASK_SCAN_LIMIT = 1000;
const TASK_DEADLINE_MS = 5_000;

function matches(text: string, query: string): boolean {
    const folded = foldForSearch(text);
    return foldForSearch(query)
        .split(/\s+/)
        .filter(Boolean)
        .every((word) => folded.includes(word));
}

/** Search the viewer's own and Organization knowledge, including taught forms. */
export async function searchAlmanac(
    userId: string,
    query: string,
    signal?: AbortSignal,
): Promise<{ hits: AlmanacSearchHit[]; limited: boolean }> {
    signal?.throwIfAborted();
    const [view, vocabulary] = await Promise.all([
        knowledgeView({ kind: "pages", viewerUserId: userId }),
        vocabularyVisibleTo(userId),
    ]);
    signal?.throwIfAborted();
    const labels = new Map(
        vocabulary.entityTypes.map((type) => [type.key, type.label]),
    );
    const hits: AlmanacSearchHit[] = [];
    for (const item of view.items) {
        signal?.throwIfAborted();
        const href =
            item.kind === "person"
                ? `/almanac/${encodeURIComponent(item.id)}`
                : `/almanac/things/${encodeURIComponent(item.id)}`;
        const base = {
            id: item.id,
            name: item.name,
            typeKey: item.typeKey,
            typeLabel: labels.get(item.typeKey) ?? item.typeKey,
            description: item.description,
            scope: item.scope,
            href,
        };
        if (
            matches(
                [
                    item.name,
                    item.description,
                    ...item.names.map((name) => name.text),
                ]
                    .filter(Boolean)
                    .join(" "),
                query,
            )
        ) {
            hits.push({ ...base, kind: item.kind, heard: null });
        }
        const seenForms = new Set<string>();
        for (const name of item.names) {
            if (
                seenForms.has(name.text) ||
                name.kind !== "heard_as" ||
                !matches(`${name.text} ${item.name}`, query)
            )
                continue;
            seenForms.add(name.text);
            hits.push({ ...base, kind: "glossary", heard: name.text });
        }
    }
    hits.sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    return {
        hits: hits.slice(0, RESULT_LIMIT),
        limited: Boolean(query) && hits.length > RESULT_LIMIT,
    };
}

/** Search the union of Mine and Tracked, open tasks before completed tasks. */
export async function searchTasks(
    viewer: TaskViewer,
    query: string,
    signal?: AbortSignal,
): Promise<{ hits: TaskSearchHit[]; limited: boolean }> {
    const hits: TaskSearchHit[] = [];
    let scanned = 0;
    const started = Date.now();
    for (const status of ["open", "done"] as const) {
        let after: CallerTaskQuery["after"] = null;
        for (;;) {
            signal?.throwIfAborted();
            if (Date.now() - started >= TASK_DEADLINE_MS)
                return { hits, limited: Boolean(query) };
            const rows = await listCallerTasks(viewer, {
                status,
                after,
                limit: 100,
                assigneePersonId: null,
                recordingId: null,
                dueBefore: null,
                recordingCondition: null,
            });
            signal?.throwIfAborted();
            for (const row of rows) {
                if (Date.now() - started >= TASK_DEADLINE_MS)
                    return { hits, limited: Boolean(query) };
                scanned++;
                if (
                    matches(
                        `${row.text} ${row.note ?? ""} ${row.recording?.title ?? ""}`,
                        query,
                    )
                ) {
                    hits.push({
                        id: row.id,
                        text: row.text,
                        status,
                        dueDate: row.dueDate,
                        recording: row.recording,
                        folder: row.folder,
                        href: `/tasks/${encodeURIComponent(row.id)}`,
                    });
                }
                if (hits.length >= RESULT_LIMIT || scanned >= TASK_SCAN_LIMIT)
                    return { hits, limited: Boolean(query) };
            }
            const last = rows.at(-1);
            if (rows.length < 100 || !last) break;
            after = { at: new Date(last.createdAt), id: last.id };
        }
    }
    return { hits, limited: false };
}

async function searchChatter(
    userId: string,
    query: string,
    signal?: AbortSignal,
): Promise<{ hits: ChatterSearchHit[]; limited: boolean }> {
    signal?.throwIfAborted();
    const orgUserId = await getOrgUserId();
    signal?.throwIfAborted();
    const visibility = or(
        eq(chatterItems.userId, userId),
        orgUserId ? sharedItemCondition(orgUserId, chatterItems.id) : undefined,
    );
    const searches = query
        ? await Promise.all([
              searchItems({
                  viewerUserId: userId,
                  view: "private",
                  query,
                  signal,
              }),
              ...(orgUserId
                  ? [
                        searchItems({
                            viewerUserId: userId,
                            view: "org",
                            query,
                            signal,
                        }),
                    ]
                  : []),
          ])
        : [];
    const found = new Map(
        searches.flatMap((result) => result.hits).map((hit) => [hit.id, hit]),
    );
    if (query && found.size === 0)
        return {
            hits: [],
            limited: searches.some((result) => !result.complete),
        };
    signal?.throwIfAborted();
    const rows = await db
        .select({
            id: chatterItems.id,
            userId: chatterItems.userId,
            title: chatterItems.title,
            kind: chatterItems.kind,
        })
        .from(chatterItems)
        .where(
            and(
                visibility,
                isNull(chatterItems.deletedAt),
                query ? inArray(chatterItems.id, [...found.keys()]) : undefined,
            ),
        )
        .orderBy(desc(chatterItems.occurredAt), desc(chatterItems.id))
        .limit(RESULT_LIMIT + 1);
    signal?.throwIfAborted();
    const decoded = rows
        .slice(0, RESULT_LIMIT)
        .map((row) => ({ ...row, title: decryptText(row.title) }));
    const foreignMail = decoded.filter(
        (row) => row.kind === "mail" && row.userId !== userId,
    );
    const mask =
        foreignMail.length > 0
            ? await secretAddressMasker(foreignMail.map((row) => row.title))
            : (text: string) => text;
    return {
        hits: decoded.map((row) => ({
            id: row.id,
            title:
                row.kind === "mail" && row.userId !== userId
                    ? mask(row.title)
                    : row.title,
            snippet: found.get(row.id)?.snippet ?? null,
            href: `/dashboard?recording=${encodeURIComponent(row.id)}${row.userId !== userId || row.userId === orgUserId ? "&view=org" : ""}`,
        })),
        limited:
            Boolean(query) &&
            (rows.length > RESULT_LIMIT ||
                searches.some((result) => !result.complete)),
    };
}

/** The application palette's sections, each with the viewer's visibility rules. */
export async function searchApp(
    viewer: TaskViewer,
    scope: AppSearchScope,
    query: string,
    signal?: AbortSignal,
): Promise<AppSearchResults> {
    const [chatter, almanac, tasks] = await Promise.all([
        scope === "chatter" || scope === "all"
            ? searchChatter(viewer.userId, query, signal)
            : null,
        scope === "almanac" || scope === "all"
            ? searchAlmanac(viewer.userId, query, signal)
            : null,
        scope === "tasks" || scope === "all"
            ? searchTasks(viewer, query, signal)
            : null,
    ]);
    return {
        chatter: chatter?.hits ?? [],
        almanac: almanac?.hits ?? [],
        tasks: tasks?.hits ?? [],
        limited: Boolean(
            chatter?.limited || almanac?.limited || tasks?.limited,
        ),
    };
}
