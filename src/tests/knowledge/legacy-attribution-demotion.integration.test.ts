/**
 * Speaker names an older release copied from Plaud's transcript onto the
 * user's own were stored as confirmed. Decision D1 (a) turns them back
 * into suggestions once, recognized by the missing confirmer and the same
 * person named on the Plaud transcript.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { eq } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import {
    people,
    recordings,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
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
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

import { encryptText } from "@/lib/encryption/fields";
import { demoteCopiedAttributions } from "@/lib/knowledge/legacy-attribution-demotion";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const REC = "rec-meeting";

describeWithDatabase("demoting copied speaker names (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let jana = "";
    let petr = "";
    let plaud = "";
    let own = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "attribution_demotion",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db().insert(users).values({ id: ALICE, email: "a@x.test" });
        await db()
            .insert(recordings)
            .values({
                id: REC,
                userId: ALICE,
                deviceSn: "SN-1",
                plaudFileId: "plaud-1",
                filename: encryptText("Weekly"),
                duration: 60_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:01:00Z"),
                filesize: 11,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${ALICE}/rec.mp3`,
                plaudVersion: "1",
            });
        const inserted = await db()
            .insert(people)
            .values([
                { userId: ALICE, displayName: encryptText("Jana") },
                { userId: ALICE, displayName: encryptText("Petr") },
            ])
            .returning({ id: people.id });
        jana = inserted[0]?.id ?? "";
        petr = inserted[1]?.id ?? "";
        const transcripts = await db()
            .insert(transcriptions)
            .values(
                (["plaud", "riffado"] as const).map((source) => ({
                    recordingId: REC,
                    userId: ALICE,
                    text: encryptText("speaker_0: Hi\nspeaker_1: Hello"),
                    provider: source,
                    model: "plaud",
                    source,
                })),
            )
            .returning({ id: transcriptions.id });
        plaud = transcripts[0]?.id ?? "";
        own = transcripts[1]?.id ?? "";
    });

    async function row(
        transcriptionId: string,
        label: string,
        personId: string,
        confirmedByUserId: string | null = null,
    ) {
        await db().insert(transcriptSpeakers).values({
            userId: ALICE,
            transcriptionId,
            label,
            personId,
            source: "user",
            status: "confirmed",
            confirmedByUserId,
        });
    }

    async function statusOf(transcriptionId: string) {
        const rows = await db()
            .select({
                label: transcriptSpeakers.label,
                status: transcriptSpeakers.status,
                source: transcriptSpeakers.source,
            })
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.transcriptionId, transcriptionId));
        return rows.sort((a, b) => a.label.localeCompare(b.label));
    }

    it("demotes a name the copy stored as confirmed", async () => {
        await row(plaud, "Speaker 1", jana);
        await row(own, "speaker_0", jana);

        expect(await demoteCopiedAttributions()).toBe(1);
        expect(await statusOf(own)).toEqual([
            { label: "speaker_0", status: "suggested", source: "heuristic" },
        ]);
        // The Plaud transcript's own names are the source, not a copy.
        expect(await statusOf(plaud)).toEqual([
            { label: "Speaker 1", status: "confirmed", source: "user" },
        ]);
    });

    it("keeps a name only the Riffado transcript has", async () => {
        await row(plaud, "Speaker 1", jana);
        await row(own, "speaker_1", petr);

        expect(await demoteCopiedAttributions()).toBe(0);
        expect(await statusOf(own)).toEqual([
            { label: "speaker_1", status: "confirmed", source: "user" },
        ]);
    });

    it("leaves a name a person accepted again on later runs", async () => {
        await row(plaud, "Speaker 1", jana);
        await row(own, "speaker_0", jana);
        await demoteCopiedAttributions();
        await db()
            .update(transcriptSpeakers)
            .set({
                status: "confirmed",
                source: "user",
                confirmedByUserId: ALICE,
            })
            .where(eq(transcriptSpeakers.transcriptionId, own));

        expect(await demoteCopiedAttributions()).toBe(0);
        expect(await statusOf(own)).toEqual([
            { label: "speaker_0", status: "confirmed", source: "user" },
        ]);
    });
});
