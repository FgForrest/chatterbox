/**
 * A generated title never replaces one a person set, against a real
 * PostgreSQL: not a rename made before, nor one committing while the title
 * is being stored.
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
    chatterItems,
    itemProcessing,
    mailContents,
    mailMessages,
    transcriptions,
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
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));

import { decryptText, encryptText } from "@/lib/encryption/fields";
import {
    storeGeneratedMailTitle,
    storeGeneratedTitle,
    titleStillGenerated,
} from "@/lib/recordings/generated-title";
import { titleStepDoneForFence } from "@/lib/recordings/title-fence";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const MAIL = "mail-1";
const REC = "rec-1";

describeWithDatabase("storing a generated title (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "generated_title",
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
        await insertRecordings(db(), {
            id: REC,
            userId: ALICE,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("2026-09-01 10:00"),
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${ALICE}/rec.mp3`,
            plaudVersion: "1",
        });
    });

    async function title() {
        const [row] = await db()
            .select({ filename: chatterItems.title })
            .from(chatterItems)
            .where(eq(chatterItems.id, REC));
        return decryptText(row?.filename ?? "");
    }

    async function seedPendingTitleStep(
        itemId: string,
        fence: {
            contentId: string;
            contentSourceId: string;
            contentRevision: number;
            profileRevisionId: null;
        },
    ) {
        await db()
            .insert(itemProcessing)
            .values({
                itemId,
                userId: ALICE,
                view: "private",
                phases: {
                    summary: {
                        state: "pending",
                        reason: "transcript",
                        generation: 1,
                        inputs: fence,
                        at: "2026-10-15T00:00:00.000Z",
                        steps: {
                            title: {
                                ...fence,
                                profileRevisionId: undefined,
                                generation: 1,
                            },
                        },
                    },
                },
            });
    }

    async function processingState(itemId: string) {
        const [processing] = await db()
            .select({
                phases: itemProcessing.phases,
                profileRevisionId: itemProcessing.profileRevisionId,
            })
            .from(itemProcessing)
            .where(eq(itemProcessing.itemId, itemId));
        return processing;
    }

    /** What renaming does (`PATCH /api/recordings/[id]`). */
    const renamed = {
        title: encryptText("Budget review"),
        titleEditedAt: new Date(),
    };

    it("stores it while no person has set a title", async () => {
        expect(await storeGeneratedTitle(ALICE, REC, "Weekly sync")).toBe(true);
        expect(await title()).toBe("Weekly sync");
        expect(await titleStillGenerated(ALICE, REC)).toBe(true);
    });

    it("marks the queued title step and Summary phase done atomically", async () => {
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: ALICE,
                text: encryptText("Weekly planning"),
                detectedLanguage: "en",
                provider: "test",
                model: "test",
                source: "riffado",
                revision: 2,
            })
            .returning({ id: transcriptions.id });
        const fence = {
            contentId: transcript?.id ?? "",
            contentSourceId: "riffado",
            contentRevision: 2,
            profileRevisionId: null,
        };
        await seedPendingTitleStep(REC, fence);

        await expect(
            storeGeneratedTitle(
                ALICE,
                REC,
                "Weekly sync",
                undefined,
                ALICE,
                fence,
            ),
        ).resolves.toBe(true);

        const [processing] = await db()
            .select({ phases: itemProcessing.phases })
            .from(itemProcessing)
            .where(eq(itemProcessing.itemId, REC));
        expect(processing?.phases.summary).toMatchObject({
            state: "done",
            reason: "completed",
            inputs: fence,
            steps: {
                title: {
                    contentId: fence.contentId,
                    contentSourceId: fence.contentSourceId,
                    contentRevision: fence.contentRevision,
                    state: "done",
                },
            },
        });
    });

    it("keeps the summary title when an automatic recording job reaches its write later", async () => {
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: ALICE,
                text: encryptText("Weekly planning"),
                detectedLanguage: "en",
                provider: "test",
                model: "test",
                source: "riffado",
                revision: 2,
            })
            .returning({ id: transcriptions.id });
        const fence = {
            contentId: transcript?.id ?? "",
            contentSourceId: "riffado",
            contentRevision: 2,
            profileRevisionId: null,
        };
        await seedPendingTitleStep(REC, fence);
        expect(titleStepDoneForFence(await processingState(REC), fence)).toBe(
            false,
        );

        const events: string[] = [];
        if (
            await storeGeneratedTitle(
                ALICE,
                REC,
                "Summary title",
                undefined,
                ALICE,
                fence,
            )
        ) {
            events.push("recording.updated");
        }
        expect(titleStepDoneForFence(await processingState(REC), fence)).toBe(
            true,
        );
        if (
            await storeGeneratedTitle(
                ALICE,
                REC,
                "Transcript title",
                undefined,
                ALICE,
                fence,
                { skipIfTitleStepDoneForFence: true },
            )
        ) {
            events.push("recording.updated");
        }

        expect(await title()).toBe("Summary title");
        expect(events).toEqual(["recording.updated"]);
    });

    it("keeps the summary title when an automatic mail job reaches its write later", async () => {
        await db()
            .insert(chatterItems)
            .values({
                id: MAIL,
                userId: ALICE,
                kind: "mail",
                title: encryptText("Original subject"),
                occurredAt: new Date("2026-09-01T10:00:00Z"),
            });
        await db()
            .insert(mailMessages)
            .values({
                id: MAIL,
                userId: ALICE,
                rawHash: "1".repeat(64),
                receivedAt: new Date("2026-09-01T10:00:00Z"),
                sizeBytes: 100,
                auth: {},
                senderVerified: true,
            });
        const [content] = await db()
            .insert(mailContents)
            .values({
                itemId: MAIL,
                userId: ALICE,
                revision: 3,
                parserVersion: 1,
                segments: [],
            })
            .returning({ id: mailContents.id });
        const fence = {
            contentId: content?.id ?? "",
            contentSourceId: "mail",
            contentRevision: 3,
            profileRevisionId: null,
        };
        await seedPendingTitleStep(MAIL, fence);
        expect(titleStepDoneForFence(await processingState(MAIL), fence)).toBe(
            false,
        );

        const events: string[] = [];
        if (
            await storeGeneratedMailTitle(
                ALICE,
                MAIL,
                "Summary subject",
                undefined,
                ALICE,
                fence,
            )
        ) {
            events.push("recording.updated");
        }
        if (
            await storeGeneratedMailTitle(
                ALICE,
                MAIL,
                "Mail body subject",
                undefined,
                ALICE,
                fence,
                { skipIfTitleStepDoneForFence: true },
            )
        ) {
            events.push("recording.updated");
        }
        const [mail] = await db()
            .select({ title: chatterItems.title })
            .from(chatterItems)
            .where(eq(chatterItems.id, MAIL));

        expect(decryptText(mail?.title ?? "")).toBe("Summary subject");
        expect(events).toEqual(["recording.updated"]);
    });

    it("allows explicit regeneration after the title step is done", async () => {
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: ALICE,
                text: encryptText("Weekly planning"),
                detectedLanguage: "en",
                provider: "test",
                model: "test",
                source: "riffado",
                revision: 2,
            })
            .returning({ id: transcriptions.id });
        const fence = {
            contentId: transcript?.id ?? "",
            contentSourceId: "riffado",
            contentRevision: 2,
            profileRevisionId: null,
        };
        await seedPendingTitleStep(REC, fence);
        await storeGeneratedTitle(
            ALICE,
            REC,
            "Summary title",
            undefined,
            ALICE,
            fence,
        );

        await expect(
            storeGeneratedTitle(
                ALICE,
                REC,
                "Explicit title",
                undefined,
                ALICE,
                fence,
            ),
        ).resolves.toBe(true);
        expect(await title()).toBe("Explicit title");
    });

    it("keeps a title a person set", async () => {
        await db()
            .update(chatterItems)
            .set(renamed)
            .where(eq(chatterItems.id, REC));

        expect(await storeGeneratedTitle(ALICE, REC, "Weekly sync")).toBe(
            false,
        );
        expect(await title()).toBe("Budget review");
        expect(await titleStillGenerated(ALICE, REC)).toBe(false);
    });

    it("replaces a manual title only when explicitly requested with its current edit time", async () => {
        await db()
            .update(chatterItems)
            .set(renamed)
            .where(eq(chatterItems.id, REC));

        expect(
            await storeGeneratedTitle(
                ALICE,
                REC,
                "Quarterly planning",
                renamed.titleEditedAt,
            ),
        ).toBe(true);
        expect(await title()).toBe("Quarterly planning");
        expect(await titleStillGenerated(ALICE, REC)).toBe(true);
    });

    it("does not replace a newer manual edit requested during generation", async () => {
        await db()
            .update(chatterItems)
            .set(renamed)
            .where(eq(chatterItems.id, REC));
        await db()
            .update(chatterItems)
            .set({
                title: encryptText("Newer choice"),
                titleEditedAt: new Date(Date.now() + 1000),
            })
            .where(eq(chatterItems.id, REC));

        expect(
            await storeGeneratedTitle(
                ALICE,
                REC,
                "Quarterly planning",
                renamed.titleEditedAt,
            ),
        ).toBe(false);
        expect(await title()).toBe("Newer choice");
    });

    it("keeps a rename that commits while the title is being stored", async () => {
        let commit = () => {};
        const committed = new Promise<void>((resolve) => {
            commit = resolve;
        });
        let started = () => {};
        const renaming = new Promise<void>((resolve) => {
            started = resolve;
        });
        const rename = db().transaction(async (tx) => {
            await tx
                .update(chatterItems)
                .set(renamed)
                .where(eq(chatterItems.id, REC));
            started();
            await committed;
        });
        await renaming;

        const stored = storeGeneratedTitle(ALICE, REC, "Weekly sync");
        // Long enough for the update to be waiting on the rename's lock.
        await new Promise((resolve) => setTimeout(resolve, 200));
        commit();
        await rename;
        expect(await stored).toBe(false);
        expect(await title()).toBe("Budget review");
    });

    it("stores nothing on somebody else's recording", async () => {
        expect(
            await storeGeneratedTitle("user-mallory", REC, "Weekly sync"),
        ).toBe(false);
        expect(await titleStillGenerated("user-mallory", REC)).toBe(false);
        expect(await title()).toBe("2026-09-01 10:00");
    });
});
