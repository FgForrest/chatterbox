/**
 * A change in the Organization view lands only on the transcript it was
 * made on, against a real PostgreSQL.
 *
 * On a recording shared before snapshots existed, until the Organization
 * has its own transcript, the view shows the owner's, and the first change
 * takes the Organization's copy. The change must still be refused when the
 * Organization's transcript appeared meanwhile, and the copy must carry the
 * names of the text it copied, whatever the owner rewrites alongside.
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

const { dbProxy, dbRef, mockEnv, hooks } = vi.hoisted(() => {
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
        // Run once, at the start of the next Organization change or the
        // next promotion of a copied name.
        hooks: {
            beforeChange: null as null | (() => Promise<void>),
            onPromote: null as null | (() => void),
        },
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
// Another writer committing between the route's checks and the change.
vi.mock("@/lib/sharing/org-transcript", async () => {
    const actual = await vi.importActual<
        typeof import("@/lib/sharing/org-transcript")
    >("@/lib/sharing/org-transcript");
    return {
        ...actual,
        changeOrgTranscriptSpeaker: async (
            ...args: Parameters<typeof actual.changeOrgTranscriptSpeaker>
        ) => {
            const run = hooks.beforeChange;
            hooks.beforeChange = null;
            await run?.();
            return actual.changeOrgTranscriptSpeaker(...args);
        },
    };
});
// Another writer starting while the copy is being made.
vi.mock("@/lib/knowledge/people", async () => {
    const actual = await vi.importActual<
        typeof import("@/lib/knowledge/people")
    >("@/lib/knowledge/people");
    return {
        ...actual,
        promotePersonInTx: (
            ...args: Parameters<typeof actual.promotePersonInTx>
        ) => {
            const run = hooks.onPromote;
            hooks.onPromote = null;
            run?.();
            return actual.promotePersonInTx(...args);
        },
    };
});

import {
    GET as getSpeakersRoute,
    PUT as putSpeakerRoute,
} from "@/app/api/recordings/[id]/speakers/route";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { ensureOrgAccount } from "@/lib/org/account";
import { upsertTranscription } from "@/lib/transcription/persist";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const BOB = "user-bob";
const REC = "rec-shared";
const MODEL = "scribe_v2+diarize";

type Handler = (
    request: Request,
    context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

function request(user: string, init: RequestInit = {}) {
    return new Request(
        `http://localhost/api/recordings/${REC}/speakers?view=org`,
        {
            ...init,
            headers: {
                "content-type": "application/json",
                "x-test-user": user,
            },
        },
    );
}

async function shownVersion(user: string) {
    const response = await (getSpeakersRoute as unknown as Handler)(
        request(user),
        { params: Promise.resolve({ id: REC }) },
    );
    const body = (await response.json()) as {
        transcriptionId: string;
        revision: number;
    };
    return { transcriptionId: body.transcriptionId, revision: body.revision };
}

async function put(
    user: string,
    seen: { transcriptionId: string; revision: number },
    body: object,
) {
    return (putSpeakerRoute as unknown as Handler)(
        request(user, {
            method: "PUT",
            body: JSON.stringify({ ...seen, ...body }),
        }),
        { params: Promise.resolve({ id: REC }) },
    );
}

function turn(speaker: string, startMs: number, endMs: number, text: string) {
    return { speaker, startMs, endMs, text };
}

describeWithDatabase(
    "changing a speaker in the Organization view (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase | null = null;
        let orgUserId = "";

        function db() {
            if (!database) throw new Error("test database was not initialized");
            return database.db;
        }

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "org_speaker_change",
            );
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
        }, 120_000);

        afterAll(async () => {
            dbRef.current = null;
            await database?.dispose();
        }, 30_000);

        beforeEach(async () => {
            hooks.beforeChange = null;
            hooks.onPromote = null;
            await db().delete(users);
            await db()
                .insert(users)
                .values([
                    { id: OWNER, email: "owner@example.test" },
                    { id: BOB, email: "bob@example.test" },
                ]);
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

        async function ownerTranscript(
            turns: ReturnType<typeof turn>[],
        ): Promise<string> {
            const [row] = await db()
                .insert(transcriptions)
                .values({
                    recordingId: REC,
                    userId: OWNER,
                    text: encryptText(
                        turns.map((t) => `${t.speaker}: ${t.text}`).join("\n"),
                    ),
                    turns: encryptJsonField(turns),
                    provider: "elevenlabs",
                    model: MODEL,
                    source: "riffado",
                })
                .returning({ id: transcriptions.id });
            return row?.id ?? "";
        }

        /**
         * Shared before snapshots existed: the Organization view shows the
         * owner's transcript until its first change, or the backfill, takes
         * the Organization's copy.
         */
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

        async function orgRows() {
            return db()
                .select({
                    transcriptionId: transcriptSpeakers.transcriptionId,
                    label: transcriptSpeakers.label,
                    personId: transcriptSpeakers.personId,
                })
                .from(transcriptSpeakers)
                .where(eq(transcriptSpeakers.userId, orgUserId));
        }

        async function orgPeopleNamed() {
            return db()
                .select({ id: people.id })
                .from(people)
                .where(eq(people.userId, orgUserId));
        }

        const firstTurns = [
            turn("speaker_0", 0, 10_000, "I am Jana."),
            turn("speaker_1", 10_000, 20_000, "I am Petr."),
        ];

        it("refuses a change made on the owner's transcript once the Organization re-transcribed", async () => {
            await ownerTranscript(firstTurns);
            await share();
            const seen = await shownVersion(orgUserId);

            // The Organization's own transcript, new text at revision 0,
            // commits after the route checked what Bob saw.
            hooks.beforeChange = async () => {
                const result = await upsertTranscription({
                    userId: orgUserId,
                    recordingOwnerId: OWNER,
                    recordingId: REC,
                    text: "speaker_0: I am Petr.\nspeaker_1: I am Jana.",
                    detectedLanguage: null,
                    source: "riffado",
                    provider: "elevenlabs",
                    model: MODEL,
                });
                expect(result.committed).toBe(true);
            };

            const response = await put(orgUserId, seen, {
                label: "speaker_0",
                displayName: "Jana",
            });
            expect(response.status).toBe(409);
            expect(await orgRows()).toEqual([]);
            // The refused change created nobody.
            expect(await orgPeopleNamed()).toEqual([]);
        });

        it("refuses a stale view of the owner's transcript after another tab's first change", async () => {
            await ownerTranscript(firstTurns);
            await share();
            const firstTab = await shownVersion(orgUserId);
            const secondTab = await shownVersion(orgUserId);

            expect(
                (
                    await put(orgUserId, secondTab, {
                        label: "speaker_1",
                        unknown: true,
                    })
                ).status,
            ).toBe(200);
            expect(
                (
                    await put(orgUserId, firstTab, {
                        label: "speaker_0",
                        unknown: true,
                    })
                ).status,
            ).toBe(409);

            // Reloaded, the tab shows the Organization's copy and can
            // change it.
            const reloaded = await shownVersion(orgUserId);
            expect(reloaded.transcriptionId).not.toBe(firstTab.transcriptionId);
            expect(
                (
                    await put(orgUserId, reloaded, {
                        label: "speaker_0",
                        unknown: true,
                    })
                ).status,
            ).toBe(200);
        });

        it("refuses members: the organization account changes a shared recording's speakers", async () => {
            await ownerTranscript(firstTurns);
            await share();
            const response = await put(BOB, await shownVersion(BOB), {
                label: "speaker_0",
                displayName: "Jana",
            });
            expect(response.status).toBe(403);
            expect(await orgRows()).toEqual([]);
            expect(await orgPeopleNamed()).toEqual([]);
        });

        it("copies the names of the text it copies, and the owner cannot rewrite it alongside", async () => {
            const ownId = await ownerTranscript(firstTurns);
            const [jana, petr] = await db()
                .insert(people)
                .values([
                    { userId: OWNER, displayName: encryptText("Jana") },
                    { userId: OWNER, displayName: encryptText("Petr") },
                ])
                .returning({ id: people.id });
            await db()
                .insert(transcriptSpeakers)
                .values([
                    {
                        userId: OWNER,
                        transcriptionId: ownId,
                        label: "speaker_0",
                        personId: jana?.id,
                        source: "user",
                        status: "confirmed",
                        confirmedByUserId: OWNER,
                    },
                    {
                        userId: OWNER,
                        transcriptionId: ownId,
                        label: "speaker_1",
                        personId: petr?.id,
                        source: "user",
                        status: "confirmed",
                        confirmedByUserId: OWNER,
                    },
                ]);
            await share();
            const seen = await shownVersion(orgUserId);

            // The owner re-transcribes, numbering the voices the other way,
            // as the copy is being made: shared, the owner's transcript is
            // frozen, so the rewrite waits for the copy and writes nothing.
            let rewrite: Promise<unknown> = Promise.resolve();
            hooks.onPromote = () => {
                rewrite = upsertTranscription({
                    userId: OWNER,
                    recordingId: REC,
                    text: "speaker_1: I am Jana.\nspeaker_0: I am Petr.",
                    turns: [
                        turn("speaker_1", 0, 10_000, "I am Jana."),
                        turn("speaker_0", 10_000, 20_000, "I am Petr."),
                    ],
                    detectedLanguage: null,
                    source: "riffado",
                    provider: "elevenlabs",
                    model: MODEL,
                });
            };
            const response = await put(orgUserId, seen, {
                label: "speaker_0",
                unknown: true,
            });
            expect(await rewrite).toEqual({
                committed: false,
                reason: "shared",
            });
            expect(response.status).toBe(200);

            const byLabel = async (transcriptionId: string) =>
                Object.fromEntries(
                    (
                        await db()
                            .select({
                                label: transcriptSpeakers.label,
                                personId: transcriptSpeakers.personId,
                                markedUnknown: transcriptSpeakers.markedUnknown,
                            })
                            .from(transcriptSpeakers)
                            .where(
                                eq(
                                    transcriptSpeakers.transcriptionId,
                                    transcriptionId,
                                ),
                            )
                    ).map((row) => [
                        row.label,
                        row.markedUnknown ? "unknown" : row.personId,
                    ]),
                );
            const [copy] = await db()
                .select({ id: transcriptions.id })
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, REC),
                        eq(transcriptions.userId, orgUserId),
                    ),
                );
            // The copy holds the first text: Petr on speaker_1, and the
            // organization account's answer on speaker_0, where Jana was.
            expect(await byLabel(copy?.id ?? "")).toEqual({
                speaker_0: "unknown",
                speaker_1: petr?.id,
            });
            // The owner's transcript is as it was shared.
            expect(await byLabel(ownId)).toEqual({
                speaker_0: jana?.id,
                speaker_1: petr?.id,
            });
        });
    },
);
