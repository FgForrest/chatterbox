import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as finishReview } from "@/app/api/recordings/[id]/review/finish/route";
import { PATCH as decideReviewItem } from "@/app/api/recordings/[id]/review/items/[itemId]/route";
import { GET } from "@/app/api/recordings/[id]/review/route";
import {
    chatterItems,
    learnReviewItems,
    learnRuns,
    processingProfileRevisions,
    processingProfiles,
    transcriptions,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { state, owner } = vi.hoisted(() => ({
    state: { db: null as Record<PropertyKey, unknown> | null },
    owner: "revision-owner",
}));

vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get(_target, key) {
                const value = state.db?.[key];
                return typeof value === "function"
                    ? value.bind(state.db)
                    : value;
            },
        },
    ),
}));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));
vi.mock("@/lib/sharing/learn-access", () => ({
    requireLearnAccess: vi.fn(async (_request: Request, id: string) => ({
        actorUserId: owner,
        access: {
            recordingId: id,
            kind: id === "mail-review" ? "mail" : "audio",
            ownerUserId: owner,
            contentUserId: owner,
            role: "owner",
            view: "private",
            shared: false,
            orgUserId: null,
        },
    })),
}));

const databaseUrl = getTestDatabaseUrl();
describe.skipIf(!databaseUrl)("#426 Learn review revision fence", () => {
    let database: TestPostgresDatabase;

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "review_revision_fence",
        );
        state.db = database.db as unknown as Record<PropertyKey, unknown>;
        await database.db
            .insert(users)
            .values({ id: owner, email: "owner@example.com" });
        await database.db.insert(processingProfiles).values({
            id: "review-profile",
            ownerUserId: owner,
            channel: "audio",
            scope: "personal",
            name: encryptText("Review profile"),
        });
        await database.db.insert(processingProfileRevisions).values({
            id: "review-profile-revision",
            profileId: "review-profile",
            settings: encryptText(
                JSON.stringify(defaultProfileSettings("audio")),
            ),
        });
    }, 120_000);
    afterAll(async () => {
        state.db = null;
        await database?.dispose();
    }, 30_000);

    function read(id: string) {
        return GET(
            new Request(
                `https://example.com/recordings/${id}/review?source=riffado`,
            ),
            {
                params: Promise.resolve({ id }),
            },
        );
    }

    it.each([
        "ready",
        "finished",
    ] as const)("hides a %s run after rewriting its transcript", async (status) => {
        const id = `recording-${status}`;
        const transcriptionId = `transcript-${status}`;
        const runId = `run-${status}`;
        const itemId = `finding-${status}`;
        const db = database.db;
        await insertRecordings(db, {
            id,
            userId: owner,
            deviceSn: "SN-1",
            plaudFileId: id,
            filename: encryptText("Sample recording"),
            duration: 5000,
            startTime: new Date(0),
            endTime: new Date(5000),
            filesize: 100,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${id}.mp3`,
            plaudVersion: "1",
        });
        await db.insert(transcriptions).values({
            id: transcriptionId,
            userId: owner,
            recordingId: id,
            source: "riffado",
            revision: 1,
            text: encryptText("First transcript"),
            provider: "sample",
            model: "sample-model",
        });
        await db.insert(learnRuns).values({
            id: runId,
            itemId: id,
            transcriptionId,
            userId: owner,
            scopeUserId: owner,
            view: "private",
            trigger: "manual",
            transcriptRevision: 1,
            vocabularyVersion: 0,
            profileRevisionId: "review-profile-revision",
            status,
        });
        await db.insert(learnReviewItems).values({
            id: itemId,
            runId,
            userId: owner,
            kind: "fact",
            fingerprintHmac: "sample",
            payload: {},
        });
        expect(await (await read(id)).json()).toMatchObject({
            run: { status },
            items: [{ id: itemId }],
        });
        await db
            .update(transcriptions)
            .set({
                revision: 2,
                text: encryptText("Replacement transcript"),
            })
            .where(eq(transcriptions.id, transcriptionId));
        expect(await (await read(id)).json()).toMatchObject({
            run: null,
            items: [],
        });
        if (status === "ready") {
            const draft = await decideReviewItem(
                new Request(
                    `https://example.com/review/items/${itemId}?source=riffado`,
                    {
                        method: "PATCH",
                        body: JSON.stringify({
                            decision: "accepted",
                            version: 0,
                        }),
                    },
                ),
                { params: Promise.resolve({ id, itemId }) },
            );
            expect(draft.status).toBe(404);
            const finished = await finishReview(
                new Request(
                    "https://example.com/review/finish?source=riffado",
                    {
                        method: "POST",
                        body: JSON.stringify({
                            runId,
                            versions: { [itemId]: 0 },
                        }),
                    },
                ),
                { params: Promise.resolve({ id }) },
            );
            expect(await finished.json()).toMatchObject({
                status: "superseded",
                applied: 0,
            });
        }
    });

    it("still reads the mail content review", async () => {
        const id = "mail-review";
        const db = database.db;
        await db.insert(chatterItems).values({
            id,
            userId: owner,
            kind: "mail",
            title: encryptText("Sample mail"),
            occurredAt: new Date(0),
        });
        await db.insert(learnRuns).values({
            id: "mail-run",
            itemId: id,
            userId: owner,
            scopeUserId: owner,
            view: "private",
            trigger: "manual",
            transcriptRevision: 1,
            vocabularyVersion: 0,
            status: "finished",
        });
        expect(await (await read(id)).json()).toMatchObject({
            run: { id: "mail-run", status: "finished", transcriptionId: null },
        });
    });
});
