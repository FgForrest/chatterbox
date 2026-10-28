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
    apiCredentials,
    chatterItems,
    itemProcessing,
    mailContents,
    mailMessages,
    processingProfileRevisions,
    processingProfiles,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import {
    markPhasesOutdatedForProfileChange,
    processAgainPending,
} from "@/lib/pipeline/outdated";
import { readProcessing } from "@/lib/pipeline/state";
import type { PipelinePhases } from "@/lib/pipeline/types";
import {
    defaultProfileSettings,
    type ProfileChannel,
} from "@/lib/profiles/settings";
import { updateTitleAfterSummary } from "@/lib/recordings/title-after-summary";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, createCompletion } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        createCompletion: vi.fn(),
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property: string | symbol) => {
                    if (!ref.current)
                        throw new Error("test database not ready");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "manual-summary-fence-test-secret",
        DATABASE_URL: "postgres://unused",
        MAIL_FORMER_ORG_NICKNAMES: [],
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => null,
    isOrgScopeEnabled: () => false,
    isOrgScopeVisible: () => false,
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(),
    refreshExistingRecordingSidecars: vi.fn(),
}));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: vi.fn() }));
vi.mock("openai", () => ({
    OpenAI: class {
        chat = { completions: { create: createCompletion } };
    },
}));

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const USER = "manual-summary-owner";
const ITEM = "manual-summary-item";
const CONTENT = "manual-summary-content";
const PROFILE = "manual-summary-profile";
const OTHER_PROFILE = "manual-summary-other-profile";
const R1 = "manual-summary-r1";
const R2 = "manual-summary-r2";
const OTHER_REVISION = "manual-summary-other-revision";
const NOW = "2026-10-21T00:00:00.000Z";

function reply(content: string) {
    return {
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
    };
}

describeWithDatabase(
    "manual summary profile revision fencing (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase | null = null;

        function db() {
            if (!database) throw new Error("test database not ready");
            return database.db;
        }

        const processingWhere = and(
            eq(itemProcessing.itemId, ITEM),
            eq(itemProcessing.userId, USER),
            eq(itemProcessing.view, "private"),
        );

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "manual_summary_revision",
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
            await db().delete(users);
            await db()
                .insert(users)
                .values({ id: USER, email: "manual-summary@example.test" });
            await db()
                .insert(apiCredentials)
                .values(
                    ["old-provider", "new-provider"].map((id) => ({
                        id,
                        userId: USER,
                        provider: "openai",
                        apiKey: encrypt("key"),
                        defaultModel: id,
                    })),
                );
            createCompletion.mockReset();
            createCompletion.mockResolvedValue(
                reply(
                    JSON.stringify({
                        summary: "New summary",
                        keyPoints: [],
                        actionItems: [],
                    }),
                ),
            );
        });

        async function seed(channel: ProfileChannel) {
            const settings = defaultProfileSettings(channel);
            settings.steps.tasks.enabled = false;
            settings.steps.title.automatic = true;
            settings.steps.title.provider = {
                credentialId: "old-provider",
                scope: "personal",
            };
            settings.steps.summary.provider = {
                credentialId: "old-provider",
                scope: "personal",
            };
            await db()
                .insert(processingProfiles)
                .values([
                    {
                        id: PROFILE,
                        ownerUserId: USER,
                        scope: "personal",
                        channel,
                        name: encryptText("Profile"),
                        currentRevisionId: R2,
                        isDefault: true,
                    },
                    {
                        id: OTHER_PROFILE,
                        ownerUserId: USER,
                        scope: "personal",
                        channel,
                        name: encryptText("Other"),
                        currentRevisionId: OTHER_REVISION,
                    },
                ]);
            await db()
                .insert(processingProfileRevisions)
                .values([
                    {
                        id: R1,
                        profileId: PROFILE,
                        settings: encryptText(JSON.stringify(settings)),
                    },
                    ...[R2, OTHER_REVISION].map((id) => ({
                        id,
                        profileId: id === R2 ? PROFILE : OTHER_PROFILE,
                        settings: encryptText(
                            JSON.stringify({
                                ...settings,
                                steps: {
                                    ...settings.steps,
                                    summary: {
                                        ...settings.steps.summary,
                                        provider: {
                                            credentialId: "new-provider",
                                            scope: "personal",
                                        },
                                    },
                                },
                            }),
                        ),
                    })),
                ]);
            await db()
                .insert(userSettings)
                .values({
                    userId: USER,
                    ...(channel === "audio"
                        ? { defaultAudioProfileId: PROFILE }
                        : { defaultMailProfileId: PROFILE }),
                });
            if (channel === "audio") {
                await insertRecordings(db(), {
                    id: ITEM,
                    userId: USER,
                    filename: encryptText("Original title"),
                    deviceSn: "device",
                    plaudFileId: ITEM,
                    duration: 1_000,
                    startTime: new Date(NOW),
                    endTime: new Date(NOW),
                    filesize: 10,
                    fileMd5: "0".repeat(32),
                    storageType: "local",
                    storagePath: "manual-summary.mp3",
                    plaudVersion: "1",
                });
                await db()
                    .insert(transcriptions)
                    .values({
                        id: CONTENT,
                        recordingId: ITEM,
                        userId: USER,
                        text: encryptText("Discuss the launch."),
                        source: "riffado",
                        provider: "test",
                        model: "test",
                        revision: 0,
                    });
            } else {
                await db()
                    .insert(chatterItems)
                    .values({
                        id: ITEM,
                        userId: USER,
                        kind: "mail",
                        title: encryptText("Original title"),
                        occurredAt: new Date(NOW),
                    });
                await db()
                    .insert(mailMessages)
                    .values({
                        id: ITEM,
                        userId: USER,
                        rawHash: "0".repeat(64),
                        receivedAt: new Date(NOW),
                        sizeBytes: 10,
                        auth: encryptJsonField({}),
                        senderVerified: true,
                    });
                await db()
                    .insert(mailContents)
                    .values({
                        id: CONTENT,
                        itemId: ITEM,
                        userId: USER,
                        parserVersion: 1,
                        language: "en",
                        segments: encryptJsonField([
                            {
                                id: "s1",
                                role: "body",
                                text: "Discuss the launch.",
                            },
                        ]),
                    });
            }
            const content = {
                contentId: CONTENT,
                contentSourceId: channel === "audio" ? "riffado" : "mail",
                contentRevision: 0,
            };
            const phases: PipelinePhases = {
                categorize: {
                    state: "done",
                    reason: "categorized",
                    generation: 1,
                    at: NOW,
                },
                summary: {
                    state: "pending",
                    reason: "summary",
                    generation: 1,
                    at: NOW,
                    inputs: content,
                    steps: { summary: { ...content, generation: 1 } },
                },
            };
            await db()
                .insert(itemProcessing)
                .values([
                    {
                        itemId: ITEM,
                        userId: USER,
                        view: "private",
                        profileId: PROFILE,
                        profileRevisionId: R1,
                        requestedGeneration: 1,
                        phases,
                    },
                    {
                        itemId: ITEM,
                        userId: USER,
                        view: "org",
                        profileRevisionId: "unrelated-org-revision",
                    },
                ]);
            await db()
                .insert(aiEnhancements)
                .values({
                    itemId: ITEM,
                    userId: USER,
                    transcriptionId: channel === "audio" ? CONTENT : null,
                    summary: encryptText("Old summary"),
                    keyPoints: [],
                    actionItems: [],
                    source: "riffado",
                    provider: "test",
                    model: "test",
                });
            return phases;
        }

        async function storedSummary() {
            const [row] = await db()
                .select()
                .from(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.itemId, ITEM),
                        eq(aiEnhancements.userId, USER),
                        eq(aiEnhancements.source, "riffado"),
                    ),
                );
            return row;
        }

        async function refile() {
            await db()
                .update(itemProcessing)
                .set({
                    profileId: OTHER_PROFILE,
                    profileRevisionId: OTHER_REVISION,
                })
                .where(processingWhere);
        }

        describe.each(["audio", "mail"] as const)("%s", (channel) => {
            it("commits the selected R2, keeps the item on R1, and generates its title", async () => {
                await seed(channel);
                const result = await generateSummaryForRecording(USER, ITEM, {
                    trigger: "manual",
                    profileRevisionId: R2,
                });
                expect(result.committed).toBe(true);
                expect(result.titleFence?.profileRevisionId).toBe(R1);
                const stored = await storedSummary();
                expect(decryptText(stored?.summary)).toBe("New summary");
                expect(stored).toMatchObject({
                    profileRevisionId: R2,
                    model: "new-provider",
                    inputs: { itemProfileRevisionId: R1 },
                });
                expect(
                    (await readProcessing(ITEM, "private", USER))
                        ?.profileRevisionId,
                ).toBe(R1);
                expect(
                    (await readProcessing(ITEM, "private", USER))?.phases
                        .summary,
                ).toMatchObject({ state: "done", reason: "completed" });
                createCompletion.mockResolvedValueOnce(
                    reply("Launch planning"),
                );
                await updateTitleAfterSummary({
                    userId: USER,
                    recordingId: ITEM,
                    summary: result.summary,
                    keyPoints: result.keyPoints,
                    fence: result.titleFence,
                });
                const [item] = await db()
                    .select()
                    .from(chatterItems)
                    .where(
                        and(
                            eq(chatterItems.id, ITEM),
                            eq(chatterItems.userId, USER),
                        ),
                    );
                expect(decryptText(item?.title)).toBe("Launch planning");
                expect(
                    (await readProcessing(ITEM, "private", USER))?.phases
                        .summary?.steps?.title?.state,
                ).toBe("done");
            });

            it("commits a different selected profile as a one-off", async () => {
                await seed(channel);
                const result = await generateSummaryForRecording(USER, ITEM, {
                    trigger: "manual",
                    profileRevisionId: OTHER_REVISION,
                });
                expect(result.committed).toBe(true);
                expect((await storedSummary())?.profileRevisionId).toBe(
                    OTHER_REVISION,
                );
                expect(
                    await readProcessing(ITEM, "private", USER),
                ).toMatchObject({ profileId: PROFILE, profileRevisionId: R1 });
            });

            it("commits a manual default fallback without changing the unavailable assignment", async () => {
                await seed(channel);
                await db()
                    .update(itemProcessing)
                    .set({ profileRevisionId: "unavailable-revision" })
                    .where(processingWhere);
                const result = await generateSummaryForRecording(USER, ITEM, {
                    trigger: "manual",
                });
                expect(result.committed).toBe(true);
                expect((await storedSummary())?.profileRevisionId).toBe(R2);
                expect(result.titleFence?.profileRevisionId).toBe(
                    "unavailable-revision",
                );
                expect(
                    (await readProcessing(ITEM, "private", USER))
                        ?.profileRevisionId,
                ).toBe("unavailable-revision");
            });

            it("discards a run if the item is re-filed to its selected profile during generation", async () => {
                await seed(channel);
                createCompletion.mockImplementationOnce(async () => {
                    await refile();
                    return reply(
                        JSON.stringify({
                            summary: "Stale result",
                            keyPoints: [],
                            actionItems: [],
                        }),
                    );
                });
                const result = await generateSummaryForRecording(USER, ITEM, {
                    trigger: "manual",
                    profileRevisionId: OTHER_REVISION,
                });
                expect(result.committed).toBe(false);
                expect(decryptText((await storedSummary())?.summary)).toBe(
                    "Old summary",
                );
                expect(
                    (await readProcessing(ITEM, "private", USER))?.phases
                        .summary,
                ).toMatchObject({
                    state: "outdated",
                    reason: "profile_changed",
                });
            });

            it("keeps automatic runs on the assigned revision", async () => {
                await seed(channel);
                const result = await generateSummaryForRecording(USER, ITEM, {
                    trigger: "auto",
                });
                expect(result.committed).toBe(true);
                expect(await storedSummary()).toMatchObject({
                    profileRevisionId: R1,
                    model: "old-provider",
                    inputs: { itemProfileRevisionId: R1 },
                });
            });

            it.each([
                false,
                true,
            ])("clears the summary's old profile mark, preserving other outdated phases: %s", async (otherPhases) => {
                const phases = await seed(channel);
                if (otherPhases) {
                    for (const phase of [
                        "transcribe",
                        "learn",
                        "taskReview",
                    ] as const) {
                        phases[phase] = {
                            state: "done",
                            reason: "completed",
                            generation: 1,
                            at: NOW,
                        };
                    }
                }
                const outdated = markPhasesOutdatedForProfileChange(
                    phases,
                    2,
                    NOW,
                );
                await db()
                    .update(itemProcessing)
                    .set({ phases: outdated, requestedGeneration: 2 })
                    .where(processingWhere);
                expect(processAgainPending(outdated)).toBe(true);
                const result = await generateSummaryForRecording(USER, ITEM, {
                    trigger: "manual",
                    profileRevisionId: R1,
                });
                expect(result.committed).toBe(true);
                const processing = await readProcessing(ITEM, "private", USER);
                expect(processing?.phases.summary).toMatchObject({
                    state: "done",
                    reason: "completed",
                    steps: { summary: { state: "done", reason: "generated" } },
                });
                expect(processAgainPending(processing?.phases ?? {})).toBe(
                    otherPhases,
                );
                if (otherPhases) {
                    for (const phase of [
                        "transcribe",
                        "learn",
                        "taskReview",
                    ] as const) {
                        expect(processing?.phases[phase]).toEqual(
                            outdated[phase],
                        );
                    }
                }
            });

            it("keeps the original title fence if the item is re-filed after the summary commits", async () => {
                await seed(channel);
                const result = await generateSummaryForRecording(USER, ITEM, {
                    trigger: "auto",
                });
                expect(result.committed).toBe(true);
                await refile();
                createCompletion.mockResolvedValueOnce(reply("Stale title"));
                await updateTitleAfterSummary({
                    userId: USER,
                    recordingId: ITEM,
                    summary: result.summary,
                    keyPoints: result.keyPoints,
                    fence: result.titleFence,
                });
                const [item] = await db()
                    .select()
                    .from(chatterItems)
                    .where(
                        and(
                            eq(chatterItems.id, ITEM),
                            eq(chatterItems.userId, USER),
                        ),
                    );
                expect(decryptText(item?.title)).toBe("Original title");
            });
        });
    },
);
