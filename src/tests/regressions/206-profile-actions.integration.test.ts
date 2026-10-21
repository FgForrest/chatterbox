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
import { profileHistoryReferences } from "@/db/queries/profile-history";
import {
    aiEnhancements,
    asyncJobs,
    chatterItems,
    itemProcessing,
    learnRuns,
    mailMessages,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    transcriptions,
    users,
} from "@/db/schema";
import type { ActorContext } from "@/lib/authz/model";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, state, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property: string | symbol) => {
                    if (!ref.current)
                        throw new Error("Test database is not ready");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        state: { viewerId: "profile-review-member" },
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            AUTHZ_MODE: "local",
            ORG_ACCOUNT_EMAIL: "profile-review-org@example.test",
            ORG_ACCOUNT_PASSWORD: "test-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});
vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({
        user: { id: state.viewerId, email: `${state.viewerId}@example.test` },
    })),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));

import { GET as getMail } from "@/app/api/mail/[id]/route";
import { GET as getRecording } from "@/app/api/recordings/[id]/route";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { ensureOrgAccount } from "@/lib/org/account";
import { loadPrivateCategorizationPanel } from "@/lib/pipeline/categorization-presentation";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import {
    archiveProfile,
    createProfile,
    deletePersonalProfile,
    getDefaultProfileState,
    getProfile,
    restoreProfile,
} from "@/lib/profiles/store";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const OWNER = "profile-review-owner";
const MEMBER = "profile-review-member";
const AUDIO = "profile-review-audio";
const MAIL = "profile-review-mail";
const actor: ActorContext = {
    kind: "user",
    actorId: OWNER,
    issuer: null,
    subject: null,
    capabilities: new Set(["use"]),
    clientId: null,
    clientPermissions: new Set(),
    verifiedAt: null,
};

describeWithDatabase("PR 206 profile review regressions", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let orgRootId = "";
    function db() {
        if (!database) throw new Error("Test database is not ready");
        return database.db;
    }
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "profile_review",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        await db().delete(asyncJobs);
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: `${OWNER}@example.test` },
                { id: MEMBER, email: `${MEMBER}@example.test` },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        const [root] = await db()
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        orgRootId = root?.id ?? "";
        await insertRecordings(db(), {
            id: AUDIO,
            userId: OWNER,
            deviceSn: "SN",
            plaudFileId: "profile-review",
            filename: encryptText("Recording"),
            duration: 1000,
            startTime: new Date(),
            endTime: new Date(),
            filesize: 0,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: "review.mp3",
            plaudVersion: "1",
        });
        await db()
            .insert(chatterItems)
            .values({
                id: MAIL,
                userId: OWNER,
                kind: "mail",
                title: encryptText("Mail"),
                occurredAt: new Date(),
            });
        await db().insert(mailMessages).values({
            id: MAIL,
            userId: OWNER,
            rawHash: "profile-review-hash",
            receivedAt: new Date(),
            sizeBytes: 100,
            auth: {},
            senderVerified: true,
        });
    });

    it.each([
        ["audio", "en", "cs-CZ", "deleted"],
        ["audio", "cs-CZ", "en", "smazaný"],
        ["mail", "en", "cs-CZ", "deleted"],
        ["mail", "cs-CZ", "en", "smazaný"],
    ] as const)("localizes a shared %s profile marker for the %s viewer rather than its %s owner", async (kind, viewerLocale, ownerLocale, marker) => {
        state.viewerId = MEMBER;
        await db()
            .update(users)
            .set({ uiLocale: viewerLocale })
            .where(eq(users.id, MEMBER));
        await db()
            .update(users)
            .set({ uiLocale: ownerLocale })
            .where(eq(users.id, OWNER));
        const source = await createProfile({
            ownerUserId: OWNER,
            actor,
            scope: "personal",
            channel: kind,
            name: "History",
            settings: defaultProfileSettings(kind),
        });
        const itemId = kind === "audio" ? AUDIO : MAIL;
        await db()
            .insert(itemProcessing)
            .values({
                itemId,
                userId: OWNER,
                view: "private",
                profileId: source.id,
                profileRevisionId: source.currentRevisionId,
                phases: {
                    categorize: {
                        state: "done",
                        reason: "categorized",
                        generation: 1,
                        at: new Date().toISOString(),
                    },
                },
            });
        await db()
            .insert(recordingFolderAssignments)
            .values({ userId: OWNER, itemId, folderId: orgRootId });
        await expect(
            deletePersonalProfile({
                ownerUserId: OWNER,
                profileId: source.id,
                actor,
            }),
        ).resolves.toEqual({ disposition: "tombstone" });
        const handler = kind === "audio" ? getRecording : getMail;
        const response = await handler(
            new Request(
                `https://example.test/api/${kind === "audio" ? "recordings" : "mail"}/${itemId}?view=org&processing=1`,
            ),
            { params: Promise.resolve({ id: itemId }) },
        );
        expect(response.status).toBe(200);
        expect((await response.json()).processing.profile.name).toBe(
            `History (${marker})`,
        );
        const panel = await loadPrivateCategorizationPanel(
            OWNER,
            itemId,
            MEMBER,
        );
        expect(panel?.currentProfile?.name).toBe(`History (${marker})`);
        expect(panel?.resolution).toMatchObject({
            status: "resolved",
            profile: { name: `History (${marker})` },
        });
    });

    it("restores a formerly default profile without making it the default again", async () => {
        const source = await createProfile({
            ownerUserId: OWNER,
            actor,
            scope: "personal",
            channel: "audio",
            name: "Former default",
            settings: defaultProfileSettings("audio"),
            isDefault: true,
        });
        const input = { ownerUserId: OWNER, profileId: source.id, actor };
        await expect(archiveProfile(input)).resolves.toBe(true);
        await expect(restoreProfile(input)).resolves.toBe(true);
        await expect(
            getProfile(OWNER, source.id, OWNER),
        ).resolves.toMatchObject({
            id: source.id,
            archivedAt: null,
            isDefault: false,
        });
        const defaults = await getDefaultProfileState(OWNER, "audio");
        expect(defaults.source).toBe("organization");
        expect(defaults.effective?.ownerUserId).toBe(orgUserId);
        expect(defaults.effective?.id).not.toBe(source.id);
    });

    it.each([
        "none",
        "assignment",
        "item_revision",
        "phase",
        "phase_step",
        "transcription",
        "enhancement",
        "learn",
        "topics",
        "job",
        "transcription_inputs",
        "enhancement_inputs",
        "learn_inputs",
    ] as const)("uses only the %s reference branch to choose tombstoning versus physical deletion", async (reference) => {
        const source = await createProfile({
            ownerUserId: OWNER,
            actor,
            scope: "personal",
            channel: "audio",
            name: "Isolated history",
            settings: defaultProfileSettings("audio"),
        });
        const revisionId = source.currentRevisionId;
        if (!revisionId) throw new Error("Missing revision");
        if (
            ["assignment", "item_revision", "phase", "phase_step"].includes(
                reference,
            )
        ) {
            await db()
                .insert(itemProcessing)
                .values({
                    itemId: AUDIO,
                    userId: OWNER,
                    view: "private",
                    profileId: reference === "assignment" ? source.id : null,
                    profileRevisionId:
                        reference === "item_revision" ? revisionId : null,
                    phases:
                        reference === "phase" || reference === "phase_step"
                            ? {
                                  summary: {
                                      state: "done",
                                      generation: 1,
                                      at: new Date().toISOString(),
                                      ...(reference === "phase"
                                          ? { profileRevisionId: revisionId }
                                          : {
                                                steps: {
                                                    topics: {
                                                        contentId: "content",
                                                        contentRevision: 1,
                                                        generation: 1,
                                                        profileRevisionId:
                                                            revisionId,
                                                    },
                                                },
                                            }),
                                  },
                              }
                            : {},
                });
        }
        if (
            ["transcription", "topics", "transcription_inputs"].includes(
                reference,
            )
        ) {
            await db()
                .insert(transcriptions)
                .values({
                    userId: OWNER,
                    recordingId: AUDIO,
                    text: encryptText("Transcript"),
                    provider: "test",
                    model: "test",
                    profileRevisionId:
                        reference === "transcription" ? revisionId : null,
                    topics:
                        reference === "topics"
                            ? encryptJsonField({
                                  profileRevisionId: revisionId,
                              })
                            : null,
                    inputs:
                        reference === "transcription_inputs"
                            ? { itemProfileRevisionId: revisionId }
                            : null,
                });
        }
        if (reference === "enhancement" || reference === "enhancement_inputs") {
            await db()
                .insert(aiEnhancements)
                .values({
                    itemId: AUDIO,
                    userId: OWNER,
                    provider: "test",
                    model: "test",
                    summary: encryptText("Summary"),
                    profileRevisionId:
                        reference === "enhancement" ? revisionId : null,
                    inputs:
                        reference === "enhancement_inputs"
                            ? { itemProfileRevisionId: revisionId }
                            : null,
                });
        }
        if (reference === "learn" || reference === "learn_inputs") {
            await db()
                .insert(learnRuns)
                .values({
                    itemId: AUDIO,
                    userId: OWNER,
                    scopeUserId: OWNER,
                    view: "private",
                    trigger: "manual",
                    transcriptRevision: 1,
                    vocabularyVersion: 1,
                    profileRevisionId:
                        reference === "learn" ? revisionId : null,
                    inputs:
                        reference === "learn_inputs"
                            ? { itemProfileRevisionId: revisionId }
                            : null,
                });
        }
        if (reference === "job") {
            await db()
                .insert(asyncJobs)
                .values({
                    userId: MEMBER,
                    kind: "summary",
                    subjectId: AUDIO,
                    payload: { profileRevisionId: revisionId },
                    status: "pending",
                });
        }
        expect(await profileHistoryReferences(db(), OWNER, source.id)).toBe(
            reference !== "none",
        );
        await expect(
            deletePersonalProfile({
                ownerUserId: OWNER,
                profileId: source.id,
                actor,
            }),
        ).resolves.toEqual({
            disposition: reference === "none" ? "delete" : "tombstone",
        });
        const rows = await db()
            .select()
            .from(processingProfiles)
            .where(eq(processingProfiles.id, source.id));
        const revisions = await db()
            .select()
            .from(processingProfileRevisions)
            .where(eq(processingProfileRevisions.profileId, source.id));
        if (reference === "none") {
            expect(rows).toEqual([]);
            expect(revisions).toEqual([]);
        } else {
            expect(rows[0]?.deletedAt).toBeInstanceOf(Date);
            expect(revisions.map((revision) => revision.id)).toEqual([
                revisionId,
            ]);
        }
    });
});
