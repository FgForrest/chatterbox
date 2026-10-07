/**
 * Names and titles an MCP caller may resolve, against a real PostgreSQL:
 * only people, things and recordings the caller may see; without
 * `knowledge:read`, only people it already meets in its recordings and
 * tasks, never things; ambiguity lists a few visible candidates.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, allowScan } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const proxy = new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                const current = ref.current;
                if (!current) {
                    throw new Error("test database was not initialized");
                }
                const value = current[property];
                return typeof value === "function"
                    ? value.bind(current)
                    : value;
            },
        },
    );
    return {
        dbProxy: proxy,
        dbRef: ref,
        allowScan: vi.fn(async () => true),
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            KNOWLEDGE_MEMORY_MB: 64,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/mcp/rate-limit", () => ({ allowMcpScan: allowScan }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import { createEntity } from "@/lib/knowledge/entities";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import type { McpCaller } from "@/lib/mcp/caller";
import { McpToolError } from "@/lib/mcp/errors";
import { resolveRecording, resolveTarget } from "@/lib/mcp/resolve";
import type { McpRole } from "@/lib/mcp/roles";
import { ensureOrgAccount } from "@/lib/org/account";
import {
    attributeSpeaker,
    insertPerson,
    insertRecording,
    insertTask,
    insertTranscript,
    serviceCaller,
    shareRecording,
    userCaller,
} from "@/tests/mcp/fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

interface Failure {
    message: string;
    outcome: string;
    candidates: { id: string; name: string; type: string }[];
}

async function failure(promise: Promise<unknown>): Promise<Failure> {
    const caught = await promise.then(
        () => null,
        (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(McpToolError);
    const error = caught as McpToolError;
    const details = error.details as
        | { candidates?: Failure["candidates"] }
        | undefined;
    return {
        message: error.message,
        outcome: error.outcome,
        candidates: details?.candidates ?? [],
    };
}

describeWithDatabase("MCP name resolution (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    const ids: Record<string, string> = {};

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    const alice = (roles: McpRole[]) =>
        userCaller(ALICE, "alice@example.test", roles, orgUserId);
    const service = (roles: McpRole[]) => serviceCaller(orgUserId, roles);

    async function personId(
        caller: McpCaller,
        input: string,
        kinds: ("person" | "entity")[] = ["person"],
    ): Promise<string> {
        return (await resolveTarget(caller, input, kinds)).id;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_resolve",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;

        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        if (!orgUserId) throw new Error("organization account missing");
        await seedCoreVocabulary();

        await insertRecording(db(), {
            id: "r1",
            userId: ALICE,
            title: "Pricing call",
            startTime: new Date("2026-09-05T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r2",
            userId: BOB,
            title: "Pricing secret",
            startTime: new Date("2026-09-04T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r3",
            userId: BOB,
            title: "Weekly sync Brno",
            startTime: new Date("2026-09-03T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r4",
            userId: ALICE,
            title: "Schůzka o rozpočtu",
            startTime: new Date("2026-09-02T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r5",
            userId: ALICE,
            title: "Deleted pricing",
            deletedAt: new Date("2026-09-06T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r6",
            userId: ALICE,
            title: "Standup",
            startTime: new Date("2026-08-01T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r7",
            userId: ALICE,
            title: "standup",
            startTime: new Date("2026-08-02T10:00:00Z"),
        });
        await shareRecording(db(), "r3", orgUserId);

        ids.orgJan = await insertPerson(db(), orgUserId, "Jan Novotný");
        ids.orgEva = await insertPerson(db(), orgUserId, "Eva Dvořáková");
        ids.orgTomas = await insertPerson(db(), orgUserId, "Tomáš Veselý");
        ids.orgOlga = await insertPerson(db(), orgUserId, "Olga Černá");
        ids.orgAliceSelf = await insertPerson(
            db(),
            orgUserId,
            "Alice Example",
            {
                emailHash: lookupHash("alice@example.test"),
            },
        );
        ids.alicePetra = await insertPerson(db(), ALICE, "Petra Malá");
        ids.bobKarel = await insertPerson(db(), BOB, "Karel Bobek");
        ids.aliceMartin = await insertPerson(db(), ALICE, "Martin Král");
        ids.orgMartin = await insertPerson(db(), orgUserId, "Martin Kral");
        ids.bobMartin = await insertPerson(db(), BOB, "Martin Král");
        for (const letter of ["A", "B", "C", "D", "E", "F"]) {
            ids[`martin${letter}`] = await insertPerson(
                db(),
                orgUserId,
                `Martin ${letter}${letter}${letter}`,
            );
        }
        ids.orion = (
            await createEntity(ALICE, { typeKey: "project", name: "Orion" })
        ).id;
        ids.atlas = (
            await createEntity(orgUserId, { typeKey: "project", name: "Atlas" })
        ).id;

        const t1 = await insertTranscript(db(), "r1", ALICE);
        const t2 = await insertTranscript(db(), "r2", BOB);
        const t3 = await insertTranscript(db(), "r3", BOB);
        await attributeSpeaker(db(), {
            userId: ALICE,
            transcriptionId: t1,
            label: "speaker_0",
            personId: ids.alicePetra,
        });
        await attributeSpeaker(db(), {
            userId: ALICE,
            transcriptionId: t1,
            label: "speaker_1",
            personId: ids.orgEva,
            status: "suggested",
        });
        await attributeSpeaker(db(), {
            userId: BOB,
            transcriptionId: t2,
            label: "speaker_0",
            personId: ids.bobKarel,
        });
        await attributeSpeaker(db(), {
            userId: BOB,
            transcriptionId: t3,
            label: "speaker_0",
            personId: ids.orgJan,
        });
        await attributeSpeaker(db(), {
            userId: BOB,
            transcriptionId: t3,
            label: "speaker_1",
            personId: ids.bobKarel,
        });

        await insertTask(db(), {
            recordingId: "r1",
            userId: ALICE,
            assigneePersonId: ids.orgOlga,
        });
        await insertTask(db(), {
            recordingId: "r3",
            userId: BOB,
            assigneePersonId: ids.orgTomas,
        });
        await insertTask(db(), {
            recordingId: "r3",
            userId: BOB,
            assigneePersonId: ids.orgAliceSelf,
        });
        await insertTask(db(), {
            recordingId: "r3",
            userId: BOB,
            assigneePersonId: ids.orgEva,
            status: "proposed",
        });
        knowledgeStore().invalidateAll();
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    describe("with knowledge:read", () => {
        const reader = () => alice(["knowledge:read"]);

        it("resolves a visible person by name or id", async () => {
            await expect(
                resolveTarget(reader(), "jan novotny", ["person"]),
            ).resolves.toEqual({
                id: ids.orgJan,
                name: "Jan Novotný",
                kind: "person",
                typeKey: "person",
                matchedBy: "exact",
            });
            await expect(
                resolveTarget(reader(), ids.orgEva ?? "", ["person"]),
            ).resolves.toMatchObject({ id: ids.orgEva, matchedBy: "id" });
            expect(await personId(reader(), "Orion", ["entity"])).toBe(
                ids.orion,
            );
        });

        it("keeps to the kinds asked for", async () => {
            expect(
                (await failure(resolveTarget(reader(), "Orion", ["person"])))
                    .outcome,
            ).toBe("not_found");
        });

        it("never resolves another user's private person", async () => {
            for (const input of [ids.bobKarel ?? "", "Karel Bobek"]) {
                expect(
                    await failure(resolveTarget(reader(), input, ["person"])),
                ).toMatchObject({ outcome: "not_found" });
            }
        });

        it("lists at most five visible candidates for an ambiguous name", async () => {
            const result = await failure(
                resolveTarget(reader(), "Martin", ["person"]),
            );
            expect(result.message).toBe("Ambiguous name");
            expect(result.outcome).toBe("invalid");
            expect(result.candidates).toHaveLength(5);
            expect(result.candidates.map((c) => c.id)).not.toContain(
                ids.bobMartin,
            );
            for (const candidate of result.candidates) {
                expect(candidate.type).toBe("person");
            }
        });

        it("calls two exact names ambiguous, without another user's", async () => {
            const result = await failure(
                resolveTarget(reader(), "Martin Král", ["person"]),
            );
            expect(result.candidates.map((c) => c.id).sort()).toEqual(
                [ids.aliceMartin, ids.orgMartin].sort(),
            );
        });

        it("gives a service caller the Organization's knowledge alone", async () => {
            const bot = service(["knowledge:read"]);
            expect(await personId(bot, "Jan Novotný")).toBe(ids.orgJan);
            expect(await personId(bot, "Atlas", ["entity"])).toBe(ids.atlas);
            for (const [input, kinds] of [
                [ids.alicePetra ?? "", ["person"]],
                ["Petra Malá", ["person"]],
                ["Orion", ["entity"]],
                [ids.orion ?? "", ["entity"]],
            ] as const) {
                expect(
                    await failure(resolveTarget(bot, input, [...kinds])),
                ).toMatchObject({ outcome: "not_found" });
            }
            expect(await personId(bot, "Martin Král")).toBe(ids.orgMartin);
        });
    });

    describe("without knowledge:read", () => {
        it("resolves people who spoke in the caller's recordings", async () => {
            const listener = alice(["transcripts:read"]);
            expect(await personId(listener, "Jan Novotný")).toBe(ids.orgJan);
            expect(await personId(listener, "Petra Malá")).toBe(ids.alicePetra);
            expect(await personId(listener, ids.orgJan ?? "")).toBe(ids.orgJan);
        });

        it("does not resolve someone known only to the Almanac", async () => {
            const listener = alice(["transcripts:read"]);
            for (const input of [
                "Eva Dvořáková",
                ids.orgEva ?? "",
                "Karel Bobek",
                "Tomáš Veselý",
                "Olga Černá",
            ]) {
                expect(
                    await failure(resolveTarget(listener, input, ["person"])),
                ).toMatchObject({ outcome: "not_found" });
            }
        });

        it("never resolves an entity", async () => {
            const listener = alice(["transcripts:read", "tasks:read"]);
            for (const input of ["Orion", ids.orion ?? "", "Atlas"]) {
                expect(
                    await failure(
                        resolveTarget(listener, input, ["person", "entity"]),
                    ),
                ).toMatchObject({ outcome: "not_found" });
            }
        });

        it("resolves assignees of the tasks the caller sees", async () => {
            const tasks = alice(["tasks:read"]);
            expect(await personId(tasks, "Olga Černá")).toBe(ids.orgOlga);
            expect(await personId(tasks, "Alice Example")).toBe(
                ids.orgAliceSelf,
            );
            expect(await personId(tasks, "Petra Malá")).toBe(ids.alicePetra);
            for (const input of ["Tomáš Veselý", "Eva Dvořáková"]) {
                expect(
                    await failure(resolveTarget(tasks, input, ["person"])),
                ).toMatchObject({ outcome: "not_found" });
            }
        });

        it("gives a service caller the Organization's speakers and tasks", async () => {
            const bot = service(["tasks:read"]);
            expect(await personId(bot, "Tomáš Veselý")).toBe(ids.orgTomas);
            expect(await personId(bot, "Jan Novotný")).toBe(ids.orgJan);
            for (const input of [
                "Olga Černá",
                "Petra Malá",
                "Karel Bobek",
                "Eva Dvořáková",
            ]) {
                expect(
                    await failure(resolveTarget(bot, input, ["person"])),
                ).toMatchObject({ outcome: "not_found" });
            }
        });

        it("lists only namable candidates for an ambiguous name", async () => {
            const result = await failure(
                resolveTarget(alice(["transcripts:read"]), "Martin", [
                    "person",
                ]),
            );
            expect(result.outcome).toBe("not_found");
            expect(result.candidates).toEqual([]);
        });
    });

    describe("recordings", () => {
        const reader = () => alice(["transcripts:read"]);

        it("resolves a readable recording by id, in its view", async () => {
            await expect(resolveRecording(reader(), "r1")).resolves.toEqual({
                id: "r1",
                ownerUserId: ALICE,
                title: "Pricing call",
                recordedAt: "2026-09-05T10:00:00.000Z",
                view: "private",
                matchedBy: "id",
            });
            await expect(
                resolveRecording(reader(), "r3"),
            ).resolves.toMatchObject({
                id: "r3",
                ownerUserId: BOB,
                view: "org",
            });
        });

        it("never resolves another user's private or a deleted recording", async () => {
            for (const input of [
                "r2",
                "r5",
                "Pricing secret",
                "Deleted pricing",
            ]) {
                expect(
                    await failure(resolveRecording(reader(), input)),
                ).toMatchObject({ outcome: "not_found" });
            }
        });

        it("resolves a title by its words or as a whole", async () => {
            await expect(
                resolveRecording(reader(), "pricing"),
            ).resolves.toMatchObject({ id: "r1", matchedBy: "words" });
            await expect(
                resolveRecording(reader(), "WEEKLY sync brno"),
            ).resolves.toMatchObject({ id: "r3", matchedBy: "exact" });
            await expect(
                resolveRecording(reader(), "schuzka rozpoctu"),
            ).resolves.toMatchObject({ id: "r4", matchedBy: "words" });
        });

        it("calls equal titles ambiguous", async () => {
            const result = await failure(resolveRecording(reader(), "Standup"));
            expect(result.message).toBe("Ambiguous name");
            expect(result.candidates).toEqual([
                { id: "r7", name: "standup", type: "recording" },
                { id: "r6", name: "Standup", type: "recording" },
            ]);
        });

        it("gives a service caller the shared recordings alone", async () => {
            const bot = service(["summaries:read"]);
            await expect(
                resolveRecording(bot, "weekly"),
            ).resolves.toMatchObject({ id: "r3", view: "org" });
            for (const input of ["r1", "pricing", "Standup"]) {
                expect(
                    await failure(resolveRecording(bot, input)),
                ).toMatchObject({ outcome: "not_found" });
            }
        });

        it("counts a title lookup as a search, never an id", async () => {
            allowScan.mockClear();
            await resolveRecording(reader(), "r1");
            await resolveRecording(reader(), "r3");
            expect(allowScan).not.toHaveBeenCalled();
            await resolveRecording(reader(), "pricing");
            expect(allowScan).toHaveBeenCalledTimes(1);
            allowScan.mockResolvedValueOnce(false);
            expect(
                await failure(resolveRecording(reader(), "pricing")),
            ).toMatchObject({
                message: "Too many searches; retry in a minute",
                outcome: "denied",
            });
            allowScan.mockResolvedValueOnce(false);
            expect(
                await failure(resolveRecording(reader(), "r2")),
            ).toMatchObject({ outcome: "denied" });
        });

        it("refuses an empty reference", async () => {
            expect(
                await failure(resolveRecording(reader(), "  ")),
            ).toMatchObject({ outcome: "invalid" });
        });
    });
});
