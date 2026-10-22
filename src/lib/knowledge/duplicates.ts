import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
    duplicateDismissals,
    duplicateEvidence,
    duplicateForms,
    duplicatePairSignals,
} from "@/db/queries/almanac-duplicates";
import {
    almanacDuplicateDismissals,
    knowledgeEntities,
    knowledgeEntityTypes,
    people,
} from "@/db/schema";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    MAX_DUPLICATE_PAGE_SIZE,
    MAX_DUPLICATE_RECORDS,
} from "@/lib/knowledge/duplicate-limits";
import {
    type DuplicateKind,
    type DuplicateRecord,
    type DuplicateScore,
    rankDuplicateRecords,
    scoreDuplicate,
} from "@/lib/knowledge/duplicate-score";
import { lockOrgPeople } from "@/lib/knowledge/org-people";
import { readScopeGenerations } from "@/lib/knowledge/scope-generation";
import { getOrgUserId } from "@/lib/org/config";

export { MAX_DUPLICATE_PAGE_SIZE, MAX_DUPLICATE_RECORDS };

export interface DuplicateCandidate extends DuplicateScore {
    key: string;
    left: DuplicateRecord;
    right: DuplicateRecord;
    survivorId: string;
}

export interface DuplicatePage {
    candidates: DuplicateCandidate[];
    nextCursor: string | null;
    limited: boolean;
}

/** Resolve the Organization only after checking the caller's current curator access. */
export async function requireDuplicateCurator(
    actorId: string,
): Promise<string> {
    if (!(await userCuratesOrganizationNow(actorId))) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only an Organization curator can curate duplicates",
            403,
        );
    }
    const scope = await getOrgUserId();
    if (!scope)
        throw new AppError(ErrorCode.NOT_FOUND, "Organization not found", 404);
    return scope;
}

/** A stable ordered pair; its ids never contain the separator. */
export function duplicatePairKey(left: string, right: string): string {
    return [left, right].sort().join(":");
}

/** Load only live Organization records and bounded forms, decrypting solely in memory. */
export async function loadDuplicateRecords(
    scope: string,
    kind: DuplicateKind,
    onlyIds?: string[],
) {
    const rows =
        kind === "person"
            ? await db
                  .select({
                      id: people.id,
                      name: people.displayName,
                      primaryEmail: people.primaryEmail,
                  })
                  .from(people)
                  .where(
                      and(
                          eq(people.userId, scope),
                          isNull(people.mergedIntoId),
                          onlyIds ? inArray(people.id, onlyIds) : undefined,
                      ),
                  )
                  .orderBy(desc(people.createdAt), people.id)
                  .limit(MAX_DUPLICATE_RECORDS + 1)
            : await db
                  .select({
                      id: knowledgeEntities.id,
                      name: knowledgeEntities.name,
                      typeKey: knowledgeEntities.typeKey,
                  })
                  .from(knowledgeEntities)
                  .where(
                      and(
                          eq(knowledgeEntities.userId, scope),
                          isNull(knowledgeEntities.mergedIntoId),
                          onlyIds
                              ? inArray(knowledgeEntities.id, onlyIds)
                              : undefined,
                      ),
                  )
                  .orderBy(
                      desc(knowledgeEntities.createdAt),
                      knowledgeEntities.id,
                  )
                  .limit(MAX_DUPLICATE_RECORDS + 1);
    const limited = rows.length > MAX_DUPLICATE_RECORDS;
    const live = rows.slice(0, MAX_DUPLICATE_RECORDS);
    const ids = live.map((row) => row.id);
    const [forms, evidence] = await Promise.all([
        duplicateForms(scope, kind, ids),
        duplicateEvidence(scope, kind, ids),
    ]);
    const records: DuplicateRecord[] = live.map((row) => ({
        id: row.id,
        kind,
        name: decryptText(row.name),
        typeKey: "typeKey" in row ? row.typeKey : "person",
        primaryEmail:
            "primaryEmail" in row && row.primaryEmail
                ? decryptText(row.primaryEmail)
                : null,
        emails: [],
        aliases: [],
        heardAs: [],
        evidenceCount: 0,
    }));
    if (kind === "entity" && records.length > 0) {
        const types = await db
            .select({
                key: knowledgeEntityTypes.key,
                label: knowledgeEntityTypes.label,
            })
            .from(knowledgeEntityTypes)
            .where(
                and(
                    inArray(knowledgeEntityTypes.key, [
                        ...new Set(records.map((record) => record.typeKey)),
                    ]),
                    or(
                        eq(knowledgeEntityTypes.userId, scope),
                        isNull(knowledgeEntityTypes.userId),
                    ),
                ),
            );
        const labels = new Map(
            types.map((type) => [type.key, decryptText(type.label)]),
        );
        for (const record of records)
            record.typeLabel = labels.get(record.typeKey);
    }
    const byId = new Map(records.map((record) => [record.id, record]));
    for (const row of forms.aliases) {
        byId.get(row.id)?.[row.kind === "alias" ? "aliases" : "heardAs"].push(
            decryptText(row.text),
        );
    }
    for (const row of forms.emails)
        byId.get(row.id)?.emails.push(decryptText(row.email));
    for (const row of evidence) {
        const record = byId.get(row.id);
        if (record) record.evidenceCount = row.count;
    }
    return { records, limited };
}

function cursorOf(
    candidate: Pick<DuplicateCandidate, "score" | "key">,
): string {
    return Buffer.from(
        JSON.stringify({ score: candidate.score, key: candidate.key }),
    ).toString("base64url");
}

function parseCursor(
    cursor?: string | null,
): { score: number; key: string } | null {
    if (!cursor) return null;
    try {
        if (cursor.length > 512) throw new Error();
        const value: unknown = JSON.parse(
            Buffer.from(cursor, "base64url").toString(),
        );
        if (
            typeof value !== "object" ||
            value === null ||
            !("score" in value) ||
            !("key" in value) ||
            typeof value.score !== "number" ||
            !Number.isFinite(value.score) ||
            value.score < 0 ||
            value.score > 1 ||
            typeof value.key !== "string" ||
            value.key.length > 200
        )
            throw new Error();
        return { score: value.score, key: value.key };
    } catch {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid duplicate cursor",
            400,
        );
    }
}

interface RankedScan {
    candidates: DuplicateCandidate[];
    limited: boolean;
}

interface CachedScan {
    scope: string;
    generation: number;
    expires: number;
    bytes: number;
    scan: RankedScan;
    timer: ReturnType<typeof setTimeout>;
}

const scans = new Map<string, CachedScan>();
const inFlight = new Map<string, Promise<RankedScan>>();
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_TTL = 5 * 60_000;

function dropScan(key: string) {
    const cached = scans.get(key);
    if (cached) clearTimeout(cached.timer);
    scans.delete(key);
}

function expiryTimer(key: string) {
    const timer = setTimeout(() => dropScan(key), CACHE_TTL);
    timer.unref();
    return timer;
}

function compareKeys(a: string, b: string): number {
    if (a < b) return -1;
    return a > b ? 1 : 0;
}

async function computeScan(
    scope: string,
    kind: DuplicateKind,
    generation: number,
    key: string,
    sourceId?: string,
): Promise<RankedScan> {
    const loaded = await loadDuplicateRecords(scope, kind);
    const records = loaded.records;
    if (sourceId && !records.some((record) => record.id === sourceId)) {
        const source = (await loadDuplicateRecords(scope, kind, [sourceId]))
            .records[0];
        if (!source)
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Source record not found",
                404,
            );
        records.splice(Math.max(0, records.length - 1), 1, source);
        loaded.limited = true;
    }
    const ranked = await rankDuplicateRecords(records, sourceId);
    const signals = await duplicatePairSignals(
        scope,
        kind,
        ranked.candidates.map(({ left, right }) => ({
            left: left.id,
            right: right.id,
        })),
    );
    const speakers = new Set(
        signals.speakers.map((pair) => duplicatePairKey(pair.left, pair.right)),
    );
    const candidates = ranked.candidates.map((pair) => {
        if (!speakers.has(duplicatePairKey(pair.left.id, pair.right.id)))
            return pair;
        return { ...pair, ...scoreDuplicate(pair.left, pair.right, true) };
    });
    candidates.sort((a, b) => b.score - a.score || compareKeys(a.key, b.key));
    const scan = { candidates, limited: loaded.limited || ranked.limited };
    if (
        !sourceId &&
        ((await readScopeGenerations(db, [scope])).get(scope) ?? 0) ===
            generation
    ) {
        const bytes =
            JSON.stringify(records).length * 2 + candidates.length * 512;
        if (bytes <= MAX_CACHE_BYTES) {
            let total = [...scans.values()].reduce(
                (sum, value) => sum + value.bytes,
                0,
            );
            while (scans.size >= 4 || total + bytes > MAX_CACHE_BYTES) {
                const oldest = scans.keys().next().value;
                if (!oldest) break;
                total -= scans.get(oldest)?.bytes ?? 0;
                dropScan(oldest);
            }
            scans.set(key, {
                scope,
                generation,
                expires: Date.now() + CACHE_TTL,
                bytes,
                scan,
                timer: expiryTimer(key),
            });
        }
    }
    console.info("Almanac duplicate scan", {
        records: records.length,
        candidates: candidates.length,
        limited: Number(scan.limited),
    });
    return scan;
}

async function scanKind(
    scope: string,
    kind: DuplicateKind,
    sourceId?: string,
): Promise<RankedScan> {
    const generation =
        (await readScopeGenerations(db, [scope])).get(scope) ?? 0;
    for (const [oldKey, value] of scans) {
        if (
            value.expires <= Date.now() ||
            (value.scope === scope && value.generation < generation)
        )
            dropScan(oldKey);
    }
    const key = JSON.stringify([scope, kind]);
    const cached = sourceId ? undefined : scans.get(key);
    if (cached?.generation === generation) {
        scans.delete(key);
        scans.set(key, cached);
        return cached.scan;
    }
    const flightKey = JSON.stringify([
        scope,
        kind,
        sourceId ?? null,
        generation,
    ]);
    const pending = inFlight.get(flightKey);
    if (pending) return pending;
    const promise = computeScan(scope, kind, generation, key, sourceId);
    inFlight.set(flightKey, promise);
    try {
        return await promise;
    } finally {
        inFlight.delete(flightKey);
    }
}

/** Slice a generation-checked ranking; the bounded process cache is only an optimization. */
export async function listDuplicateCandidates(
    actorId: string,
    options: {
        kind?: DuplicateKind;
        limit?: number;
        cursor?: string | null;
        sourceId?: string;
    } = {},
): Promise<DuplicatePage> {
    const scope = await requireDuplicateCurator(actorId);
    const limit = options.limit ?? 20;
    if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_DUPLICATE_PAGE_SIZE
    )
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid duplicate page size",
            400,
        );
    const cursor = parseCursor(options.cursor);
    if (options.sourceId && !options.kind)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A source record needs its kind",
            400,
        );
    const kind = options.kind ?? "person";
    const scan = await scanKind(scope, kind, options.sourceId);
    const dismissed = new Set(
        (await duplicateDismissals(scope, kind)).map((pair) =>
            duplicatePairKey(pair.left, pair.right),
        ),
    );
    const visible = scan.candidates.filter(
        (pair) => !dismissed.has(duplicatePairKey(pair.left.id, pair.right.id)),
    );
    const candidates = cursor
        ? visible.filter(
              (candidate) =>
                  candidate.score < cursor.score ||
                  (candidate.score === cursor.score &&
                      candidate.key > cursor.key),
          )
        : visible;
    const page = candidates.slice(0, limit);
    const last = page.at(-1);
    return {
        candidates: page,
        nextCursor: candidates.length > limit && last ? cursorOf(last) : null,
        limited: scan.limited,
    };
}

/** Permanently dismiss a live Organization pair; merges retain its tombstone references. */
export async function dismissDuplicate(
    actorId: string,
    kind: DuplicateKind,
    left: string,
    right: string,
): Promise<void> {
    const scope = await requireDuplicateCurator(actorId);
    await db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        await requireDuplicateCurator(actorId);
        const table = kind === "person" ? people : knowledgeEntities;
        const rows = await tx
            .select({ id: table.id })
            .from(table)
            .where(
                and(
                    eq(table.userId, scope),
                    inArray(table.id, [left, right]),
                    isNull(table.mergedIntoId),
                ),
            );
        if (left === right || rows.length !== 2)
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Duplicate pair not found",
                404,
            );
        const [first = "", second = ""] = [left, right].sort();
        await tx
            .insert(almanacDuplicateDismissals)
            .values({
                userId: scope,
                kind,
                dismissedByUserId: actorId,
                ...(kind === "person"
                    ? { leftPersonId: first, rightPersonId: second }
                    : { leftEntityId: first, rightEntityId: second }),
            })
            .onConflictDoNothing();
    });
}
