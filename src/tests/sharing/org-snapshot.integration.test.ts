/**
 * The Organization's snapshot of a shared recording, against a real
 * PostgreSQL: what it copies, that it is taken once, and that it leaves the
 * Organization's own rows alone.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { and, eq } from "drizzle-orm";
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
    aiEnhancements,
    people,
    recordingFolderAssignments,
    recordingFolders,
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

import { db as appDb } from "@/db";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { unshareRecording } from "@/lib/folders/folders";
import { lockOrgPeople } from "@/lib/knowledge/people";
import { ensureOrgAccount } from "@/lib/org/account";
import { snapshotRecordingForOrgInTx } from "@/lib/sharing/org-transcript";
import {
    effectiveViewReader,
    findOrgSummarySource,
    ownerRowsShownInOrgView,
    readOrgViewSummaryRecordingIds,
    readOrgViewSummaryRows,
    readOrgViewTranscriptRows,
} from "@/lib/sharing/view-content";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const REC = "rec-snapshot";
const MODEL = "scribe_v2+diarize";

function turn(speaker: string, startMs: number, endMs: number, text: string) {
    return { speaker, startMs, endMs, text };
}

const TURNS = [
    turn("speaker_0", 0, 10_000, "I am Jana."),
    turn("speaker_1", 10_000, 20_000, "I am Petr."),
    turn("speaker_2", 20_000, 30_000, "Hello."),
];

describeWithDatabase("the Organization snapshot (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    const owners = () => ({ ownerUserId: OWNER, contentUserId: orgUserId });

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "org_snapshot",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values([{ id: OWNER, email: "owner@example.test" }]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        await db()
            .insert(recordings)
            .values({
                id: REC,
                userId: OWNER,
                deviceSn: "SN-1",
                plaudFileId: "plaud-1",
                filename: encryptText("Weekly"),
                duration: 60_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:01:00Z"),
                filesize: 11,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${OWNER}/rec.mp3`,
                plaudVersion: "1",
            });
    });

    async function share() {
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await db()
            .insert(recordingFolderAssignments)
            .values({
                userId: OWNER,
                recordingId: REC,
                folderId: root?.id ?? "",
            });
    }

    async function transcript(
        userId: string,
        source: string,
        revision = 0,
    ): Promise<string> {
        const [row] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId,
                text: encryptText(
                    TURNS.map((t) => `${t.speaker}: ${t.text}`).join("\n"),
                ),
                turns: encryptJsonField(TURNS),
                provider: "elevenlabs",
                model: MODEL,
                source,
                revision,
            })
            .returning({ id: transcriptions.id });
        return row?.id ?? "";
    }

    async function summary(
        userId: string,
        source: string,
        transcriptionId: string | null,
    ) {
        await db()
            .insert(aiEnhancements)
            .values({
                recordingId: REC,
                userId,
                transcriptionId,
                summary: encryptText(`${source} summary`),
                provider: "openai",
                model: "gpt",
                source,
            });
    }

    async function snapshot() {
        return appDb.transaction(async (tx) => {
            await lockOrgPeople(tx);
            return snapshotRecordingForOrgInTx(tx, REC, owners(), OWNER);
        });
    }

    async function marker() {
        const [row] = await db()
            .select({ orgSnapshotAt: recordings.orgSnapshotAt })
            .from(recordings)
            .where(eq(recordings.id, REC));
        return row?.orgSnapshotAt ?? null;
    }

    async function orgTranscripts() {
        return db()
            .select()
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, REC),
                    eq(transcriptions.userId, orgUserId),
                ),
            );
    }

    async function orgSummaries() {
        return db()
            .select()
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.recordingId, REC),
                    eq(aiEnhancements.userId, orgUserId),
                ),
            );
    }

    it("copies every transcript with its confirmed names, the summaries made from them, and marks the recording", async () => {
        const riffado = await transcript(OWNER, "riffado", 3);
        const plaud = await transcript(OWNER, "plaud");
        const [jana] = await db()
            .insert(people)
            .values({ userId: OWNER, displayName: encryptText("Jana") })
            .returning({ id: people.id });
        await db()
            .insert(transcriptSpeakers)
            .values([
                {
                    userId: OWNER,
                    transcriptionId: riffado,
                    label: "speaker_0",
                    personId: jana?.id,
                    source: "user",
                    status: "confirmed",
                    confirmedByUserId: OWNER,
                },
                {
                    userId: OWNER,
                    transcriptionId: riffado,
                    label: "speaker_1",
                    source: "user",
                    status: "confirmed",
                    markedUnknown: true,
                    confirmedByUserId: OWNER,
                },
                {
                    userId: OWNER,
                    transcriptionId: riffado,
                    label: "speaker_2",
                    personId: jana?.id,
                    source: "heuristic",
                    status: "suggested",
                },
            ]);
        await summary(OWNER, "riffado", riffado);
        await summary(OWNER, "plaud", null);
        await share();

        const copies = (await snapshot()) ?? new Map();

        expect([...copies.keys()].sort()).toEqual([plaud, riffado].sort());
        const copied = await orgTranscripts();
        expect(copied.map((row) => row.source).sort()).toEqual([
            "plaud",
            "riffado",
        ]);
        const riffadoCopy = copied.find((row) => row.source === "riffado");
        expect(riffadoCopy?.revision).toBe(3);
        expect(riffadoCopy?.producedByUserId).toBe(OWNER);

        const names = await db()
            .select()
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.userId, orgUserId));
        // Confirmed answers travel, the owner's suggestion does not.
        expect(
            names
                .map((row) => ({
                    transcriptionId: row.transcriptionId,
                    label: row.label,
                    personId: row.personId,
                    markedUnknown: row.markedUnknown,
                    confirmedByUserId: row.confirmedByUserId,
                }))
                .sort((a, b) => a.label.localeCompare(b.label)),
        ).toEqual([
            {
                transcriptionId: riffadoCopy?.id,
                label: "speaker_0",
                personId: jana?.id,
                markedUnknown: false,
                confirmedByUserId: OWNER,
            },
            {
                transcriptionId: riffadoCopy?.id,
                label: "speaker_1",
                personId: null,
                markedUnknown: true,
                confirmedByUserId: OWNER,
            },
        ]);
        // Jana is promoted: the same row, now the Organization's.
        const [promoted] = await db()
            .select({ userId: people.userId })
            .from(people)
            .where(eq(people.id, jana?.id ?? ""));
        expect(promoted?.userId).toBe(orgUserId);

        const summaries = await orgSummaries();
        expect(
            summaries
                .map((row) => ({
                    source: row.source,
                    transcriptionId: row.transcriptionId,
                }))
                .sort((a, b) => a.source.localeCompare(b.source)),
        ).toEqual([
            { source: "plaud", transcriptionId: null },
            { source: "riffado", transcriptionId: riffadoCopy?.id },
        ]);
        expect(await marker()).not.toBeNull();
    });

    it("is taken once: rows removed afterwards are not copied back", async () => {
        await transcript(OWNER, "riffado");
        await share();
        expect((await snapshot())?.size).toBe(1);

        // Organization retention removes its copy.
        await db()
            .delete(transcriptions)
            .where(eq(transcriptions.userId, orgUserId));

        expect(await snapshot()).toBeNull();
        expect(await orgTranscripts()).toEqual([]);
    });

    it("leaves the Organization's own rows alone, and a summary of text it did not copy", async () => {
        const ownerRiffado = await transcript(OWNER, "riffado");
        await transcript(OWNER, "plaud");
        const orgRiffado = await transcript(orgUserId, "riffado", 7);
        await summary(OWNER, "riffado", ownerRiffado);
        await share();

        const copies = (await snapshot()) ?? new Map();

        expect([...copies.values()].map((row) => row.source)).toEqual([
            "plaud",
        ]);
        const own = (await orgTranscripts()).find(
            (row) => row.source === "riffado",
        );
        expect(own?.id).toBe(orgRiffado);
        expect(own?.revision).toBe(7);
        expect(await orgSummaries()).toEqual([]);
    });

    it("does nothing for a recording that is not shared, or deleted", async () => {
        await transcript(OWNER, "riffado");

        expect(await snapshot()).toBeNull();
        expect(await marker()).toBeNull();

        await share();
        await db()
            .update(recordings)
            .set({ deletedAt: new Date() })
            .where(eq(recordings.id, REC));
        expect(await snapshot()).toBeNull();
        expect(await orgTranscripts()).toEqual([]);
    });

    it("is taken afresh after an unshare", async () => {
        await transcript(OWNER, "riffado");
        await share();
        await snapshot();

        await unshareRecording(OWNER, REC);
        expect(await marker()).toBeNull();
        expect(await orgTranscripts()).toEqual([]);

        await share();
        expect((await snapshot())?.size).toBe(1);
        expect(await orgTranscripts()).toHaveLength(1);
    });

    describe("the Organization view", () => {
        const ref = async () => {
            const [row] = await db()
                .select({ orgSnapshotAt: recordings.orgSnapshotAt })
                .from(recordings)
                .where(eq(recordings.id, REC));
            return {
                id: REC,
                ownerUserId: OWNER,
                orgSnapshotAt: row?.orgSnapshotAt ?? null,
            };
        };

        it("shows the owner's rows only until the snapshot", async () => {
            const riffado = await transcript(OWNER, "riffado");
            await summary(OWNER, "riffado", riffado);
            await share();

            // Shared before snapshots existed: the owner's rows, read-only.
            const before = await readOrgViewTranscriptRows(
                [await ref()],
                orgUserId,
            );
            expect(before.rows.map((row) => row.userId)).toEqual([OWNER]);
            expect(
                await effectiveViewReader(REC, owners(), "transcript"),
            ).toEqual({ userId: OWNER, fallback: true });

            await snapshot();
            // Organization retention removes its copies.
            await db()
                .delete(aiEnhancements)
                .where(eq(aiEnhancements.userId, orgUserId));
            await db()
                .delete(transcriptions)
                .where(eq(transcriptions.userId, orgUserId));

            // What its retention removed stays removed.
            const after = await readOrgViewTranscriptRows(
                [await ref()],
                orgUserId,
            );
            expect(after.rows).toEqual([]);
            expect(
                await readOrgViewSummaryRecordingIds([await ref()], orgUserId),
            ).toEqual(new Set());
            expect(
                await readOrgViewSummaryRows([await ref()], orgUserId),
            ).toEqual([]);
            for (const kind of ["transcript", "summary"] as const) {
                expect(await effectiveViewReader(REC, owners(), kind)).toEqual({
                    userId: orgUserId,
                    fallback: false,
                });
            }
            expect(await findOrgSummarySource(REC, owners())).toBeUndefined();
            expect(await ownerRowsShownInOrgView(REC)).toBe(false);
        });

        it("never shows a summary the owner made after the share", async () => {
            await transcript(OWNER, "riffado");
            await share();
            await snapshot();

            await summary(OWNER, "riffado", null);

            expect(
                await readOrgViewSummaryRecordingIds([await ref()], orgUserId),
            ).toEqual(new Set());
            expect(await effectiveViewReader(REC, owners(), "summary")).toEqual(
                { userId: orgUserId, fallback: false },
            );
        });

        it("summarizes the Organization's own copy of any source before the owner's", async () => {
            await transcript(OWNER, "plaud");
            await share();
            const copies = (await snapshot()) ?? new Map();
            const plaudCopy = [...copies.values()][0];

            expect((await findOrgSummarySource(REC, owners()))?.id).toBe(
                plaudCopy?.id,
            );
        });
    });
});
