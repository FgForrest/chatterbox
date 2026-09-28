/**
 * What a person can answer about a speaker label, and what machine
 * suggestions may do around those answers, against a real PostgreSQL.
 *
 * - "Unknown" is an answer, confirmed by the person who gave it.
 * - Clearing takes an answer back and leaves the label open.
 * - Rejecting a suggestion is remembered per (label, person), so the same
 *   wrong name never returns, even after other suggestions came and went.
 * - A suggestion never overwrites anything.
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
    people,
    recordingFolders,
    recordings,
    transcriptions,
    transcriptSpeakerRejections,
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
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth-server", async () => {
    const { AppError, ErrorCode } =
        await vi.importActual<typeof import("@/lib/errors")>("@/lib/errors");
    return {
        requireApiSession: vi.fn(async (request: Request) => {
            const id = request.headers.get("x-test-user");
            if (!id) {
                throw new AppError(
                    ErrorCode.AUTH_SESSION_MISSING,
                    "Unauthorized",
                    401,
                );
            }
            return { user: { id, email: `${id}@example.test` } };
        }),
    };
});

import { PUT as putSpeakerRoute } from "@/app/api/recordings/[id]/speakers/route";
import { db as appDb } from "@/db";
import { encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder } from "@/lib/folders/folders";
import {
    insertSuggestionsInTx,
    rejectSuggestion,
    type SuggestedSpeaker,
    setTranscriptSpeaker,
} from "@/lib/knowledge/attribution";
import { mergePeople } from "@/lib/knowledge/people";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";
const REC = "rec-meeting";
const DIALOG = "speaker_0: Hello.\nspeaker_1: Hi there.";

type Handler = (
    request: Request,
    context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

function put(user: string, body: unknown, query = "") {
    return (putSpeakerRoute as unknown as Handler)(
        new Request(`http://localhost/api/recordings/${REC}/speakers${query}`, {
            method: "PUT",
            headers: {
                "content-type": "application/json",
                "x-test-user": user,
            },
            body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: REC }) },
    );
}

describeWithDatabase("speaker answers and suggestions (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let transcriptId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "speaker_answers",
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
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
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
        const [row] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: ALICE,
                text: encryptText(DIALOG),
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        transcriptId = row?.id ?? "";
    });

    async function person(userId: string, name: string): Promise<string> {
        const [row] = await db()
            .insert(people)
            .values({ userId, displayName: encryptText(name) })
            .returning({ id: people.id });
        return row?.id ?? "";
    }

    async function speakerRows() {
        return db()
            .select()
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.transcriptionId, transcriptId));
    }

    async function rejections() {
        return db()
            .select({
                label: transcriptSpeakerRejections.label,
                personId: transcriptSpeakerRejections.personId,
            })
            .from(transcriptSpeakerRejections)
            .where(
                eq(transcriptSpeakerRejections.transcriptionId, transcriptId),
            );
    }

    function suggest(rows: SuggestedSpeaker[]) {
        return appDb.transaction((tx) =>
            insertSuggestionsInTx(tx, {
                userId: ALICE,
                transcriptionId: transcriptId,
                rows,
            }),
        );
    }

    function suggestion(label: string, personId: string | null) {
        return { label, personId, source: "heuristic" as const };
    }

    describe("the speakers route", () => {
        it("stores unknown as a confirmed answer, with who gave it", async () => {
            const response = await put(ALICE, {
                label: "speaker_1",
                unknown: true,
            });
            expect(response.status).toBe(200);
            const [row] = await speakerRows();
            expect(row).toMatchObject({
                label: "speaker_1",
                personId: null,
                status: "confirmed",
                source: "user",
                markedUnknown: true,
                confirmedByUserId: ALICE,
            });
            const body = (await response.json()) as {
                speakers: { label: string; markedUnknown: boolean }[];
            };
            expect(body.speakers).toEqual([
                expect.objectContaining({
                    label: "speaker_1",
                    markedUnknown: true,
                }),
            ]);
        });

        it("records who named a speaker", async () => {
            const jana = await person(ALICE, "Jana");
            await put(ALICE, { label: "speaker_0", personId: jana });
            const [row] = await speakerRows();
            expect(row).toMatchObject({
                personId: jana,
                markedUnknown: false,
                confirmedByUserId: ALICE,
            });
        });

        it("clears an answer by deleting the row", async () => {
            const jana = await person(ALICE, "Jana");
            await put(ALICE, { label: "speaker_0", personId: jana });
            await put(ALICE, { label: "speaker_1", unknown: true });
            expect(await speakerRows()).toHaveLength(2);

            await put(ALICE, { label: "speaker_0" });
            await put(ALICE, { label: "speaker_1" });
            expect(await speakerRows()).toEqual([]);
        });

        it("rejects a suggestion: remembers the pair and removes the row", async () => {
            const jana = await person(ALICE, "Jana");
            await suggest([suggestion("speaker_0", jana)]);
            expect(await speakerRows()).toHaveLength(1);

            const response = await put(ALICE, {
                label: "speaker_0",
                personId: jana,
                reject: true,
            });
            expect(response.status).toBe(200);
            expect(await speakerRows()).toEqual([]);
            expect(await rejections()).toEqual([
                { label: "speaker_0", personId: jana },
            ]);
        });

        it("needs the person to reject, and only one the caller can see", async () => {
            expect(
                (await put(ALICE, { label: "speaker_0", reject: true })).status,
            ).toBe(400);
            const bobs = await person(BOB, "Bob's contact");
            expect(
                (
                    await put(ALICE, {
                        label: "speaker_0",
                        personId: bobs,
                        reject: true,
                    })
                ).status,
            ).toBe(404);
            expect(await rejections()).toEqual([]);
        });

        it("keys an overlong label instead of refusing it", async () => {
            const label = `speaker_${"x".repeat(70)}`;
            expect(
                (await put(ALICE, { label: ` ${label}`, unknown: true }))
                    .status,
            ).toBe(200);
            const [row] = await speakerRows();
            expect(row?.label).toBe(label.slice(0, 64));
        });
    });

    describe("suggestions", () => {
        it("never offers a rejected person again for that label", async () => {
            const jana = await person(ALICE, "Jana");
            await suggest([suggestion("speaker_0", jana)]);
            await rejectSuggestion({
                userId: ALICE,
                transcriptionId: transcriptId,
                label: "speaker_0",
                personId: jana,
            });
            expect(await suggest([suggestion("speaker_0", jana)])).toBe(0);
            expect(await speakerRows()).toEqual([]);
        });

        it("keeps every rejection when suggestions alternate", async () => {
            const jana = await person(ALICE, "Jana");
            const petr = await person(ALICE, "Petr");
            const reject = (personId: string) =>
                rejectSuggestion({
                    userId: ALICE,
                    transcriptionId: transcriptId,
                    label: "speaker_0",
                    personId,
                });

            await suggest([suggestion("speaker_0", jana)]);
            await reject(jana);
            expect(await suggest([suggestion("speaker_0", petr)])).toBe(1);
            await reject(petr);
            expect(await suggest([suggestion("speaker_0", jana)])).toBe(0);
            expect(await suggest([suggestion("speaker_0", petr)])).toBe(0);
            expect(await speakerRows()).toEqual([]);
        });

        it("only blocks the rejected label", async () => {
            const jana = await person(ALICE, "Jana");
            await rejectSuggestion({
                userId: ALICE,
                transcriptionId: transcriptId,
                label: "speaker_0",
                personId: jana,
            });
            expect(await suggest([suggestion("speaker_1", jana)])).toBe(1);
        });

        it("never replaces a confirmed row or an answer of unknown", async () => {
            const jana = await person(ALICE, "Jana");
            const petr = await person(ALICE, "Petr");
            await put(ALICE, { label: "speaker_0", personId: jana });
            await put(ALICE, { label: "speaker_1", unknown: true });

            expect(
                await suggest([
                    suggestion("speaker_0", petr),
                    suggestion("speaker_1", petr),
                ]),
            ).toBe(0);
            const rows = await speakerRows();
            expect(
                rows.map((row) => [row.label, row.personId, row.status]),
            ).toEqual(
                expect.arrayContaining([
                    ["speaker_0", jana, "confirmed"],
                    ["speaker_1", null, "confirmed"],
                ]),
            );
        });

        it("drops suggestions without a person", async () => {
            expect(await suggest([suggestion("speaker_0", null)])).toBe(0);
            expect(await speakerRows()).toEqual([]);
        });

        it("takes a rejection back when a person confirms that name", async () => {
            const jana = await person(ALICE, "Jana");
            await rejectSuggestion({
                userId: ALICE,
                transcriptionId: transcriptId,
                label: "speaker_0",
                personId: jana,
            });
            await setTranscriptSpeaker({
                userId: ALICE,
                transcriptionId: transcriptId,
                label: "speaker_0",
                personId: jana,
                source: "user",
                status: "confirmed",
                confirmedByUserId: ALICE,
            });
            expect(await rejections()).toEqual([]);
        });
    });

    it("moves rejections onto the person a merge keeps", async () => {
        const jana = await person(ALICE, "Jana");
        const duplicate = await person(ALICE, "J. Nováková");
        await rejectSuggestion({
            userId: ALICE,
            transcriptionId: transcriptId,
            label: "speaker_0",
            personId: duplicate,
        });
        await mergePeople(ALICE, jana, duplicate);
        expect(await rejections()).toEqual([
            { label: "speaker_0", personId: jana },
        ]);
        expect(await suggest([suggestion("speaker_0", jana)])).toBe(0);
    });

    it("copies unknown and the confirmer into the Organization view", async () => {
        const orgUserId = (await ensureOrgAccount()) ?? "";
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await put(ALICE, { label: "speaker_1", unknown: true });
        await addRecordingToFolder({
            userId: ALICE,
            recordingId: REC,
            folderId: root?.id ?? "",
        });

        // The first edit in the Organization view makes its copy.
        const response = await put(
            BOB,
            { label: "speaker_0", displayName: "Petr" },
            "?view=org",
        );
        expect(response.status).toBe(200);

        const [copy] = await db()
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(eq(transcriptions.userId, orgUserId));
        const copied = await db()
            .select()
            .from(transcriptSpeakers)
            .where(
                and(
                    eq(transcriptSpeakers.transcriptionId, copy?.id ?? ""),
                    eq(transcriptSpeakers.label, "speaker_1"),
                ),
            );
        expect(copied).toEqual([
            expect.objectContaining({
                personId: null,
                status: "confirmed",
                markedUnknown: true,
                confirmedByUserId: ALICE,
            }),
        ]);
        const [named] = await db()
            .select()
            .from(transcriptSpeakers)
            .where(
                and(
                    eq(transcriptSpeakers.transcriptionId, copy?.id ?? ""),
                    eq(transcriptSpeakers.label, "speaker_0"),
                ),
            );
        // Bob acted in the Organization view; the row belongs to the
        // organization account, and names him as the one who confirmed it.
        expect(named).toMatchObject({
            userId: orgUserId,
            confirmedByUserId: BOB,
        });
    });
});
