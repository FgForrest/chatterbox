import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Children, isValidElement } from "react";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import StatisticsRoute from "@/app/(app)/statistics/page";
import { GET } from "@/app/api/statistics/route";
import { StatisticsPage } from "@/components/statistics/statistics-page";
import { loadStatistics, statisticsScopes } from "@/db/queries/statistics";
import { writeStorageSnapshots } from "@/db/queries/storage-snapshots";
import {
    aiEnhancements,
    aiUsageEvents,
    asyncJobs,
    chatterItems,
    folderShares,
    itemShares,
    knowledgeAliases,
    knowledgeEntities,
    mailMessages,
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    storageDailySnapshots,
    taskStatusTransitions,
    users,
} from "@/db/schema";
import {
    metricIndex,
    type StatisticsData,
    shiftDay,
    unpackRanking,
} from "@/lib/statistics/data";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { ref, mode, statements } = vi.hoisted(() => ({
    ref: { current: null as Record<PropertyKey, unknown> | null },
    mode: { IS_HOSTED: false, SELF_HOST_MODE: "shared", AUTHZ_MODE: "local" },
    statements: [] as unknown[],
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get(_target, key) {
                if (!ref.current) throw new Error("Database not initialized");
                const value = ref.current[key];
                if (key === "execute" && typeof value === "function")
                    return (statement: unknown) => {
                        statements.push(statement);
                        return value.call(ref.current, statement);
                    };
                return typeof value === "function"
                    ? value.bind(ref.current)
                    : value;
            },
        },
    ),
}));
vi.mock("@/lib/env", () => ({ env: mode }));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/statistics/statistics-page", () => ({
    StatisticsPage: () => null,
}));
vi.mock("next-intl/server", () => ({ getExtracted: vi.fn() }));
vi.mock("next/headers", () => ({
    headers: async () => new Headers({ "x-test-user": "viewer" }),
    cookies: async () => ({ get: () => ({ value: "Europe/Prague" }) }),
}));
vi.mock("@/lib/auth", () => ({
    auth: {
        api: {
            getSession: async ({ headers }: { headers: Headers }) => {
                const id = headers.get("x-test-user");
                return id
                    ? {
                          user: { id, email: `${id}@example.test` },
                          session: { id: "test-session" },
                      }
                    : null;
            },
        },
    },
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

const url = getTestDatabaseUrl();
const at = new Date("2026-10-26T12:00:00Z");
const earlier = new Date("2025-01-01T12:00:00Z");

describe.skipIf(!url)("statistics scopes (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url as string,
            "statistics",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    }, 30_000);
    afterEach(() => vi.useRealTimers());
    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ["Date"], now: at });
        mode.IS_HOSTED = false;
        mode.SELF_HOST_MODE = "shared";
        statements.length = 0;
        await database.db.delete(users);
        await database.db.insert(users).values([
            {
                id: "viewer",
                name: "Jitka Dvořáková",
                email: "viewer@example.test",
            },
            { id: "member", name: "Marek Nový", email: "member@example.test" },
            {
                id: "org",
                name: "Organization",
                email: "org@example.test",
                role: "org",
            },
        ]);
        await database.db.insert(recordingFolders).values([
            { id: "shared", userId: "org", name: "Shared", nameHash: "shared" },
            {
                id: "also-shared",
                userId: "org",
                name: "Also shared",
                nameHash: "also-shared",
            },
        ]);
        await recording("own", "viewer", 10, false);
        await recording("shared-recording", "member", 20, true);
        await recording("private", "member", 30, false);
        await database.db.insert(recordingFolderAssignments).values({
            userId: "member",
            itemId: "shared-recording",
            folderId: "also-shared",
        });
        await usage("own", "viewer", "viewer", "viewer", "1");
        await usage("shared-recording", "member", "member", "org", "2");
        await usage("private", "member", "member", "member", "3");
        await database.db.insert(people).values([
            { userId: "viewer", displayName: "Private person", createdAt: at },
            {
                userId: "member",
                displayName: "Another private person",
                createdAt: at,
            },
            { userId: "org", displayName: "Promoted person", createdAt: at },
            {
                userId: "org",
                displayName: "Merge tombstone",
                mergedIntoId: "merged",
                createdAt: at,
            },
        ]);
    });
    async function recording(
        id: string,
        userId: string,
        minutes: number,
        shared: boolean,
        date = at,
    ) {
        await insertRecordings(database.db, {
            id,
            userId,
            deviceSn: "recorder",
            plaudFileId: id,
            duration: minutes * 60_000,
            filename: "Never expose this title",
            startTime: date,
            endTime: new Date(date.getTime() + minutes * 60_000),
            filesize: 1000,
            fileMd5: "a".repeat(32),
            storageType: "local",
            storagePath: "test/audio.opus",
            plaudVersion: "1",
            createdAt: date,
            downloadedAt: date,
        });
        if (shared)
            await database.db
                .insert(recordingFolderAssignments)
                .values({ userId, itemId: id, folderId: "shared" });
    }
    async function usage(
        itemId: string,
        userId: string,
        actorUserId: string,
        payerUserId: string,
        costUsd: string | null,
        operation = "summary",
        date = at,
    ) {
        await database.db.insert(aiUsageEvents).values({
            itemId,
            userId,
            actorUserId,
            payerUserId,
            costUsd,
            operation,
            provider: "Example provider",
            model: "example-model",
            createdAt: date,
        });
    }
    const total = (data: StatisticsData, metric: keyof typeof metricIndex) =>
        data.daily[metricIndex[metric]].reduce((a, b) => a + b, 0);
    function api(scope: string, signedIn = true) {
        return GET(
            new Request(
                `http://localhost/api/statistics?scope=${scope}&tz=UTC`,
                {
                    headers: signedIn ? { "x-test-user": "viewer" } : {},
                },
            ),
        );
    }
    it("refuses an unauthenticated statistics request through the real API and auth gate", async () => {
        const response = await api("everyone", false);
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
            code: "AUTH_SESSION_MISSING",
        });
        expect(statements).toHaveLength(0);
    });
    it("returns 400 for an unknown scope through the real API", async () => {
        const response = await api("invalid");
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
        expect(statements).toHaveLength(0);
    });
    it.each([
        [true, "shared", "organization"],
        [true, "shared", "everyone"],
        [false, "local", "organization"],
        [false, "local", "everyone"],
    ])("returns 403 through the API in hosted=%s mode=%s for %s", async (hosted, selfHostMode, scope) => {
        mode.IS_HOSTED = Boolean(hosted);
        mode.SELF_HOST_MODE = String(selfHostMode);
        const response = await api(String(scope));
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
        expect(statements).toHaveLength(0);
    });
    it("serves caller-owned aggregates through the real API without caching", async () => {
        const response = await api("mine");
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        const data = (await response.json()) as StatisticsData;
        expect(total(data, "minutes")).toBe(10);
    });
    it.each([
        [true, "shared", "mine", ["mine"]],
        [false, "local", "mine", ["mine"]],
        [false, "shared", "organization", ["mine", "organization", "everyone"]],
    ] as const)("wires the real server page in hosted=%s mode=%s", async (hosted, selfHostMode, expectedScope, expectedScopes) => {
        mode.IS_HOSTED = hosted;
        mode.SELF_HOST_MODE = selfHostMode;
        const page = await StatisticsRoute();
        const content = Children.toArray(page.props.children).find(
            (child) => isValidElement(child) && child.type === StatisticsPage,
        );
        if (
            !isValidElement<{ initialData: StatisticsData; scopes: string[] }>(
                content,
            )
        )
            throw new Error("Statistics component missing");
        expect(content.props.scopes).toEqual(expectedScopes);
        expect(content.props.initialData.scope).toBe(expectedScope);
        expect(content.props.initialData.tz).toBe("Europe/Prague");
        expect(total(content.props.initialData, "minutes")).toBe(
            expectedScope === "mine" ? 10 : 20,
        );
    });
    it("Mine excludes other owners while measuring caller-paid usage", async () => {
        await usage("private", "member", "viewer", "viewer", "4");
        const data = await loadStatistics("viewer", "mine", "UTC", at);
        expect(total(data, "minutes")).toBe(10);
        expect(total(data, "recordings")).toBe(1);
        expect(total(data, "summaries")).toBe(1);
        expect(total(data, "summaryCost")).toBe(5);
        expect(data.daily[metricIndex.people][364]).toBe(1);
        expect(data.ranking).toEqual([]);
        expect(data.members).toEqual([]);
    });
    it.each([
        "direct",
        "folder",
    ] as const)("keeps accepted %s shares outside the receiver's Mine and Organization", async (kind) => {
        await database.db.insert(recordingFolders).values([
            {
                id: "personal-source",
                userId: "member",
                name: "Source",
                nameHash: "source",
            },
            {
                id: "personal-filing",
                userId: "viewer",
                name: "Received",
                nameHash: "received",
            },
        ]);
        if (kind === "folder") {
            await database.db.insert(recordingFolderAssignments).values({
                userId: "member",
                itemId: "private",
                folderId: "personal-source",
            });
            await database.db.insert(folderShares).values({
                id: "live-share",
                userId: "member",
                receiverUserId: "viewer",
                folderId: "personal-source",
                state: "accepted",
                respondedAt: at,
            });
        } else {
            await database.db.insert(itemShares).values({
                userId: "member",
                receiverUserId: "viewer",
                itemId: "private",
                state: "accepted",
                filingFolderId: "personal-filing",
                respondedAt: at,
            });
        }
        const mine = await loadStatistics("viewer", "mine", "UTC", at);
        const org = await loadStatistics("viewer", "organization", "UTC", at);
        expect(total(mine, "minutes")).toBe(10);
        expect(total(mine, "recordings")).toBe(1);
        expect(total(mine, "summaries")).toBe(1);
        expect(total(org, "minutes")).toBe(20);
        expect(total(org, "recordings")).toBe(1);
        expect(total(org, "summaries")).toBe(1);
    });
    it("Organization uses shared items once and Organization-paid spend", async () => {
        await usage("own", "viewer", "viewer", "org", "7");
        const data = await loadStatistics("viewer", "organization", "UTC", at);
        expect(total(data, "minutes")).toBe(20);
        expect(total(data, "recordings")).toBe(1);
        expect(total(data, "summaries")).toBe(1);
        expect(total(data, "summaryCost")).toBe(9);
        expect(data.daily[metricIndex.people][364]).toBe(1);
        expect(
            unpackRanking(data.ranking)
                .find((row) => data.members[row[1]][0] === "Marek Nový")
                ?.slice(2),
        ).toEqual([20, 0, 0, 2]);
    });
    it("Everyone includes private items once, preserves real AI runs and excludes Organization ranking rows", async () => {
        await database.db.insert(aiEnhancements).values([
            {
                itemId: "shared-recording",
                userId: "member",
                summary: "Owner summary",
                model: "example-model",
                provider: "Example",
                createdAt: new Date(at.getTime() + 30 * 60_000),
            },
            {
                itemId: "shared-recording",
                userId: "org",
                summary: "Legacy org copy",
                model: "example-model",
                provider: "Example",
                createdAt: new Date(at.getTime() + 40 * 60_000),
            },
        ]);
        await usage("shared-recording", "member", "org", "org", "0.5");
        const data = await loadStatistics("viewer", "everyone", "UTC", at);
        expect(total(data, "minutes")).toBe(60);
        expect(total(data, "recordings")).toBe(3);
        expect(total(data, "summaries")).toBe(4);
        expect(total(data, "summaryCost")).toBe(6.5);
        expect(data.daily[metricIndex.people][364]).toBe(3);
        expect(data.members.map(([name]) => name)).toEqual([
            "Marek Nový",
            "Jitka Dvořáková",
        ]);
        expect(data.latency).toEqual([[364, 600, 1]]);
        expect(JSON.stringify(data)).not.toMatch(
            /Never expose|Owner summary|Legacy org copy|example.test/,
        );
    });
    it.each([
        "organization",
        "everyone",
    ] as const)("refuses %s in hosted and local mode before aggregate queries", async (scope) => {
        for (const hosted of [true, false]) {
            mode.IS_HOSTED = hosted;
            mode.SELF_HOST_MODE = hosted ? "shared" : "local";
            const before = statements.length;
            await expect(
                loadStatistics("viewer", scope, "UTC", at),
            ).rejects.toMatchObject({ statusCode: 403 });
            expect(statements.length).toBe(before);
            expect(await statisticsScopes()).toEqual(["mine"]);
        }
    });
    it("uses local calendar days and hours, including a UTC date crossing", async () => {
        await recording(
            "late-night",
            "viewer",
            5,
            false,
            new Date("2026-10-26T00:30:00Z"),
        );
        const data = await loadStatistics(
            "viewer",
            "mine",
            "America/New_York",
            at,
        );
        expect(data.daily[metricIndex.minutes][363]).toBe(5);
        expect(data.daily[metricIndex.minutes][364]).toBe(10);
        expect(data.heat).toContainEqual([363, 20, 1]);
    });
    it.each([
        [
            "spring gap",
            "2026-03-29",
            "2026-03-28T23:00:00Z",
            "2026-03-29T00:30:00Z",
            "2026-03-29T01:30:00Z",
            "2026-03-29T21:59:59Z",
            "2026-03-29T22:00:00Z",
            [1, 3],
        ],
        [
            "autumn fold",
            "2026-10-25",
            "2026-10-24T22:00:00Z",
            "2026-10-25T00:30:00Z",
            "2026-10-25T01:30:00Z",
            "2026-10-25T22:59:59Z",
            "2026-10-25T23:00:00Z",
            [2, 2],
        ],
    ] as const)("buckets Prague's %s by local day and hour and keeps snapshot dates in UTC", async (_name, localDay, midnight, before, after, last, next, hours) => {
        await database.db.delete(chatterItems);
        const first = new Date(midnight);
        const dates = [
            new Date(first.getTime() - 1),
            first,
            new Date(before),
            new Date(after),
            new Date(last),
            new Date(next),
        ];
        for (const [index, date] of dates.entries())
            await recording(`dst-${index}`, "viewer", 1, false, date);
        const data = await loadStatistics(
            "viewer",
            "mine",
            "Europe/Prague",
            new Date(next),
        );
        const day = Math.round(
            (Date.parse(localDay) - Date.parse(data.start)) / 86_400_000,
        );
        expect(data.daily[metricIndex.startedRecordings][day - 1]).toBe(1);
        expect(data.daily[metricIndex.startedRecordings][day]).toBe(4);
        expect(data.daily[metricIndex.startedRecordings][day + 1]).toBe(1);
        expect(data.daily[metricIndex.recordings][day]).toBe(4);
        expect(data.heat).toContainEqual([day, 0, 1]);
        expect(data.heat).toContainEqual([day, 23, 1]);
        if (hours[0] === hours[1])
            expect(data.heat).toContainEqual([day, hours[0], 2]);
        else
            for (const hour of hours)
                expect(data.heat).toContainEqual([day, hour, 1]);
        await writeStorageSnapshots(first);
        const snapshotDay = first.toISOString().slice(0, 10);
        expect(snapshotDay).toBe(shiftDay(localDay, -1));
        expect(
            (await database.db.select().from(storageDailySnapshots)).every(
                (row) => row.day === snapshotDay,
            ),
        ).toBe(true);
        const measured = await loadStatistics(
            "viewer",
            "mine",
            "Europe/Prague",
            new Date(next),
        );
        expect(measured.measuredFrom).toBe(snapshotDay);
        expect(measured.daily[metricIndex.audioBytes][day - 2]).toBe(0);
        expect(measured.daily[metricIndex.audioBytes][day - 1]).toBe(6000);
        expect(measured.daily[metricIndex.audioBytes][day]).toBe(6000);
    });
    it("reconstructs disk and open-task baselines and subtracts deletion or reaping only once", async () => {
        await recording("old", "viewer", 5, false, earlier);
        await database.db
            .update(recordings)
            .set({ audioReapedAt: at, deletedAt: at })
            .where(sql`${recordings.id} = 'old'`);
        await database.db.insert(recordingTasks).values([
            {
                userId: "viewer",
                itemId: "own",
                source: "manual",
                text: "Never return task content",
                status: "done",
                createdAt: earlier,
                statusChangedAt: at,
                statusChangedByUserId: "member",
            },
            {
                userId: "viewer",
                source: "personal",
                text: "Own task",
                status: "open",
                createdAt: earlier,
            },
            {
                userId: "member",
                itemId: "private",
                source: "manual",
                text: "Other task",
                status: "open",
                createdAt: earlier,
            },
        ]);
        const data = await loadStatistics("viewer", "mine", "UTC", at);
        expect(data.daily[metricIndex.audioBytes][0]).toBe(1000);
        expect(data.daily[metricIndex.audioBytes][364]).toBe(1000);
        expect(data.daily[metricIndex.openTasks][0]).toBe(2);
        expect(data.daily[metricIndex.openTasks][364]).toBe(1);
        expect(total(data, "tasksDone")).toBe(1);
    });
    it("counts mail summaries by event, owner and received date", async () => {
        await database.db.insert(chatterItems).values({
            id: "mail",
            userId: "viewer",
            kind: "mail",
            title: "Never return subject",
            occurredAt: at,
            createdAt: at,
        });
        await database.db.insert(mailMessages).values({
            id: "mail",
            userId: "viewer",
            rawHash: "test-hash",
            receivedAt: at,
            sizeBytes: 500,
            auth: {},
            senderVerified: true,
            createdAt: at,
        });
        await usage("mail", "viewer", "viewer", "viewer", "1");
        await usage("mail", "viewer", "viewer", "viewer", "1");
        const data = await loadStatistics("viewer", "mine", "UTC", at);
        expect(total(data, "mail")).toBe(1);
        expect(total(data, "mailSummaries")).toBe(2);
        expect(data.daily[metricIndex.mailBytes][364]).toBe(500);
    });
    it("maps correction into learning, preserves unpriced jobs and excludes merged knowledge", async () => {
        await usage("own", "viewer", "viewer", "viewer", "0.2", "correction");
        await usage("own", "viewer", "viewer", "viewer", null, "learn");
        const [entity] = await database.db
            .insert(knowledgeEntities)
            .values({
                userId: "viewer",
                typeKey: "term",
                name: "Synthetic term",
                nameHmac: "term-hash",
                createdAt: earlier,
            })
            .returning();
        await database.db.insert(knowledgeAliases).values({
            userId: "viewer",
            entityId: entity.id,
            kind: "alias",
            text: "Term alias",
            textHmac: "alias-hash",
            createdAt: at,
        });
        const data = await loadStatistics("viewer", "mine", "UTC", at);
        expect(total(data, "learnCost")).toBe(0.2);
        expect(total(data, "unpriced")).toBe(1);
        expect(data.daily[metricIndex.terms][0]).toBe(1);
        expect(data.daily[metricIndex.aliases][364]).toBe(1);
        expect(data.modelDays.filter((row) => row[2] === 1)).toEqual([
            [364, 0, 1, 2, 0.2, 1],
        ]);
    });
    it("attributes ranking task resolutions to the person who changed the status", async () => {
        await database.db.insert(recordingTasks).values({
            userId: "member",
            itemId: "shared-recording",
            source: "manual",
            text: "Shared task",
            status: "done",
            createdAt: at,
            statusChangedAt: at,
            statusChangedByUserId: "viewer",
        });
        const data = await loadStatistics("viewer", "organization", "UTC", at);
        expect(
            unpackRanking(data.ranking).find(
                (row) => data.members[row[1]][1],
            )?.[4],
        ).toBe(1);
    });
    it("derives recording sources and keeps import counts separate from start-day counts", async () => {
        await recording("uploaded-sample", "viewer", 3, false);
        await recording("meeting-sample", "viewer", 4, false);
        await database.db
            .update(recordings)
            .set({ deviceSn: "local" })
            .where(sql`${recordings.id} = 'meeting-sample'`);
        await recording("historic-import", "viewer", 5, false, earlier);
        await database.db
            .update(recordings)
            .set({ createdAt: at })
            .where(sql`${recordings.id} = 'historic-import'`);
        const data = await loadStatistics("viewer", "mine", "UTC", at);
        expect(total(data, "upload")).toBe(3);
        expect(total(data, "meeting")).toBe(4);
        expect(total(data, "plaud")).toBe(10);
        expect(total(data, "recordings")).toBe(4);
        expect(total(data, "startedRecordings")).toBe(3);
    });
    it("requires an Organization account for that scope but keeps Everyone in shared mode", async () => {
        await database.db.delete(users).where(sql`${users.id} = 'org'`);
        expect(await statisticsScopes()).toEqual(["mine", "everyone"]);
        await expect(
            loadStatistics("viewer", "organization", "UTC", at),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(
            total(
                await loadStatistics("viewer", "everyone", "UTC", at),
                "minutes",
            ),
        ).toBe(60);
    });
    it("rejects unknown scopes and returns neutral names without emails or user ids", async () => {
        await expect(
            loadStatistics("viewer", "invalid" as "mine", "UTC", at),
        ).rejects.toMatchObject({ statusCode: 400 });
        await database.db
            .update(users)
            .set({ name: "member@example.test" })
            .where(sql`${users.id} = 'member'`);
        const data = await loadStatistics("viewer", "everyone", "UTC", at);
        expect(data.members[0]).toEqual([null, false]);
        expect(JSON.stringify(data)).not.toContain("example.test");
    });
    it("upserts UTC snapshots concurrently with exact retained and shared sizes", async () => {
        await recording("old-reaped", "viewer", 1, false, earlier);
        await database.db
            .update(recordings)
            .set({ audioReapedAt: at })
            .where(sql`${recordings.id} = 'old-reaped'`);
        await recording("not-downloaded", "viewer", 1, false);
        await database.db
            .update(recordings)
            .set({ downloadedAt: null })
            .where(sql`${recordings.id} = 'not-downloaded'`);
        await database.db.insert(chatterItems).values([
            {
                id: "shared-mail",
                userId: "member",
                kind: "mail",
                title: "Mail with attachments",
                occurredAt: at,
            },
            {
                id: "private-mail",
                userId: "viewer",
                kind: "mail",
                title: "Private mail",
                occurredAt: at,
            },
            {
                id: "reaped-mail",
                userId: "viewer",
                kind: "mail",
                title: "Reaped mail",
                occurredAt: at,
            },
        ]);
        await database.db.insert(mailMessages).values([
            {
                id: "shared-mail",
                userId: "member",
                sizeBytes: 1500,
                rawStoragePath: "test/shared.eml",
                rawHash: "shared",
                receivedAt: at,
                auth: {},
                senderVerified: true,
            },
            {
                id: "private-mail",
                userId: "viewer",
                sizeBytes: 250,
                rawStoragePath: "test/private.eml",
                rawHash: "private",
                receivedAt: at,
                auth: {},
                senderVerified: true,
            },
            {
                id: "reaped-mail",
                userId: "viewer",
                sizeBytes: 750,
                rawReapedAt: at,
                rawHash: "reaped",
                receivedAt: at,
                auth: {},
                senderVerified: true,
            },
        ]);
        await database.db.insert(recordingFolderAssignments).values({
            itemId: "shared-mail",
            userId: "member",
            folderId: "shared",
        });
        await Promise.all([
            writeStorageSnapshots(at),
            writeStorageSnapshots(at),
        ]);
        await writeStorageSnapshots(new Date("2026-10-26T12:30:00Z"));

        const rows = await database.db
            .select()
            .from(storageDailySnapshots)
            .orderBy(storageDailySnapshots.userId);
        expect(rows).toEqual([
            {
                userId: "member",
                day: "2026-10-26",
                audioBytes: 2000,
                sharedAudioBytes: 1000,
                mailBytes: 1500,
                sharedMailBytes: 1500,
            },
            {
                userId: "org",
                day: "2026-10-26",
                audioBytes: 0,
                sharedAudioBytes: 0,
                mailBytes: 0,
                sharedMailBytes: 0,
            },
            {
                userId: "viewer",
                day: "2026-10-26",
                audioBytes: 1000,
                sharedAudioBytes: 0,
                mailBytes: 250,
                sharedMailBytes: 0,
            },
        ]);
        await database.db
            .update(recordings)
            .set({ audioReapedAt: at })
            .where(sql`${recordings.id} = 'own'`);
        expect(
            await writeStorageSnapshots(new Date("2026-10-26T13:00:00Z")),
        ).toBe(0);
        expect(
            await writeStorageSnapshots(new Date("2026-10-27T00:00:00Z")),
        ).toBe(3);
        expect(
            await database.db
                .select({
                    day: storageDailySnapshots.day,
                    audioBytes: storageDailySnapshots.audioBytes,
                })
                .from(storageDailySnapshots)
                .where(sql`${storageDailySnapshots.userId} = 'viewer'`)
                .orderBy(storageDailySnapshots.day),
        ).toEqual([
            { day: "2026-10-26", audioBytes: 1000 },
            { day: "2026-10-27", audioBytes: 0 },
        ]);
        await database.db.delete(users).where(sql`${users.id} = 'viewer'`);
        expect(
            await database.db
                .select()
                .from(storageDailySnapshots)
                .where(sql`${storageDailySnapshots.userId} = 'viewer'`),
        ).toEqual([]);
    });
    it.each([
        "mine",
        "organization",
        "everyone",
    ] as const)("switches estimated to measured disk history in %s with carry-forward and no Organization duplicates", async (scope) => {
        await recording("historical", "viewer", 1, false, earlier);
        if (scope === "everyone")
            await recording("org-duplicate", "org", 1, true, earlier);
        await database.db.insert(storageDailySnapshots).values([
            {
                userId: "viewer",
                day: "2026-10-24",
                audioBytes: 100,
                sharedAudioBytes: 0,
                mailBytes: 10,
                sharedMailBytes: 0,
            },
            {
                userId: "member",
                day: "2026-10-24",
                audioBytes: 200,
                sharedAudioBytes: 50,
                mailBytes: 20,
                sharedMailBytes: 5,
            },
            {
                userId: "org",
                day: "2026-10-24",
                audioBytes: 9000,
                sharedAudioBytes: 0,
                mailBytes: 9000,
                sharedMailBytes: 0,
            },
            {
                userId: "viewer",
                day: "2026-10-26",
                audioBytes: 150,
                sharedAudioBytes: 0,
                mailBytes: 15,
                sharedMailBytes: 0,
            },
            {
                userId: "member",
                day: "2026-10-26",
                audioBytes: 250,
                sharedAudioBytes: 75,
                mailBytes: 25,
                sharedMailBytes: 7,
            },
        ]);
        const data = await loadStatistics(
            "viewer",
            scope,
            "America/New_York",
            at,
        );
        expect(data.measuredFrom).toBe("2026-10-24");
        const expected =
            scope === "mine"
                ? [100, 150, 10, 15]
                : scope === "organization"
                  ? [50, 75, 5, 7]
                  : [300, 400, 30, 40];
        expect(data.daily[metricIndex.audioBytes].slice(362)).toEqual([
            expected[0],
            expected[0],
            expected[1],
        ]);
        expect(data.daily[metricIndex.mailBytes].slice(362)).toEqual([
            expected[2],
            expected[2],
            expected[3],
        ]);
        expect(data.daily[metricIndex.audioBytes][361]).toBe(
            scope === "organization" ? 0 : 1000,
        );
    });
    it("claims one instance-wide snapshot aggregation per UTC day without creating jobs", async () => {
        const results = await Promise.all([
            writeStorageSnapshots(at),
            writeStorageSnapshots(at),
        ]);
        expect(results.sort()).toEqual([0, 3]);
        await database.db
            .update(recordings)
            .set({ filesize: 5000 })
            .where(sql`${recordings.id} = 'own'`);
        expect(
            await writeStorageSnapshots(new Date("2026-10-26T13:00:00Z")),
        ).toBe(0);
        expect(
            await writeStorageSnapshots(
                new Date("2026-10-27T01:59:59.999+02:00"),
            ),
        ).toBe(0);
        expect(
            await writeStorageSnapshots(new Date("2026-10-27T00:00:00Z")),
        ).toBe(3);
        expect(
            await database.db
                .select({
                    day: storageDailySnapshots.day,
                    audioBytes: storageDailySnapshots.audioBytes,
                })
                .from(storageDailySnapshots)
                .where(sql`${storageDailySnapshots.userId} = 'viewer'`)
                .orderBy(storageDailySnapshots.day),
        ).toEqual([
            { day: "2026-10-26", audioBytes: 1000 },
            { day: "2026-10-27", audioBytes: 5000 },
        ]);
        expect(await database.db.select().from(asyncJobs)).toEqual([]);
    });
    it("rolls back failed daily measurements and retries on the same UTC day without creating jobs", async () => {
        expect(await writeStorageSnapshots(at)).toBe(3);
        const previous = await database.db.select().from(storageDailySnapshots);
        await database.sql`create function reject_snapshot() returns trigger language plpgsql as $$ begin if new.user_id = 'viewer' then raise exception 'synthetic snapshot failure'; end if; return new; end $$`;
        await database.sql`create trigger reject_snapshot before insert or update on storage_daily_snapshots for each row execute function reject_snapshot()`;
        const next = new Date("2026-10-27T00:00:00Z");
        try {
            await expect(writeStorageSnapshots(next)).rejects.toMatchObject({
                cause: { message: "synthetic snapshot failure" },
            });
            expect(
                await database.db.select().from(storageDailySnapshots),
            ).toEqual(previous);
            expect(await database.db.select().from(asyncJobs)).toEqual([]);
        } finally {
            await database.sql`drop trigger reject_snapshot on storage_daily_snapshots`;
            await database.sql`drop function reject_snapshot()`;
        }
        expect(await writeStorageSnapshots(next)).toBe(3);
        expect(await writeStorageSnapshots(next)).toBe(0);
        expect(
            await database.db
                .select()
                .from(storageDailySnapshots)
                .where(sql`${storageDailySnapshots.day} = '2026-10-27'`),
        ).toHaveLength(3);
        expect(await database.db.select().from(asyncJobs)).toEqual([]);
    });
    it("skips a UTC day when any snapshot row already exists", async () => {
        await database.db.insert(storageDailySnapshots).values({
            userId: "viewer",
            day: "2026-10-26",
            audioBytes: 123,
            mailBytes: 45,
            sharedAudioBytes: 0,
            sharedMailBytes: 0,
        });
        const previous = await database.db.select().from(storageDailySnapshots);
        expect(await writeStorageSnapshots(at)).toBe(0);
        expect(await database.db.select().from(storageDailySnapshots)).toEqual(
            previous,
        );
        expect(await database.db.select().from(asyncJobs)).toEqual([]);
    });
    it.each([
        "organization",
        "everyone",
    ] as const)("carries %s storage forward and counts a later account from its first snapshot only", async (scope) => {
        expect(await writeStorageSnapshots(at)).toBe(3);
        const later = new Date("2026-10-26T13:00:00Z");
        await database.db.insert(users).values({
            id: "late-member",
            name: "New member",
            email: "late-member@example.test",
            createdAt: later,
        });
        await recording("late-audio", "late-member", 1, true, later);
        expect(await writeStorageSnapshots(later)).toBe(0);
        expect(
            await database.db
                .select()
                .from(storageDailySnapshots)
                .where(sql`${storageDailySnapshots.userId} = 'late-member'`),
        ).toEqual([]);
        const initial = scope === "everyone" ? 3000 : 1000;
        const sameDay = await loadStatistics("viewer", scope, "UTC", later);
        expect(sameDay.daily[metricIndex.audioBytes][364]).toBe(initial);
        const next = new Date("2026-10-27T00:00:00Z");
        expect(await writeStorageSnapshots(next)).toBe(4);
        const data = await loadStatistics(
            "viewer",
            scope,
            "UTC",
            new Date("2026-10-28T12:00:00Z"),
        );
        expect(data.daily[metricIndex.audioBytes].slice(362)).toEqual([
            initial,
            initial + 1000,
            initial + 1000,
        ]);
    });
    it.each([
        "mine",
        "organization",
        "everyone",
    ] as const)("bounds five years of %s snapshots and carries each user's latest value", async (scope) => {
        const history = Array.from({ length: 5 * 365 }, (_, i) => ({
            userId: "viewer",
            day: new Date(Date.UTC(2020, 9, 27 + i)).toISOString().slice(0, 10),
            audioBytes: 100,
            mailBytes: 10,
            sharedAudioBytes: 50,
            sharedMailBytes: 5,
        }));
        await database.db.insert(storageDailySnapshots).values([
            ...history,
            {
                userId: "member",
                day: "2025-10-25",
                audioBytes: 200,
                mailBytes: 20,
                sharedAudioBytes: 75,
                sharedMailBytes: 7,
            },
            {
                userId: "viewer",
                day: "2026-10-25",
                audioBytes: 150,
                mailBytes: 15,
                sharedAudioBytes: 60,
                sharedMailBytes: 6,
            },
            {
                userId: "member",
                day: "2026-10-26",
                audioBytes: 250,
                mailBytes: 25,
                sharedAudioBytes: 90,
                sharedMailBytes: 9,
            },
        ]);
        const data = await loadStatistics("viewer", scope, "UTC", at);
        const snapshotQuery = (statements as SQL[]).find((statement) => {
            const query = new PgDialect().sqlToQuery(statement).sql;
            return (
                query.includes('"storage_daily_snapshots"') &&
                !/min\(/i.test(query)
            );
        });
        expect(snapshotQuery).toBeDefined();
        const rows = await database.db.execute(snapshotQuery as SQL);
        expect(rows.length).toBeLessThanOrEqual(366);
        expect(data.measuredFrom).toBe("2020-10-27");
        const expected =
            scope === "mine"
                ? [100, 150, 150, 10, 15, 15]
                : scope === "organization"
                  ? [125, 135, 150, 12, 13, 15]
                  : [300, 350, 400, 30, 35, 40];
        expect(data.baseline[metricIndex.audioBytes]).toBe(expected[0]);
        expect(data.daily[metricIndex.audioBytes][0]).toBe(expected[0]);
        expect(data.daily[metricIndex.audioBytes].slice(363)).toEqual(
            expected.slice(1, 3),
        );
        expect(data.baseline[metricIndex.mailBytes]).toBe(expected[3]);
        expect(data.daily[metricIndex.mailBytes].slice(363)).toEqual(
            expected.slice(4),
        );
    });
    it("uses an earlier measurement as the displayed range's baseline", async () => {
        await database.db.insert(storageDailySnapshots).values({
            userId: "viewer",
            day: "2025-01-01",
            audioBytes: 1234,
            mailBytes: 567,
            sharedAudioBytes: 0,
            sharedMailBytes: 0,
        });
        const data = await loadStatistics("viewer", "mine", "UTC", at);
        expect(data.measuredFrom).toBe("2025-01-01");
        expect(data.baseline[metricIndex.audioBytes]).toBe(1234);
        expect(data.baseline[metricIndex.mailBytes]).toBe(567);
        expect(data.daily[metricIndex.audioBytes][0]).toBe(1234);
        expect(data.daily[metricIndex.audioBytes][364]).toBe(1234);
    });
    it("uses logged resolutions across reopening, counts accepted drops and excludes dismissed proposals", async () => {
        const rows = [
            { id: "reopened", status: "open" as const, acceptedAt: earlier },
            {
                id: "legacy-reopened",
                status: "open" as const,
                acceptedAt: earlier,
            },
            {
                id: "accepted-drop",
                status: "dropped" as const,
                acceptedAt: earlier,
            },
            { id: "dismissed", status: "dropped" as const, acceptedAt: null },
            { id: "legacy-done", status: "done" as const, acceptedAt: earlier },
            {
                id: "legacy-drop",
                status: "dropped" as const,
                acceptedAt: earlier,
            },
            {
                id: "legacy-dismissed",
                status: "dropped" as const,
                acceptedAt: null,
            },
        ];
        await database.db.insert(recordingTasks).values(
            rows.map((row) => ({
                ...row,
                userId: "member",
                itemId: "shared-recording",
                source: "manual" as const,
                text: "Synthetic task",
                createdAt: earlier,
                statusChangedAt: at,
                statusChangedByUserId: "member",
            })),
        );
        await database.db.insert(taskStatusTransitions).values([
            {
                id: "z-done",
                taskId: "legacy-reopened",
                fromStatus: "open",
                toStatus: "done",
                actorUserId: "member",
                createdAt: at,
            },
            {
                id: "a-reopen",
                taskId: "legacy-reopened",
                fromStatus: "done",
                toStatus: "open",
                actorUserId: "member",
                createdAt: at,
            },

            {
                taskId: "reopened",
                fromStatus: null,
                toStatus: "open",
                actorUserId: "member",
                createdAt: earlier,
            },
            {
                taskId: "reopened",
                fromStatus: "open",
                toStatus: "done",
                actorUserId: "viewer",
                createdAt: new Date("2026-10-25T12:00:00Z"),
            },
            {
                taskId: "reopened",
                fromStatus: "done",
                toStatus: "open",
                actorUserId: "member",
                createdAt: at,
            },
            {
                taskId: "accepted-drop",
                fromStatus: "open",
                toStatus: "dropped",
                actorUserId: "viewer",
                createdAt: at,
            },
            {
                taskId: "dismissed",
                fromStatus: null,
                toStatus: "proposed",
                actorUserId: "member",
                createdAt: earlier,
            },
            {
                taskId: "dismissed",
                fromStatus: "proposed",
                toStatus: "dropped",
                actorUserId: "member",
                createdAt: at,
            },
        ]);
        const data = await loadStatistics("viewer", "organization", "UTC", at);
        expect(total(data, "tasksDone")).toBe(3);
        expect(total(data, "tasksDropped")).toBe(2);
        expect(data.daily[metricIndex.openTasks][364]).toBe(2);
        expect(
            unpackRanking(data.ranking)
                .filter((row) => data.members[row[1]][1])
                .reduce((n, row) => n + row[4], 0),
        ).toBe(1);
        expect(
            total(
                await loadStatistics("viewer", "mine", "UTC", at),
                "tasksDone",
            ),
        ).toBe(0);
    });
    it("counts promoted live records and linked aliases once in Everyone", async () => {
        await database.db.insert(knowledgeEntities).values([
            {
                id: "original-entity",
                userId: "viewer",
                typeKey: "term",
                name: "Merge tombstone",
                nameHmac: "old",
                mergedIntoId: "org-entity",
                createdAt: earlier,
            },
            {
                id: "org-entity",
                userId: "org",
                typeKey: "term",
                name: "Term",
                nameHmac: "term",
                createdAt: earlier,
            },
            {
                id: "independent",
                userId: "viewer",
                typeKey: "term",
                name: "Independent",
                nameHmac: "independent",
                createdAt: earlier,
            },
        ]);
        await database.db.insert(knowledgeAliases).values([
            {
                userId: "viewer",
                entityId: "org-entity",
                kind: "alias",
                text: "Alias",
                textHmac: "same",
                createdAt: earlier,
            },
            {
                userId: "org",
                entityId: "org-entity",
                kind: "alias",
                text: "Alias",
                textHmac: "same",
                createdAt: at,
            },
            {
                userId: "viewer",
                entityId: "independent",
                kind: "alias",
                text: "Alias",
                textHmac: "same",
                createdAt: at,
            },
        ]);
        const everyone = await loadStatistics("viewer", "everyone", "UTC", at);
        expect(everyone.daily[metricIndex.terms][364]).toBe(2);
        expect(everyone.daily[metricIndex.aliases][364]).toBe(2);
        expect(everyone.daily[metricIndex.aliases][0]).toBe(1);
        expect(
            (await loadStatistics("viewer", "organization", "UTC", at)).daily[
                metricIndex.aliases
            ][364],
        ).toBe(1);
        expect(
            (await loadStatistics("viewer", "mine", "UTC", at)).daily[
                metricIndex.aliases
            ][364],
        ).toBe(2);
    });
    it("uses existing indexes for selective scopes and emits a compact 50-member year", async () => {
        const members = Array.from({ length: 48 }, (_, i) => ({
            id: `seed-${i}`,
            name: `Member ${i}`,
            email: `seed-${i}@example.test`,
        }));
        await database.db.insert(users).values(members);
        const rows = members.flatMap((member, m) =>
            Array.from({ length: 52 }, (_, week) => {
                const createdAt = new Date(
                    at.getTime() - week * 7 * 86_400_000,
                );
                return {
                    id: `seed-${m}-${week}`,
                    userId: member.id,
                    filename: "Synthetic recording",
                    deviceSn: "recorder",
                    plaudFileId: `seed-${m}-${week}`,
                    duration: 30 * 60_000,
                    startTime: createdAt,
                    endTime: new Date(createdAt.getTime() + 30 * 60_000),
                    filesize: 1000,
                    fileMd5: "a".repeat(32),
                    storageType: "local",
                    storagePath: "test/audio.opus",
                    plaudVersion: "1",
                    createdAt,
                };
            }),
        );
        await insertRecordings(database.db, rows);
        await database.db.insert(recordingFolderAssignments).values(
            rows.map((row) => ({
                userId: row.userId,
                itemId: row.id,
                folderId: "shared",
            })),
        );
        await database.db.insert(aiUsageEvents).values(
            rows.map((row) => ({
                itemId: row.id,
                userId: row.userId,
                actorUserId: row.userId,
                payerUserId: "org",
                costUsd: "0.125",
                operation: "summary",
                provider: "Example",
                model: "model",
                createdAt: row.createdAt,
            })),
        );
        const data = await loadStatistics("viewer", "organization", "UTC", at);
        const size = Buffer.byteLength(JSON.stringify(data));
        process.stdout.write(
            `Statistics payload: ${size} bytes, ${data.members.length} members, ${rows.length + 3} recordings, 365 days\n`,
        );
        expect(size).toBeLessThan(200_000);
        statements.length = 0;
        await loadStatistics("viewer", "mine", "UTC", at);
        const queries = [...statements] as SQL[];
        const plans: string[] = [];
        await database.db.transaction(async (tx) => {
            await tx.execute(sql`set local enable_seqscan = off`);
            for (const statement of queries) {
                const plan = await tx.execute(sql`explain ${statement}`);
                plans.push(
                    plan.map((row) => String(row["QUERY PLAN"])).join("\n"),
                );
            }
        });
        process.stdout.write(
            `Statistics EXPLAIN: ${plans.length} aggregate statements; index scans ${plans.filter((plan) => /Index|Bitmap/.test(plan)).length}\n`,
        );
        expect(plans).toHaveLength(10);
        expect(plans[0]).toMatch(/Index|Bitmap/);
        expect(plans[3]).toMatch(/ai_usage_events_(?:recording_)?payer/);
    }, 30_000);
});
