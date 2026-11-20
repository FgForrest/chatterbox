import { and, eq, isNull } from "drizzle-orm";
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
    asyncJobs,
    chatterItems,
    itemProcessing,
    learnReviewItems,
    learnRuns,
    mailContents,
    mailMessages,
    mailPendingShares,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    restrictedFolderMembers,
    summaryRemarks,
    taskMentions,
    taskUpdateProposals,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, authzState, session } = vi.hoisted(() => {
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
    const session = { user: { id: "share-intent-alice" } };
    return {
        dbProxy: proxy,
        dbRef: ref,
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared" as const,
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password" as string | undefined,
            ORG_ACCOUNT_NAME: undefined as string | undefined,
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            AUTHZ_MODE: "local" as "local" | "idp",
        },
        authzState: { holderMayUse: true },
        session,
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/auth-server", async (importOriginal) => ({
    ...(await importOriginal()),
    requireApiSession: vi.fn(async () => session),
    requireApiSessionActor: vi.fn(async () => ({
        session,
        actor: {
            kind: "user",
            actorId: session.user.id,
            issuer: null,
            subject: null,
            capabilities: new Set(["use"]),
            clientId: null,
            clientPermissions: new Set(),
            verifiedAt: null,
        },
        authTime: null,
    })),
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/authz/access-state", () => ({
    holderAccess: vi.fn(async () =>
        authzState.holderMayUse
            ? {
                  ok: true,
                  capabilities: new Set(["use"]),
                  verifiedAt: new Date(),
              }
            : { ok: false, reason: "not-granted" },
    ),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import { GET as mailDetail } from "@/app/api/mail/[id]/route";
import { POST as categorize } from "@/app/api/recordings/[id]/categorize/route";
import {
    POST as file,
    PATCH as move,
    DELETE as unfile,
} from "@/app/api/recordings/[id]/folders/route";
import { DELETE as cancel } from "@/app/api/recordings/[id]/intended-placements/[folderId]/route";
import { POST as confirm } from "@/app/api/recordings/[id]/intended-placements/confirm/route";
import {
    PATCH as changeLanguage,
    GET as language,
} from "@/app/api/recordings/[id]/language/route";
import { GET as review } from "@/app/api/recordings/[id]/review/route";
import {
    POST as addRemark,
    DELETE as removeRemark,
} from "@/app/api/recordings/[id]/summary/remarks/route";
import {
    PUT as saveSummary,
    GET as summary,
} from "@/app/api/recordings/[id]/summary/route";
import { db as appDb } from "@/db";
import { setItemTitle } from "@/db/items";
import * as contentVersions from "@/db/queries/item-content-versions";
import { deleteMailContent } from "@/db/queries/mail-retention";
import { completeProcessingGenerationInTx } from "@/db/queries/pipeline";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import {
    assertCategorizableFolder,
    ensureRootFolders,
} from "@/lib/folders/folders";
import { revertCorrection } from "@/lib/knowledge/corrections";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { changeTranscriptSpeaker } from "@/lib/knowledge/speaker-changes";
import { llmRendering } from "@/lib/learn/llm-input";
import { mailShareProblems } from "@/lib/mail/share-gate";
import { gatherFacts } from "@/lib/pipeline/facts";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";
import {
    cancelIntendedPlacement,
    confirmIntendedPlacements,
    executeIntendedShares,
    executeIntendedSharesWithOutcome,
    recordIntendedPlacementInTx,
} from "@/lib/pipeline/share-intent";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { updateProfile } from "@/lib/profiles/store";
import { taskViewerById } from "@/lib/tasks/access";
import { acceptReview, addTask, skipTaskReview } from "@/lib/tasks/tasks";
import { upsertTranscription } from "@/lib/transcription/persist";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "share-intent-alice";
const BOB = "share-intent-bob";
const ORG = "share-intent-org";

describeWithDatabase("intended Organization placements (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let aliceRootId = "";
    let orgRootId = "";
    let orgFolderId = "";
    let secondOrgFolderId = "";
    let bobFolderId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function rootId(userId: string): Promise<string> {
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, userId),
                    isNull(recordingFolders.parentId),
                ),
            )
            .limit(1);
        if (!root) throw new Error(`root missing for ${userId}`);
        return root.id;
    }

    async function insertFolder(input: {
        id: string;
        userId: string;
        parentId: string;
        name: string;
    }): Promise<void> {
        await db()
            .insert(recordingFolders)
            .values({
                ...input,
                kind: "custom",
                name: encryptText(input.name),
                nameHash: lookupHash(input.name),
            });
    }

    async function insertAudio(id: string, userId = ALICE): Promise<void> {
        await insertRecordings(db(), {
            id,
            userId,
            deviceSn: "SN-1",
            plaudFileId: `plaud-${id}`,
            filename: encryptText(`Recording ${id}`),
            duration: 60_000,
            startTime: new Date("2026-10-15T10:00:00Z"),
            endTime: new Date("2026-10-15T10:01:00Z"),
            filesize: 1000,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${userId}/${id}.mp3`,
            plaudVersion: "1",
        });
    }

    async function insertTranscript(itemId: string): Promise<void> {
        await db()
            .insert(transcriptions)
            .values({
                recordingId: itemId,
                userId: ALICE,
                text: encryptText("Ready to share."),
                provider: "openai",
                model: "whisper-1",
                source: "riffado",
            });
    }

    async function insertMail(id: string): Promise<void> {
        await db()
            .insert(chatterItems)
            .values({
                id,
                userId: ALICE,
                kind: "mail",
                title: encryptText(`Mail ${id}`),
                occurredAt: new Date("2026-10-15T10:00:00Z"),
            });
    }

    async function recordIntent(itemId: string): Promise<void> {
        await appDb.transaction((tx) =>
            recordIntendedPlacementInTx(tx, {
                canCurate: false,
                ownerUserId: ALICE,
                itemId,
                folderId: orgFolderId,
            }),
        );
    }

    async function makeManualOnly(itemId: string): Promise<void> {
        await db()
            .update(itemProcessing)
            .set({ manualOnly: true })
            .where(
                and(
                    eq(itemProcessing.itemId, itemId),
                    eq(itemProcessing.userId, ALICE),
                    eq(itemProcessing.view, "private"),
                ),
            );
    }

    async function assignments(itemId: string): Promise<string[]> {
        return (
            await db()
                .select({ folderId: recordingFolderAssignments.folderId })
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.userId, ALICE),
                        eq(recordingFolderAssignments.itemId, itemId),
                    ),
                )
        ).map((row) => row.folderId);
    }

    async function intents(itemId: string): Promise<string[]> {
        return (
            await db()
                .select({ folderId: mailPendingShares.folderId })
                .from(mailPendingShares)
                .where(
                    and(
                        eq(mailPendingShares.userId, ALICE),
                        eq(mailPendingShares.itemId, itemId),
                    ),
                )
        ).map((row) => row.folderId);
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "share_intent",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        session.user.id = ALICE;
        mockEnv.AUTHZ_MODE = "local";
        authzState.holderMayUse = true;
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test", name: "Alice" },
                { id: BOB, email: "bob@example.test", name: "Bob" },
                {
                    id: ORG,
                    email: "org@example.test",
                    name: "Organization",
                    role: "org",
                },
            ]);
        await ensureRootFolders(ALICE);
        await ensureRootFolders(BOB);
        await ensureRootFolders(ORG);
        aliceRootId = await rootId(ALICE);
        orgRootId = await rootId(ORG);
        const bobRootId = await rootId(BOB);
        orgFolderId = "share-intent-org-folder";
        secondOrgFolderId = "share-intent-second-org-folder";
        bobFolderId = "share-intent-bob-folder";
        await insertFolder({
            id: orgFolderId,
            userId: ORG,
            parentId: orgRootId,
            name: "Sales",
        });
        await insertFolder({
            id: secondOrgFolderId,
            userId: ORG,
            parentId: orgRootId,
            name: "Support",
        });
        await insertFolder({
            id: bobFolderId,
            userId: BOB,
            parentId: bobRootId,
            name: "Bob's folder",
        });
    });

    const context = (id: string) => ({ params: Promise.resolve({ id }) });

    function panelRequest(path: string, method = "GET", body?: object) {
        return new Request(`https://example.com/${path}`, {
            method,
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
    }

    function writeTranscript(id: string, text: string) {
        return upsertTranscription({
            recordingId: id,
            userId: ALICE,
            provider: "openai",
            model: "sample",
            source: "riffado",
            detectedLanguage: "en",
            text,
            turns: [{ speaker: "speaker_0", startMs: 0, endMs: 5000, text }],
        });
    }

    function folderRequest(method: string, body: object, view = "private") {
        return new Request(`https://example.com/folders?view=${view}`, {
            method,
            body: JSON.stringify(body),
        });
    }

    it("reports private filing, sharing, and both withdrawal responses", async () => {
        const itemId = "folder-write-outcomes";
        await insertAudio(itemId);
        await insertTranscript(itemId);
        const personal = "owner-folder";
        await insertFolder({
            id: personal,
            userId: ALICE,
            parentId: aliceRootId,
            name: "Personal",
        });
        const ctx = context(itemId);
        const before = await file(
            folderRequest("POST", { folderId: personal }),
            ctx,
        );
        expect(await before.json()).toMatchObject({
            assigned: true,
            placement: "filed",
            processing: {
                access: {
                    role: "owner",
                    shared: false,
                    contentView: "private",
                },
            },
        });
        const shared = await move(
            folderRequest("PATCH", {
                fromFolderId: personal,
                toFolderId: orgFolderId,
            }),
            ctx,
        );
        expect(await shared.json()).toMatchObject({
            moved: true,
            placement: "shared",
            processing: {
                access: { role: "owner", shared: true, contentView: "org" },
            },
        });
        for (const [user, role] of [
            [BOB, "member"],
            [ORG, "curator"],
        ]) {
            const projection = await loadPrivateItemProcessing(
                ALICE,
                itemId,
                user,
                "en",
                "org",
            );
            expect(projection?.access).toEqual({
                role,
                shared: true,
                contentView: "org",
            });
        }
        const removed = await unfile(
            folderRequest(
                "DELETE",
                { folderId: orgFolderId, withdraw: true },
                "org",
            ),
            ctx,
        );
        expect(await removed.json()).toMatchObject({
            assigned: false,
            placement: "unshared",
            processing: {
                access: {
                    role: "owner",
                    shared: false,
                    contentView: "private",
                },
            },
        });
        expect(
            await (
                await file(
                    folderRequest("POST", { folderId: orgFolderId }),
                    ctx,
                )
            ).json(),
        ).toMatchObject({
            placement: "shared",
            processing: { access: { shared: true } },
        });
        session.user.id = ORG;
        const withdrawn = await unfile(
            folderRequest(
                "DELETE",
                { organization: true, withdraw: true },
                "org",
            ),
            ctx,
        );
        expect(await withdrawn.json()).toMatchObject({
            shared: false,
            placement: "unshared",
            processing: null,
        });
    });

    it("distinguishes an unchanged refusal, an intended filing and a withheld filing", async () => {
        const itemId = "unfinished-audio";
        await insertAudio(itemId);
        const ctx = context(itemId);
        const request = () => folderRequest("POST", { folderId: orgFolderId });
        const before = await loadPrivateItemProcessing(ALICE, itemId);
        const refused = await file(request(), ctx);
        expect(refused.status).toBe(409);
        expect(await assignments(itemId)).toEqual([]);
        expect(
            (await loadPrivateItemProcessing(ALICE, itemId))?.versions,
        ).toEqual(before?.versions);

        const [profile] = await db()
            .select({
                id: processingProfiles.id,
                version: processingProfiles.version,
            })
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, ORG),
                    eq(processingProfiles.channel, "audio"),
                    eq(processingProfiles.isDefault, true),
                ),
            );
        if (!profile) throw new Error("Organization audio default missing");
        const settings = defaultProfileSettings("audio");
        settings.steps.learn.automatic = true;
        await updateProfile({
            ownerUserId: ORG,
            profileId: profile.id,
            expectedVersion: profile.version,
            settings,
            actor: {
                kind: "local-org",
                actorId: ORG,
                issuer: null,
                subject: null,
                capabilities: new Set(["use"]),
                clientId: null,
                clientPermissions: new Set(),
                verifiedAt: null,
            },
        });
        await db()
            .insert(itemProcessing)
            .values({ itemId, userId: ALICE, view: "private" });

        const intended = await file(request(), ctx);
        expect(await intended.json()).toMatchObject({
            placement: "intended",
            processing: {
                access: { shared: false },
                intents: [{ folderId: orgFolderId }],
            },
        });
        await makeManualOnly(itemId);
        const confirmed = await confirm(folderRequest("POST", {}), ctx);
        expect(await confirmed.json()).toMatchObject({
            placement: "confirmed",
            confirmed: 1,
            processing: {
                access: { shared: false },
                intents: [{ confirmed: true }],
            },
        });
        const cancelled = await cancel(folderRequest("DELETE", {}), {
            params: Promise.resolve({ id: itemId, folderId: orgFolderId }),
        });
        expect(await cancelled.json()).toMatchObject({
            placement: "removed",
            cancelled: true,
            processing: { access: { shared: false }, intents: [] },
        });
        await db()
            .update(recordingFolders)
            .set({ restrictedAt: new Date() })
            .where(eq(recordingFolders.id, orgFolderId));
        await db().insert(restrictedFolderMembers).values({
            folderId: orgFolderId,
            userId: ALICE,
            role: "member",
            addedByUserId: ORG,
        });
        const withheld = await file(request(), ctx);
        expect(await withheld.json()).toMatchObject({
            placement: "withheld",
            processing: {
                access: { shared: false },
                placements: [{ id: orgFolderId, restricted: true }],
            },
        });
    });

    it("returns the committed projection when categorizing", async () => {
        const itemId = "categorized-audio";
        await insertAudio(itemId);
        const response = await categorize(
            new Request("https://example.com/categorize", {
                method: "POST",
                body: JSON.stringify({ folderIds: [orgFolderId] }),
            }),
            context(itemId),
        );
        expect(await response.json()).toMatchObject({
            itemId,
            placement: "categorized",
            placements: [{ folderId: orgFolderId, placement: "intended" }],
            processing: {
                access: { shared: false },
                intents: [{ folderId: orgFolderId }],
            },
        });
    });

    it("reports a committed move if loading its projection throws", async () => {
        const id = "projection-failure";
        await insertAudio(id);
        await insertTranscript(id);
        const parentId = "original-personal-placement";
        await insertFolder({
            id: parentId,
            userId: ALICE,
            parentId: aliceRootId,
            name: "Original",
        });
        expect(
            (
                await file(
                    folderRequest("POST", { folderId: parentId }),
                    context(id),
                )
            ).status,
        ).toBe(200);
        const read = vi
            .spyOn(contentVersions, "loadTranscriptOverlayVersions")
            .mockRejectedValueOnce(new Error("Projection test failure"));
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const response = await move(
                folderRequest("PATCH", {
                    fromFolderId: parentId,
                    toFolderId: orgFolderId,
                }),
                context(id),
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                moved: true,
                placement: "shared",
                removal: "removed",
                processingStale: true,
            });
            expect(await assignments(id)).toEqual([orgFolderId]);
            expect(log).toHaveBeenCalledTimes(1);
            expect(
                (await loadPrivateItemProcessing(ALICE, id))?.access.shared,
            ).toBe(true);
        } finally {
            read.mockRestore();
            log.mockRestore();
        }
    });

    it("reports a pruned parent as unchanged on add, move and categorize", async () => {
        const id = "pruned-parent";
        await insertAudio(id);
        const parentId = "pruned-parent-folder";
        const childId = "retained-child-folder";
        const otherId = "unrelated-folder";
        for (const folder of [
            { id: parentId, parentId: aliceRootId, name: "Parent" },
            { id: childId, parentId, name: "Child" },
            { id: otherId, parentId: aliceRootId, name: "Other" },
        ])
            await insertFolder({ ...folder, userId: ALICE });
        const ctx = context(id);
        for (const folderId of [childId, otherId])
            expect(
                (await file(folderRequest("POST", { folderId }), ctx)).status,
            ).toBe(200);
        const added = await file(
            folderRequest("POST", { folderId: parentId }),
            ctx,
        );
        expect(await added.json()).toMatchObject({
            assigned: true,
            placement: "unchanged",
        });
        expect(await assignments(id)).not.toContain(parentId);
        const moved = await move(
            folderRequest("PATCH", {
                fromFolderId: otherId,
                toFolderId: parentId,
            }),
            ctx,
        );
        expect(await moved.json()).toMatchObject({
            moved: true,
            placement: "unchanged",
            removal: "removed",
        });
        expect(await assignments(id)).toEqual([childId]);
        const categorized = await categorize(
            panelRequest("categorize", "POST", {
                folderIds: [parentId, childId],
            }),
            ctx,
        );
        expect(await categorized.json()).toMatchObject({
            placement: "categorized",
            placements: expect.arrayContaining([
                { folderId: parentId, placement: "unchanged" },
                { folderId: childId, placement: "filed" },
            ]),
        });
        expect(await assignments(id)).toEqual([childId]);
    });

    it("versions an effective default-profile language change on a legacy item", async () => {
        const id = "default-language-version";
        const profileId = "default-language-profile";
        const revisionId = "default-language-revision";
        const ctx = context(id);
        await insertAudio(id);
        const settings = defaultProfileSettings("audio");
        settings.steps.summary.outputLanguage = "en";
        await db()
            .insert(processingProfiles)
            .values({
                id: profileId,
                ownerUserId: ALICE,
                scope: "personal",
                channel: "audio",
                isDefault: true,
                name: encryptText("Audio default"),
                currentRevisionId: revisionId,
            });
        await db()
            .insert(processingProfileRevisions)
            .values({
                id: revisionId,
                profileId,
                settings: encryptText(JSON.stringify(settings)),
            });
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: id,
                userId: ALICE,
                summary: encryptText("English summary"),
                provider: "sample",
                model: "sample",
                outputLanguage: "en",
            });
        const before = await loadPrivateItemProcessing(ALICE, id);
        expect(before).toMatchObject({ legacy: true, profile: null });
        expect(
            await (await language(panelRequest("language"), ctx)).json(),
        ).toMatchObject({ needsResummary: false });
        settings.steps.summary.outputLanguage = "cs";
        await expect(
            updateProfile({
                ownerUserId: ALICE,
                profileId,
                expectedVersion: 1,
                settings,
                actor: {
                    kind: "user",
                    actorId: ALICE,
                    issuer: null,
                    subject: null,
                    capabilities: new Set(["use"]),
                    clientId: null,
                    clientPermissions: new Set(),
                    verifiedAt: null,
                },
            }),
        ).resolves.toMatchObject({ id: profileId });
        const after = await loadPrivateItemProcessing(ALICE, id);
        expect(
            await (await language(panelRequest("language"), ctx)).json(),
        ).toMatchObject({ needsResummary: true });
        expect(after?.versions.language).not.toBe(before?.versions.language);
        expect(after?.versions.summaries).toEqual(before?.versions.summaries);
    });

    it("keeps Learn keys scoped to viewers who can open a review", async () => {
        const id = "learn-version-access";
        await insertAudio(id);
        await insertTranscript(id);
        expect(
            (
                await file(
                    folderRequest("POST", { folderId: orgFolderId }),
                    context(id),
                )
            ).status,
        ).toBe(200);
        const [transcript] = await db()
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, id));
        if (!transcript) throw new Error("Transcript missing");
        await db().insert(learnRuns).values({
            itemId: id,
            userId: ALICE,
            scopeUserId: ORG,
            view: "org",
            trigger: "manual",
            vocabularyVersion: 0,
            status: "ready",
            transcriptionId: transcript.id,
            transcriptRevision: transcript.revision,
        });
        for (const viewer of [ALICE, ORG, BOB]) {
            session.user.id = viewer;
            const response = await review(
                panelRequest("review?view=org&source=riffado"),
                context(id),
            );
            const projection = await loadPrivateItemProcessing(
                ALICE,
                id,
                viewer,
                "en",
                "org",
            );
            expect(response.status).toBe(viewer === BOB ? 403 : 200);
            expect(Object.keys(projection?.versions.learn ?? {})).toEqual(
                viewer === BOB ? [] : ["riffado"],
            );
        }
        session.user.id = ALICE;
        const password = mockEnv.ORG_ACCOUNT_PASSWORD;
        mockEnv.ORG_ACCOUNT_PASSWORD = undefined;
        try {
            expect(
                (
                    await review(
                        panelRequest("review?view=org&source=riffado"),
                        context(id),
                    )
                ).status,
            ).toBe(403);
            expect(
                (await loadPrivateItemProcessing(ALICE, id))?.versions.learn,
            ).toEqual({});
        } finally {
            mockEnv.ORG_ACCOUNT_PASSWORD = password;
        }
    });

    it.each([
        "olderContent",
        "stale",
    ] as const)("changes the summary version when the %s warning changes without a summary write", async (warning) => {
        const id = `summary-warning-${warning}`;
        const ctx = context(id);
        await insertAudio(id);
        await writeTranscript(id, "Paint the door.");
        const [transcript] = await db()
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, id));
        if (!transcript) throw new Error("Transcript missing");
        if (warning === "stale") {
            await db()
                .insert(transcriptCorrections)
                .values({
                    id: "warning-correction",
                    transcriptionId: transcript.id,
                    transcriptRevision: transcript.revision,
                    userId: ALICE,
                    kind: "fix",
                    heard: encryptText("door"),
                    heardHmac: "0".repeat(64),
                    replacement: encryptText("floor"),
                    turnIndex: 0,
                    charStart: 10,
                    charEnd: 14,
                });
        }
        const modelInput = await llmRendering(transcript.id);
        expect(modelInput?.text).toContain(
            warning === "stale" ? "floor" : "door",
        );
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: id,
                userId: ALICE,
                summary: encryptText("Generated summary"),
                provider: "sample",
                model: "sample",
                transcriptionId: transcript.id,
                inputFingerprint:
                    warning === "stale" ? modelInput?.fingerprint : null,
                inputs: {
                    contentId: transcript.id,
                    contentRevision: transcript.revision,
                    contentSourceId: "riffado",
                },
            });
        const read = async () => {
            const response = await summary(
                panelRequest("summary?source=riffado"),
                ctx,
            );
            expect(response.status).toBe(200);
            return response.json();
        };
        const before = await loadPrivateItemProcessing(ALICE, id);
        const rowBefore = await db()
            .select()
            .from(aiEnhancements)
            .where(eq(aiEnhancements.itemId, id));
        expect(await read()).toMatchObject({ [warning]: false });
        if (warning === "olderContent") {
            await writeTranscript(id, "Paint the window.");
        } else {
            await revertCorrection({
                correctionId: "warning-correction",
                transcriptionId: transcript.id,
                userId: ALICE,
                actorUserId: ALICE,
                orgUserId: ORG,
            });
        }
        expect(await read()).toMatchObject({ [warning]: true });
        expect(
            await db()
                .select()
                .from(aiEnhancements)
                .where(eq(aiEnhancements.itemId, id)),
        ).toEqual(rowBefore);
        const after = await loadPrivateItemProcessing(ALICE, id);
        expect(after?.versions.summaries.riffado).not.toBe(
            before?.versions.summaries.riffado,
        );
        expect(after?.versions.item).not.toBe(before?.versions.item);
    });

    it("measures projection wall time on small and large items", async () => {
        const small = "projection-timing-small";
        const large = "projection-timing-large";
        for (const id of [small, large]) {
            await insertAudio(id);
            await insertTranscript(id);
            await db()
                .insert(aiEnhancements)
                .values({
                    itemId: id,
                    userId: ALICE,
                    provider: "sample",
                    model: "sample",
                    summary: encryptText("Sample summary"),
                });
            await db()
                .insert(itemProcessing)
                .values({ itemId: id, userId: ALICE, view: "private" });
        }
        const [transcript] = await db()
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, large));
        if (!transcript) throw new Error("Transcript missing");
        await db()
            .insert(recordingTasks)
            .values(
                Array.from({ length: 500 }, (_, index) => ({
                    itemId: large,
                    userId: ALICE,
                    source: "manual" as const,
                    status: "open" as const,
                    position: index,
                    text: encryptText("Check the notes"),
                })),
            );
        await db()
            .insert(summaryRemarks)
            .values(
                Array.from({ length: 200 }, () => ({
                    itemId: large,
                    userId: ALICE,
                    authorUserId: ALICE,
                    text: encryptText("Add a short example"),
                })),
            );
        await db()
            .insert(transcriptSpeakers)
            .values(
                Array.from({ length: 300 }, (_, index) => ({
                    transcriptionId: transcript.id,
                    userId: ALICE,
                    label: `speaker_${index}`,
                    status: "confirmed" as const,
                    source: "user" as const,
                    markedUnknown: true,
                })),
            );
        await db()
            .insert(transcriptCorrections)
            .values(
                Array.from({ length: 300 }, (_, index) => ({
                    transcriptionId: transcript.id,
                    userId: ALICE,
                    transcriptRevision: transcript.revision,
                    kind: "fix" as const,
                    turnIndex: index,
                    charStart: 0,
                    charEnd: 4,
                    heard: encryptText("door"),
                    heardHmac: "0".repeat(64),
                    replacement: encryptText("floor"),
                })),
            );
        const samples: Record<string, number[]> = { [small]: [], [large]: [] };
        for (let attempt = 0; attempt <= 10; attempt++) {
            for (const id of [small, large]) {
                const start = performance.now();
                const projection = await loadPrivateItemProcessing(ALICE, id);
                const elapsed = performance.now() - start;
                expect(projection?.versions.item).toBeTruthy();
                if (attempt > 0) samples[id]?.push(elapsed);
            }
        }
        const median = (id: string) => {
            const sorted = [...(samples[id] ?? [])].sort((a, b) => a - b);
            return ((sorted[4] + sorted[5]) / 2).toFixed(2);
        };
        console.info(
            `Projection wall time (median of 10) small ${median(small)} ms, large ${median(large)} ms`,
        );
    });

    it("changes the versions of only the affected audio parts", async () => {
        const id = "versioned-audio";
        await insertAudio(id);
        await insertTranscript(id);
        const [transcript] = await db()
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, id));
        if (!transcript) throw new Error("Transcript missing");
        const readVersions = async () => {
            const projection = await loadPrivateItemProcessing(ALICE, id);
            if (!projection) throw new Error("Projection missing");
            return projection.versions;
        };
        let before = await readVersions();
        const change = async (
            expected: string[],
            write: () => Promise<unknown>,
        ) => {
            await write();
            const after = await readVersions();
            expect(after.item).not.toBe(before.item);
            const keys = Object.keys(after) as (keyof typeof after)[];
            expect(
                keys
                    .filter(
                        (key) =>
                            key !== "item" &&
                            JSON.stringify(after[key]) !==
                                JSON.stringify(before[key]),
                    )
                    .sort(),
            ).toEqual([...expected].sort());
            before = after;
        };
        await change(["transcripts"], () =>
            db()
                .update(transcriptions)
                .set({ topics: encryptJsonField({ topics: ["Example"] }) })
                .where(eq(transcriptions.id, transcript.id)),
        );
        await change(["transcripts"], () =>
            db()
                .update(transcriptions)
                .set({ topics: encryptJsonField({ topics: ["Revised"] }) })
                .where(eq(transcriptions.id, transcript.id)),
        );
        await change(["transcripts", "corrections", "speakers"], () =>
            writeTranscript(id, "New words"),
        );
        await change(["summaries", "language"], () =>
            db()
                .insert(aiEnhancements)
                .values({
                    id: "summary-1",
                    itemId: id,
                    userId: ALICE,
                    model: "sample",
                    provider: "sample",
                    transcriptionId: transcript.id,
                    summary: encryptText("A summary"),
                }),
        );
        await change(["summaries", "language"], async () => {
            const response = await saveSummary(
                panelRequest("summary", "PUT", {
                    summary: "Edited summary",
                    keyPoints: ["One point"],
                    revision: 0,
                    summaryId: "summary-1",
                }),
                context(id),
            );
            expect(response.status).toBe(200);
            expect(
                await (
                    await summary(panelRequest("summary"), context(id))
                ).json(),
            ).toMatchObject({ summary: "Edited summary" });
        });
        let remarkId = "";
        await change(["summaries"], async () => {
            const response = await addRemark(
                panelRequest("summary/remarks", "POST", {
                    text: "Please add an example",
                }),
                context(id),
            );
            expect(response.status).toBe(200);
            const body = await response.json();
            remarkId = body.remarks[0].id;
        });
        await change(["summaries"], async () => {
            const response = await removeRemark(
                panelRequest(`summary/remarks?remarkId=${remarkId}`, "DELETE"),
                context(id),
            );
            expect(response.status).toBe(200);
        });
        await change(["language"], async () => {
            const response = await changeLanguage(
                panelRequest("language", "PATCH", { language: "cs" }),
                context(id),
            );
            expect(await response.json()).toMatchObject({
                confirmedLanguage: "cs",
            });
        });
        await change(["title", "language"], () =>
            setItemTitle(db(), {
                id,
                userId: ALICE,
                title: encryptText("Revised title"),
                editedAt: new Date(),
            }),
        );
        await change(["learn"], () =>
            db()
                .insert(learnRuns)
                .values({
                    id: "current-review",
                    itemId: id,
                    transcriptionId: transcript.id,
                    transcriptRevision: transcript.revision + 1,
                    userId: ALICE,
                    scopeUserId: ALICE,
                    view: "private",
                    trigger: "manual",
                    vocabularyVersion: 0,
                    status: "ready",
                }),
        );
        await change(["corrections"], () =>
            db()
                .insert(transcriptCorrections)
                .values({
                    id: "correction-1",
                    transcriptionId: transcript.id,
                    transcriptRevision: transcript.revision + 1,
                    userId: ALICE,
                    kind: "fix",
                    heard: encryptText("word"),
                    heardHmac: "0".repeat(64),
                    replacement: encryptText("words"),
                    turnIndex: 0,
                    charStart: 0,
                    charEnd: 4,
                }),
        );
        await change(["corrections"], () =>
            revertCorrection({
                correctionId: "correction-1",
                transcriptionId: transcript.id,
                userId: ALICE,
                actorUserId: ALICE,
                orgUserId: ORG,
            }),
        );
        await change(["speakers"], async () => {
            await expect(
                changeTranscriptSpeaker({
                    transcriptionId: transcript.id,
                    revision: transcript.revision + 1,
                    userId: ALICE,
                    actorUserId: ALICE,
                    orgUserId: ORG,
                    label: "speaker_0",
                    answer: { kind: "name", displayName: "Jitka Dvořáková" },
                }),
            ).resolves.toEqual(expect.any(String));
        });
        const viewer = await taskViewerById(ALICE);
        await change(["tasks"], () =>
            addTask(viewer, id, {
                status: "proposed",
                text: "Check the notes",
            }),
        );
        await change(["tasks"], () => skipTaskReview(viewer, id));
        await change(["tasks"], async () => {
            await expect(acceptReview(viewer, id)).resolves.toMatchObject({
                accepted: 1,
            });
        });
        await change(["folders"], () => recordIntent(id));
        const [pending] = await db()
            .select({ generation: itemProcessing.requestedGeneration })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, id),
                    eq(itemProcessing.userId, ALICE),
                    eq(itemProcessing.view, "private"),
                ),
            );
        if (!pending) throw new Error("Pending advance missing");
        await change([], async () => {
            const result = await db().transaction((tx) =>
                completeProcessingGenerationInTx(
                    tx,
                    id,
                    "private",
                    ALICE,
                    pending.generation,
                ),
            );
            expect(result).toBe("stable");
        });
        expect(await readVersions()).toEqual(before);
    });

    it("versions Organization content for the owner and hides owner-only rows from members", async () => {
        const id = "shared-content-versions";
        await insertAudio(id);
        await insertTranscript(id);
        expect(
            (
                await file(
                    folderRequest("POST", { folderId: orgFolderId }),
                    context(id),
                )
            ).status,
        ).toBe(200);
        const [transcript] = await db()
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, id));
        if (!transcript) throw new Error("Transcript missing");
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: id,
                userId: ALICE,
                model: "sample",
                provider: "sample",
                transcriptionId: transcript.id,
                summary: encryptText("Sample summary"),
            });
        const owner = () => loadPrivateItemProcessing(ALICE, id);
        const member = () =>
            loadPrivateItemProcessing(ALICE, id, BOB, "en", "org");
        const ownerBefore = (await owner())?.versions;
        const memberBefore = (await member())?.versions;
        const correction = {
            transcriptionId: transcript.id,
            transcriptRevision: transcript.revision,
            kind: "fix" as const,
            heard: encryptText("word"),
            heardHmac: "0".repeat(64),
            replacement: encryptText("words"),
            turnIndex: 0,
            charStart: 0,
            charEnd: 4,
        };
        await db()
            .insert(transcriptCorrections)
            .values({ ...correction, userId: ALICE });
        expect((await owner())?.versions).toEqual(ownerBefore);
        expect((await member())?.versions).toEqual(memberBefore);
        await db()
            .insert(transcriptCorrections)
            .values({ ...correction, userId: ORG });
        const ownerShared = (await owner())?.versions;
        const memberShared = (await member())?.versions;
        expect(ownerShared?.corrections).not.toEqual(ownerBefore?.corrections);
        expect(memberShared?.corrections).toEqual(ownerShared?.corrections);
        await db()
            .insert(summaryRemarks)
            .values({
                itemId: id,
                userId: ALICE,
                authorUserId: ALICE,
                text: encryptText("Add a short example"),
            });
        await db().insert(transcriptSpeakers).values({
            transcriptionId: transcript.id,
            userId: ALICE,
            label: "speaker_0",
            source: "llm",
            status: "suggested",
        });
        const ownerWithDrafts = (await owner())?.versions;
        expect(ownerWithDrafts?.summaries).not.toEqual(ownerShared?.summaries);
        expect(ownerWithDrafts?.speakers).not.toEqual(ownerShared?.speakers);
        expect((await member())?.versions).toEqual(memberShared);
    });

    it("shares mail through the same route and versions its parsed content", async () => {
        const itemId = "versioned-mail";
        await insertMail(itemId);
        await db()
            .insert(mailMessages)
            .values({
                id: itemId,
                userId: ALICE,
                rawHash: "0".repeat(64),
                receivedAt: new Date(),
                sizeBytes: 100,
                auth: {},
                senderVerified: true,
            });
        await db()
            .insert(mailContents)
            .values({
                itemId,
                userId: ALICE,
                parserVersion: 1,
                segments: encryptJsonField([]),
            });
        const read = async (view: string) => {
            const response = await mailDetail(
                new Request(
                    `https://example.com/mail/${itemId}?processing=1&view=${view}`,
                ),
                context(itemId),
            );
            expect(response.status).toBe(200);
            return (await response.json()).processing;
        };
        const before = await read("private");
        expect(before.access).toEqual({
            contentView: "private",
            role: "owner",
            shared: false,
        });
        expect(before.versions.content).toEqual(expect.any(String));
        expect(
            await (
                await file(
                    folderRequest("POST", { folderId: orgFolderId }),
                    context(itemId),
                )
            ).json(),
        ).toMatchObject({
            placement: "shared",
            processing: { access: { shared: true, contentView: "org" } },
        });
        session.user.id = BOB;
        const shared = await read("org");
        expect(shared.access).toEqual({
            contentView: "org",
            role: "member",
            shared: true,
        });
        await expect(
            deleteMailContent(
                itemId,
                ALICE,
                { isOrg: true, orgUserId: ORG },
                new Date(),
            ),
        ).resolves.toBe(true);
        const after = await read("org");
        const {
            content: previousContent,
            item: previousItem,
            ...otherParts
        } = shared.versions;
        expect(previousContent).toEqual(expect.any(String));
        expect(after.versions).toEqual({
            ...otherParts,
            item: expect.any(String),
        });
        expect(after.versions.item).not.toBe(previousItem);
    });

    it("keeps a blocked audio intent, then shares it exactly once", async () => {
        const itemId = "audio-intent";
        await insertAudio(itemId);
        await recordIntent(itemId);

        expect(await executeIntendedShares(ALICE, itemId)).toEqual([
            { kind: "no_transcript" },
        ]);
        expect(await assignments(itemId)).toEqual([]);
        expect(await intents(itemId)).toEqual([orgFolderId]);

        await insertTranscript(itemId);
        expect(await executeIntendedShares(ALICE, itemId)).toEqual([]);
        expect(await assignments(itemId)).toEqual([orgFolderId]);
        expect(await intents(itemId)).toEqual([]);

        expect(await executeIntendedShares(ALICE, itemId)).toEqual([]);
        expect(await assignments(itemId)).toEqual([orgFolderId]);
    });

    it("holds manual-only audio and mail intents until confirmation", async () => {
        for (const kind of ["audio", "mail"] as const) {
            const itemId = `manual-${kind}-intent`;
            if (kind === "audio") {
                await insertAudio(itemId);
                await insertTranscript(itemId);
            } else {
                await insertMail(itemId);
            }
            await recordIntent(itemId);
            await makeManualOnly(itemId);

            await expect(
                executeIntendedSharesWithOutcome(ALICE, itemId),
            ).resolves.toMatchObject({
                shared: false,
                remaining: true,
                confirmationRequired: true,
            });
            expect(await assignments(itemId)).toEqual([]);

            await expect(
                confirmIntendedPlacements(ALICE, itemId),
            ).resolves.toBe(1);
            await expect(
                executeIntendedSharesWithOutcome(ALICE, itemId),
            ).resolves.toMatchObject({
                shared: true,
                remaining: false,
                confirmationRequired: false,
            });
            expect(await assignments(itemId)).toEqual([orgFolderId]);
        }
    });

    it("requires confirmation again when another intent is added", async () => {
        const itemId = "manual-new-intent";
        await insertAudio(itemId);
        await insertTranscript(itemId);
        await recordIntent(itemId);
        await makeManualOnly(itemId);
        await confirmIntendedPlacements(ALICE, itemId);
        await appDb.transaction((tx) =>
            recordIntendedPlacementInTx(tx, {
                canCurate: false,
                ownerUserId: ALICE,
                itemId,
                folderId: secondOrgFolderId,
            }),
        );

        await expect(
            executeIntendedSharesWithOutcome(ALICE, itemId),
        ).resolves.toMatchObject({
            shared: false,
            remaining: true,
            confirmationRequired: true,
        });
        expect(await assignments(itemId)).toEqual([]);

        await expect(confirmIntendedPlacements(ALICE, itemId)).resolves.toBe(1);
        await executeIntendedShares(ALICE, itemId);
        expect(new Set(await assignments(itemId))).toEqual(
            new Set([orgFolderId, secondOrgFolderId]),
        );
    });

    it("presents review counts, job states, and intent confirmation", async () => {
        const itemId = "presentation-details";
        await insertAudio(itemId);
        await insertTranscript(itemId);
        await recordIntent(itemId);
        await makeManualOnly(itemId);
        const [transcript] = await db()
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, itemId),
                    eq(transcriptions.userId, ALICE),
                ),
            );
        const [run] = await db()
            .insert(learnRuns)
            .values({
                userId: ALICE,
                scopeUserId: ALICE,
                itemId,
                transcriptionId: transcript?.id,
                view: "private",
                trigger: "manual",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status: "ready",
            })
            .returning({ id: learnRuns.id });
        await db()
            .insert(learnReviewItems)
            .values(
                ["one", "two"].map((fingerprintHmac) => ({
                    runId: run?.id ?? "",
                    userId: ALICE,
                    kind:
                        fingerprintHmac === "one"
                            ? ("known_fact" as const)
                            : ("fact" as const),
                    fingerprintHmac,
                    payload: {},
                })),
            );
        await db()
            .insert(recordingTasks)
            .values({
                itemId,
                userId: ALICE,
                status: "proposed",
                source: "riffado",
                text: encryptText("Review this task"),
            });
        await db()
            .insert(asyncJobs)
            .values([
                {
                    userId: ALICE,
                    kind: "transcription",
                    subjectId: itemId,
                    status: "pending",
                    payload: {},
                },
                {
                    userId: ALICE,
                    kind: "summary",
                    subjectId: itemId,
                    status: "processing",
                    payload: {},
                },
            ]);

        const waiting = await loadPrivateItemProcessing(ALICE, itemId);
        expect(waiting).toMatchObject({
            learnFindingsWaiting: 1,
            taskReviewWaiting: 1,
            jobs: { transcription: "queued", summary: "running" },
            intents: [
                {
                    folderId: orgFolderId,
                    confirmationRequired: true,
                    confirmed: false,
                },
            ],
        });
        const facts = await gatherFacts(itemId, "private", ALICE, {
            legacyIfEmpty: false,
        });
        expect(facts).toMatchObject({
            learnRunOpen: true,
            learnRunInFlight: false,
            learnRunReadyForReview: true,
        });

        await confirmIntendedPlacements(ALICE, itemId);
        const confirmed = await loadPrivateItemProcessing(ALICE, itemId);
        expect(confirmed?.intents).toEqual([
            expect.objectContaining({
                folderId: orgFolderId,
                confirmationRequired: false,
                confirmed: true,
            }),
        ]);
    });

    it("counts the findings of an Organization-scoped Learn run on a private item", async () => {
        const itemId = "presentation-org-scope";
        await insertAudio(itemId);
        await insertTranscript(itemId);
        const [transcript] = await db()
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, itemId),
                    eq(transcriptions.userId, ALICE),
                ),
            );
        const [run] = await db()
            .insert(learnRuns)
            .values({
                userId: ALICE,
                scopeUserId: ORG,
                itemId,
                transcriptionId: transcript?.id,
                view: "private",
                trigger: "auto",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status: "ready",
            })
            .returning({ id: learnRuns.id });
        await db()
            .insert(learnReviewItems)
            .values(
                ["one", "two", "three"].map((fingerprintHmac) => ({
                    runId: run?.id ?? "",
                    userId: ORG,
                    kind:
                        fingerprintHmac === "one"
                            ? ("known_fact" as const)
                            : ("fact" as const),
                    fingerprintHmac,
                    payload: {},
                })),
            );

        await expect(
            loadPrivateItemProcessing(ALICE, itemId),
        ).resolves.toMatchObject({ learnFindingsWaiting: 2 });
        await expect(
            loadPrivateItemProcessing(BOB, itemId),
        ).resolves.toBeNull();
    });

    it("applies an awaiting-share task proposal its owner may apply when an intended share executes", async () => {
        const targetItemId = "audio-task-target";
        const sourceItemId = "audio-task-source";
        await insertAudio(targetItemId);
        await insertTranscript(targetItemId);
        await recordIntent(targetItemId);
        await expect(
            executeIntendedShares(ALICE, targetItemId),
        ).resolves.toEqual([]);
        const [task] = await db()
            .insert(recordingTasks)
            .values({
                itemId: targetItemId,
                userId: ALICE,
                status: "open",
                source: "manual",
                text: encryptText("Send the release notes"),
            })
            .returning({ id: recordingTasks.id });

        await insertAudio(sourceItemId);
        await insertTranscript(sourceItemId);
        await recordIntent(sourceItemId);
        const [proposal] = await db()
            .insert(taskUpdateProposals)
            .values({
                taskId: task?.id ?? "",
                itemId: sourceItemId,
                userId: ALICE,
                kind: "due",
                dueDate: "2026-10-20",
                state: "awaiting_share",
            })
            .returning({ id: taskUpdateProposals.id });

        await expect(
            executeIntendedShares(ALICE, sourceItemId),
        ).resolves.toEqual([]);
        const [routed] = await db()
            .select({
                state: taskUpdateProposals.state,
                routedTo: taskUpdateProposals.routedTo,
            })
            .from(taskUpdateProposals)
            .where(eq(taskUpdateProposals.id, proposal?.id ?? ""));
        expect(routed).toEqual({ state: "applied", routedTo: null });
    });

    it("shares mail exactly once even with a legacy proposed task", async () => {
        const itemId = "mail-intent";
        await insertMail(itemId);
        await recordIntent(itemId);
        const [proposal] = await db()
            .insert(recordingTasks)
            .values({
                itemId,
                userId: ALICE,
                status: "proposed",
                source: "riffado",
                text: encryptText("Reply to the customer"),
            })
            .returning({ id: recordingTasks.id });

        expect(await executeIntendedShares(ALICE, itemId)).toEqual([]);
        expect(await assignments(itemId)).toEqual([orgFolderId]);
        expect(await intents(itemId)).toEqual([]);

        await db()
            .update(recordingTasks)
            .set({ status: "open" })
            .where(eq(recordingTasks.id, proposal?.id ?? ""));
        expect(await executeIntendedShares(ALICE, itemId)).toEqual([]);
        expect(await assignments(itemId)).toEqual([orgFolderId]);
        expect(await intents(itemId)).toEqual([]);

        expect(await executeIntendedShares(ALICE, itemId)).toEqual([]);
        expect(await assignments(itemId)).toEqual([orgFolderId]);
    });

    it("never shares a cancelled intent", async () => {
        const itemId = "cancelled-audio-intent";
        await insertAudio(itemId);
        await recordIntent(itemId);
        await cancelIntendedPlacement(ALICE, itemId, orgFolderId);
        await insertTranscript(itemId);

        expect(await executeIntendedShares(ALICE, itemId)).toEqual([]);
        expect(await assignments(itemId)).toEqual([]);
        expect(await intents(itemId)).toEqual([]);
        const [processing] = await db()
            .select({ phases: itemProcessing.phases })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, itemId),
                    eq(itemProcessing.userId, ALICE),
                    eq(itemProcessing.view, "private"),
                ),
            );
        expect(processing?.phases.share).toMatchObject({
            state: "skipped",
            reason: "cancelled",
        });
    });

    it("does not share when cancellation commits while Share waits for the Organization tree", async () => {
        const itemId = "concurrent-cancelled-audio-intent";
        await insertAudio(itemId);
        await insertTranscript(itemId);
        await recordIntent(itemId);
        if (!database) throw new Error("test database was not initialized");

        let releaseTreeLock = () => {};
        const release = new Promise<void>((resolve) => {
            releaseTreeLock = resolve;
        });
        let treeLocked = () => {};
        const locked = new Promise<void>((resolve) => {
            treeLocked = resolve;
        });
        const blocker = database.sql.begin(async (sql) => {
            await sql`select pg_advisory_xact_lock(hashtext('riffado:org-tree'))`;
            treeLocked();
            await release;
        });
        await locked;

        const waiting = async () => {
            if (!database) throw new Error("test database was not initialized");
            const [row] = await database.sql<{ waiting: number }[]>`
                select count(*)::int as waiting
                from pg_locks
                where locktype = 'advisory' and not granted
                  and objid = (hashtext('riffado:org-tree')::bigint & 4294967295)
                  and database = (select oid from pg_database where datname = current_database())
            `;
            return row?.waiting ?? 0;
        };
        const cancellation = cancelIntendedPlacement(
            ALICE,
            itemId,
            orgFolderId,
        );
        let sharing:
            | ReturnType<typeof executeIntendedSharesWithOutcome>
            | undefined;
        try {
            await expect.poll(waiting).toBe(1);
            sharing = executeIntendedSharesWithOutcome(ALICE, itemId);
            await expect.poll(waiting).toBe(2);
            releaseTreeLock();
            await Promise.all([blocker, cancellation]);
            await expect(sharing).resolves.toMatchObject({
                shared: false,
                remaining: false,
            });
            expect(await assignments(itemId)).toEqual([]);
            expect(await intents(itemId)).toEqual([]);
        } finally {
            releaseTreeLock();
            await Promise.allSettled([
                blocker,
                cancellation,
                ...(sharing ? [sharing] : []),
            ]);
        }
    });

    it("leaves intents waiting while the Organization is read-only", async () => {
        const itemId = "read-only-org-intent";
        await insertAudio(itemId);
        await insertTranscript(itemId);
        await recordIntent(itemId);
        mockEnv.ORG_ACCOUNT_PASSWORD = undefined;

        try {
            await expect(
                executeIntendedSharesWithOutcome(ALICE, itemId),
            ).resolves.toMatchObject({
                shared: false,
                remaining: true,
            });
        } finally {
            mockEnv.ORG_ACCOUNT_PASSWORD = "organization-password";
        }
        expect(await assignments(itemId)).toEqual([]);
        expect(await intents(itemId)).toEqual([orgFolderId]);
    });

    it("leaves intents waiting when IdP access to the Organization was revoked", async () => {
        const itemId = "revoked-org-intent";
        await insertAudio(itemId);
        await insertTranscript(itemId);
        await recordIntent(itemId);
        mockEnv.AUTHZ_MODE = "idp";
        authzState.holderMayUse = false;

        await expect(
            executeIntendedSharesWithOutcome(ALICE, itemId),
        ).resolves.toMatchObject({ shared: false, remaining: true });
        expect(await assignments(itemId)).toEqual([]);
        expect(await intents(itemId)).toEqual([orgFolderId]);
    });

    it("refuses both roots and another owner's folder", async () => {
        await expect(
            assertCategorizableFolder(ALICE, aliceRootId),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            assertCategorizableFolder(ALICE, orgRootId),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            assertCategorizableFolder(ALICE, bobFolderId),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("allows mail sharing while follow-up proposals still wait for review", async () => {
        const mailId = "mail-follow-up";
        const targetId = "follow-up-target";
        await insertMail(mailId);
        await insertAudio(targetId);
        const [task] = await db()
            .insert(recordingTasks)
            .values({
                itemId: targetId,
                userId: ALICE,
                status: "open",
                source: "manual",
                text: encryptText("Send the draft"),
            })
            .returning({ id: recordingTasks.id });
        const [proposal] = await db()
            .insert(taskUpdateProposals)
            .values({
                taskId: task?.id ?? "",
                itemId: mailId,
                userId: ALICE,
                kind: "done",
            })
            .returning({ id: taskUpdateProposals.id });
        await db()
            .insert(taskMentions)
            .values({
                taskId: task?.id ?? "",
                itemId: mailId,
                userId: ALICE,
                view: "private",
                statementAt: new Date("2026-10-15T10:00:00Z"),
                matchDecision: "suggested",
            });

        const problems = await appDb.transaction((tx) =>
            mailShareProblems(tx, mailId, ALICE),
        );
        expect(problems).toEqual([]);

        for (const state of [
            "awaiting_share",
            "awaiting_target_review",
            "applied",
            "rejected",
            "obsolete",
        ] as const) {
            await db()
                .update(taskUpdateProposals)
                .set({ state })
                .where(eq(taskUpdateProposals.id, proposal?.id ?? ""));
            await db()
                .update(taskMentions)
                .set({ matchDecision: "accepted" })
                .where(eq(taskMentions.itemId, mailId));
            await expect(
                appDb.transaction((tx) => mailShareProblems(tx, mailId, ALICE)),
            ).resolves.toEqual([]);
        }
    });
});
