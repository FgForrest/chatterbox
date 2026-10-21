import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { POST as categorize } from "@/app/api/recordings/[id]/categorize/route";
import { listProviderRecoveryRowsInTx } from "@/db/queries/pipeline";
import { profileHistoryReferences } from "@/db/queries/profile-history";
import * as revisionGuard from "@/db/queries/profile-revision-guard";
import {
    aiEnhancements,
    asyncJobs,
    chatterItems,
    folderDefaultProfiles,
    itemProcessing,
    learnRuns,
    mailContents,
    mailMessages,
    mailPendingShares,
    people,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    taskMentions,
    transcriptions,
    transcriptSpeakers,
    userAccessStates,
    users,
} from "@/db/schema";
import { generateTitleFromTranscription } from "@/lib/ai/generate-title";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import {
    addRecordingToFolder,
    moveRecordingBetweenFolders,
    unshareRecording,
} from "@/lib/folders/folders";
import { changeTranscriptSpeaker } from "@/lib/knowledge/speaker-changes";
import { ensureOrgAccount } from "@/lib/org/account";
import { gatherFacts } from "@/lib/pipeline/facts";
import { pipelineMayQueue } from "@/lib/pipeline/pending";
import { planAdvance } from "@/lib/pipeline/plan";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";
import {
    confirmIntendedPlacements,
    executeIntendedSharesWithOutcome,
} from "@/lib/pipeline/share-intent";
import { readProcessing, updatePhaseInTx } from "@/lib/pipeline/state";
import type { PipelinePhases } from "@/lib/pipeline/types";
import { bindPlacementProfileInTx } from "@/lib/profiles/placement-binding";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import { resolveManualItemProfile } from "@/lib/profiles/resolve-manual";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { storeGeneratedTitle } from "@/lib/recordings/generated-title";
import { taskFingerprint } from "@/lib/tasks/proposals";
import { upsertEnhancement } from "@/lib/transcription/persist";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const mocks = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        ref,
        create: vi.fn(),
        db: new Proxy(
            {},
            {
                get: (_target, property) => {
                    const value = ref.current?.[property];
                    if (!ref.current)
                        throw new Error("database not initialized");
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        env: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            AUTHZ_MODE: "local",
            AUTHZ_VERIFICATION_MAX_AGE: 600,
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "test-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});
vi.mock("@/db", () => ({ db: mocks.db, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "owner-zava" } }),
}));
vi.mock("openai", () => ({
    OpenAI: function OpenAI() {
        return { chat: { completions: { create: mocks.create } } };
    },
}));
vi.mock("@/lib/ai/usage-cost", () => ({
    recordChatCompletionUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/profiles/providers", () => ({
    validateProfileProviderPins: vi.fn(),
    resolveStepProvider: vi.fn().mockResolvedValue({
        kind: "credential",
        credential: {
            id: "test-credential",
            provider: "OpenAI",
            apiKey: "test",
            defaultModel: "test-model",
        },
        payerUserId: "owner-zava",
        reserveCall: vi.fn().mockResolvedValue(undefined),
    }),
    resolveStepProviderSelection: vi
        .fn()
        .mockResolvedValue({ kind: "credential" }),
}));

const databaseUrl = getTestDatabaseUrl();
const OWNER = "owner-zava";
const CURATOR = "curator-noren";
const MEMBER = "member-velko";
const ITEM = "owner-shared-item";
const TRANSCRIPT = "owner-shared-transcript";
const PERSONAL = "personal-profile";
const ORG_PROFILE = "organization-profile";
const OTHER_PROFILE = "other-organization-profile";
const at = new Date("2026-10-15T10:00:00Z");
const content = {
    contentId: TRANSCRIPT,
    contentSourceId: "riffado",
    contentRevision: 0,
};

(databaseUrl ? describe : describe.skip)(
    "#221 shared owner pipeline (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase;
        let orgUserId: string;
        const db = () => database.db;

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                databaseUrl ?? "",
                "owner_shared_phase1",
            );
            mocks.ref.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
        }, 120_000);
        afterAll(async () => {
            mocks.ref.current = null;
            await database?.dispose();
        }, 30_000);

        async function profile(
            id: string,
            ownerUserId: string,
            isDefault = false,
        ) {
            const settings = defaultProfileSettings("audio");
            settings.steps.summary.automatic = true;
            settings.steps.topics.automatic = true;
            settings.steps.learn.automatic = false;
            settings.steps.title.automatic = false;
            await db()
                .insert(processingProfiles)
                .values({
                    id,
                    ownerUserId,
                    scope: ownerUserId === OWNER ? "personal" : "organization",
                    channel: "audio",
                    name: encryptText(id),
                    isDefault,
                    currentRevisionId: `${id}-rev`,
                });
            await db()
                .insert(processingProfileRevisions)
                .values({
                    id: `${id}-rev`,
                    profileId: id,
                    settings: encryptText(JSON.stringify(settings)),
                });
        }

        function phases(): PipelinePhases {
            return {
                categorize: {
                    state: "done",
                    reason: "categorized",
                    profileChoice: "placement",
                    generation: 1,
                    at: at.toISOString(),
                },
                transcribe: {
                    state: "done",
                    reason: "content-available",
                    generation: 1,
                    at: at.toISOString(),
                    inputs: content,
                    profileRevisionId: `${PERSONAL}-rev`,
                },
                learn: {
                    state: "done",
                    reason: "review_finished",
                    generation: 1,
                    at: at.toISOString(),
                    inputs: content,
                },
                summary: {
                    state: "waiting",
                    reason: "speakers",
                    generation: 1,
                    at: at.toISOString(),
                    inputs: content,
                },
            };
        }

        beforeEach(async () => {
            mocks.create.mockResolvedValue({
                choices: [{ message: { content: "Shared planning" } }],
            });
            await db().delete(users);
            await db()
                .insert(users)
                .values([
                    { id: OWNER, email: "zava@example.test" },
                    { id: CURATOR, email: "noren@example.test" },
                    { id: MEMBER, email: "velko@example.test" },
                ]);
            orgUserId = (await ensureOrgAccount()) ?? "";
            await profile(PERSONAL, OWNER, true);
            await profile(ORG_PROFILE, orgUserId);
            await profile(OTHER_PROFILE, orgUserId);
            await db()
                .insert(recordingFolders)
                .values([
                    {
                        id: "org-parent",
                        userId: orgUserId,
                        parentId: (
                            await db()
                                .select()
                                .from(recordingFolders)
                                .where(eq(recordingFolders.userId, orgUserId))
                        )[0]?.id,
                        kind: "custom",
                        name: encryptText("Projects"),
                        nameHash: "parent",
                    },
                    {
                        id: "private-root",
                        userId: OWNER,
                        kind: "private",
                        name: encryptText("Private"),
                        nameHash: "private-root",
                    },
                ]);
            await db()
                .insert(recordingFolders)
                .values([
                    {
                        id: "org-child",
                        userId: orgUserId,
                        parentId: "org-parent",
                        kind: "custom",
                        name: encryptText("Planning"),
                        nameHash: "child",
                    },
                    {
                        id: "org-other",
                        userId: orgUserId,
                        parentId: "org-parent",
                        kind: "custom",
                        name: encryptText("Delivery"),
                        nameHash: "other",
                    },
                ]);
            await db()
                .insert(folderDefaultProfiles)
                .values([
                    {
                        folderId: "org-parent",
                        channel: "audio",
                        profileId: ORG_PROFILE,
                    },
                    {
                        folderId: "org-other",
                        channel: "audio",
                        profileId: OTHER_PROFILE,
                    },
                ]);
            await insertRecordings(db(), {
                id: ITEM,
                userId: OWNER,
                deviceSn: "SN-1",
                plaudFileId: "file-1",
                filename: encryptText("Planning"),
                duration: 1000,
                startTime: at,
                endTime: at,
                filesize: 1,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${OWNER}/audio.mp3`,
                plaudVersion: "1",
            });
            await db()
                .insert(transcriptions)
                .values({
                    id: TRANSCRIPT,
                    recordingId: ITEM,
                    userId: OWNER,
                    source: "riffado",
                    provider: "test",
                    model: "test",
                    text: encryptText("speaker_0: We will send the notes."),
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 1000,
                            text: "We will send the notes.",
                        },
                    ]),
                });
            const [person] = await db()
                .insert(people)
                .values({
                    userId: OWNER,
                    displayName: encryptText("Zava Noren"),
                })
                .returning();
            await db().insert(transcriptSpeakers).values({
                userId: OWNER,
                transcriptionId: TRANSCRIPT,
                label: "speaker_0",
                personId: person?.id,
                source: "user",
                status: "confirmed",
                confirmedByUserId: OWNER,
            });
            await db()
                .insert(itemProcessing)
                .values({
                    itemId: ITEM,
                    userId: OWNER,
                    view: "private",
                    profileId: PERSONAL,
                    profileRevisionId: `${PERSONAL}-rev`,
                    requestedGeneration: 1,
                    phases: phases(),
                });
        });

        const share = (folderId = "org-child") =>
            addRecordingToFolder({
                userId: OWNER,
                recordingId: ITEM,
                folderId,
            });
        const resolved = (step: "summary" | "topics") =>
            resolveItemProfile(ITEM, "private", OWNER, OWNER, step);

        it("uses the inherited Organization profile for pending steps without touching the transcript", async () => {
            const before = await db()
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.id, TRANSCRIPT));
            const old = await readProcessing(ITEM, "private", OWNER);
            await share();
            expect((await resolved("summary")).revisionId).toBe(
                `${ORG_PROFILE}-rev`,
            );
            expect(
                await profileHistoryReferences(db(), orgUserId, ORG_PROFILE),
            ).toBe(true);
            expect((await resolved("topics")).revisionId).toBe(
                `${ORG_PROFILE}-rev`,
            );
            expect(
                await db()
                    .select()
                    .from(transcriptions)
                    .where(eq(transcriptions.id, TRANSCRIPT)),
            ).toEqual(before);
            const current = await readProcessing(ITEM, "private", OWNER);
            expect(current?.phases.transcribe).toEqual(old?.phases.transcribe);
            expect(current?.phases.summary).toEqual(old?.phases.summary);
            const plan = planAdvance(await gatherFacts(ITEM, "private", OWNER));
            expect(plan.actions).toContainEqual({
                type: "queueSummary",
                presetId: null,
                strict: true,
            });
            expect(
                plan.actions.some((action) => action.type === "queueTopics"),
            ).toBe(true);
        });

        it("finishes a running summary on the old profile and uses the new profile for topics", async () => {
            const started = phases();
            started.summary = {
                ...started.summary,
                state: "running",
                generation: 1,
                at: at.toISOString(),
                inputs: content,
                steps: {
                    summary: {
                        ...content,
                        generation: 1,
                        state: "running",
                        profileRevisionId: `${PERSONAL}-rev`,
                    },
                },
            };
            await db()
                .update(itemProcessing)
                .set({ phases: started })
                .where(eq(itemProcessing.itemId, ITEM));
            await db()
                .insert(asyncJobs)
                .values({
                    id: "running-summary",
                    userId: OWNER,
                    subjectId: ITEM,
                    kind: "summary",
                    payload: { recordingId: ITEM, trigger: "auto" },
                    status: "processing",
                });
            await share();
            expect((await resolved("summary")).revisionId).toBe(
                `${PERSONAL}-rev`,
            );
            expect((await resolved("topics")).revisionId).toBe(
                `${ORG_PROFILE}-rev`,
            );
            await expect(
                upsertEnhancement({
                    userId: OWNER,
                    recordingId: ITEM,
                    transcriptionId: TRANSCRIPT,
                    summary: "Send the notes.",
                    keyPoints: [],
                    actionItems: [],
                    provider: "test",
                    model: "test",
                    source: "riffado",
                    jobId: "running-summary",
                    profileRevisionId: `${PERSONAL}-rev`,
                    inputs: {
                        ...content,
                        itemProfileRevisionId: `${PERSONAL}-rev`,
                    },
                    tasks: {
                        source: "riffado",
                        reviewer: {
                            userId: OWNER,
                            emailHash: "",
                            isOrg: false,
                            isCurator: false,
                            orgUserId,
                        },
                        fingerprintOf: taskFingerprint,
                        updates: [],
                        tasks: [
                            {
                                text: "Send the notes",
                                fingerprint: taskFingerprint("Send the notes"),
                                assigneePersonId: null,
                                assigneeHint: null,
                                assigneeCheck: false,
                                dueDate: null,
                                duePhrase: null,
                                quote: null,
                                evidenceStartMs: null,
                            },
                        ],
                    },
                }),
            ).resolves.toEqual({ committed: true });
            expect(
                (await readProcessing(ITEM, "private", OWNER))?.phases.summary
                    ?.steps?.summary?.state,
            ).toBe("done");
            expect(
                await db()
                    .select({ view: taskMentions.view })
                    .from(taskMentions),
            ).toEqual([{ view: "org" }]);
        });

        it("restores pending steps on withdrawal and follows another Organization folder", async () => {
            await share();
            await moveRecordingBetweenFolders({
                userId: CURATOR,
                recordingId: ITEM,
                fromFolderId: "org-child",
                toFolderId: "org-other",
            });
            expect((await resolved("topics")).revisionId).toBe(
                `${OTHER_PROFILE}-rev`,
            );
            await unshareRecording(OWNER, ITEM, { withdraw: true });
            expect((await resolved("summary")).revisionId).toBe(
                `${PERSONAL}-rev`,
            );
            expect((await resolved("topics")).revisionId).toBe(
                `${PERSONAL}-rev`,
            );
        });

        it("keeps an explicit personal profile choice", async () => {
            const chosen = phases();
            if (chosen.categorize) chosen.categorize.profileChoice = "manual";
            await db()
                .update(itemProcessing)
                .set({ phases: chosen })
                .where(eq(itemProcessing.itemId, ITEM));
            await share();
            expect((await resolved("summary")).revisionId).toBe(
                `${PERSONAL}-rev`,
            );
        });

        it("rebinds an unclassified choice matching today's automatic default", async () => {
            const chosen = phases();
            if (chosen.categorize) delete chosen.categorize.profileChoice;
            await db()
                .update(itemProcessing)
                .set({ phases: chosen })
                .where(eq(itemProcessing.itemId, ITEM));
            await share();
            expect((await resolved("summary")).revisionId).toBe(
                `${ORG_PROFILE}-rev`,
            );
        });

        it("keeps an unclassified hand pick that differs from today's default", async () => {
            const chosen = phases();
            if (chosen.categorize) delete chosen.categorize.profileChoice;
            await db()
                .update(processingProfiles)
                .set({ isDefault: false })
                .where(eq(processingProfiles.id, PERSONAL));
            await profile("another-personal", OWNER, true);
            await db()
                .update(itemProcessing)
                .set({ phases: chosen })
                .where(eq(itemProcessing.itemId, ITEM));
            await share();
            expect((await resolved("summary")).revisionId).toBe(
                `${PERSONAL}-rev`,
            );
        });

        it("leaves the binding alone when no folder or Organization default resolves", async () => {
            await db().delete(folderDefaultProfiles);
            await share();
            expect((await resolved("summary")).revisionId).toBe(
                `${PERSONAL}-rev`,
            );
        });

        it("uses the Organization account default when the folder has none", async () => {
            await db().delete(folderDefaultProfiles);
            await db()
                .update(processingProfiles)
                .set({ isDefault: true })
                .where(eq(processingProfiles.id, ORG_PROFILE));
            await share();
            expect((await resolved("summary")).revisionId).toBe(
                `${ORG_PROFILE}-rev`,
            );
        });

        it.each([
            "curator",
            "organization",
        ])("advances the private row after a %s speaker rename", async (actor) => {
            await share();
            const previous = await readProcessing(ITEM, "private", OWNER);
            const actorUserId = actor === "curator" ? CURATOR : orgUserId;
            const personId = await changeTranscriptSpeaker({
                userId: OWNER,
                transcriptionId: TRANSCRIPT,
                revision: 0,
                label: "speaker_0",
                answer: { kind: "name", displayName: "Velko Taren" },
                actorUserId,
                orgUserId,
                actsForOrganization: true,
            });
            const current = await readProcessing(ITEM, "private", OWNER);
            expect(current?.requestedGeneration).toBe(
                (previous?.requestedGeneration ?? 0) + 1,
            );
            expect(
                await db()
                    .select()
                    .from(itemProcessing)
                    .where(
                        and(
                            eq(itemProcessing.itemId, ITEM),
                            eq(itemProcessing.view, "org"),
                        ),
                    ),
            ).toEqual([]);
            expect(
                await db()
                    .select({ userId: people.userId })
                    .from(people)
                    .where(eq(people.id, personId ?? "")),
            ).toEqual([{ userId: orgUserId }]);
            const plan = planAdvance(await gatherFacts(ITEM, "private", OWNER));
            const summary = plan.actions.find(
                (action) =>
                    action.type === "markPhase" && action.phase === "summary",
            );
            expect(summary).toBeDefined();
            if (summary?.type === "markPhase")
                await db().transaction((tx) =>
                    updatePhaseInTx(
                        tx,
                        ITEM,
                        "private",
                        OWNER,
                        "summary",
                        summary.record,
                    ),
                );
            expect(
                (await readProcessing(ITEM, "private", OWNER))?.phases.summary
                    ?.state,
            ).toBe("pending");
        });

        it("preserves a queued summary's original profile until its job settles", async () => {
            await db()
                .insert(asyncJobs)
                .values({
                    id: "queued-summary",
                    userId: OWNER,
                    subjectId: ITEM,
                    kind: "summary",
                    payload: { recordingId: ITEM, trigger: "auto" },
                });
            await share();
            expect((await resolved("summary")).revisionId).toBe(
                `${PERSONAL}-rev`,
            );
            await db()
                .update(asyncJobs)
                .set({ status: "completed" })
                .where(eq(asyncJobs.id, "queued-summary"));
            expect((await resolved("summary")).revisionId).toBe(
                `${ORG_PROFILE}-rev`,
            );
        });

        it.each([
            false,
            true,
        ])("keeps finished summary and topics settled across sharing (manual-only: %s)", async (manualOnly) => {
            if (manualOnly) {
                await db()
                    .update(processingProfiles)
                    .set({ isDefault: true })
                    .where(eq(processingProfiles.id, ORG_PROFILE));
                await db()
                    .update(folderDefaultProfiles)
                    .set({ manualOnly: true, profileId: null })
                    .where(eq(folderDefaultProfiles.folderId, "org-parent"));
            }
            const finished = phases();
            finished.summary = {
                state: "done",
                reason: "completed",
                generation: 1,
                at: at.toISOString(),
                inputs: content,
                steps: {
                    summary: {
                        ...content,
                        generation: 1,
                        state: "done",
                        profileRevisionId: `${PERSONAL}-rev`,
                    },
                    topics: {
                        ...content,
                        generation: 1,
                        state: "done",
                        profileRevisionId: `${PERSONAL}-rev`,
                    },
                },
            };
            await db()
                .update(itemProcessing)
                .set({ phases: finished })
                .where(eq(itemProcessing.itemId, ITEM));
            await share();
            expect(
                (await readProcessing(ITEM, "private", OWNER))?.phases.summary,
            ).toEqual(finished.summary);
            const plan = planAdvance(await gatherFacts(ITEM, "private", OWNER));
            expect(
                plan.actions.filter(
                    (action) =>
                        action.type === "queueSummary" ||
                        action.type === "queueTopics",
                ),
            ).toEqual([]);
        });

        it("preserves completed legacy content when sharing first creates the driving row", async () => {
            await db()
                .delete(itemProcessing)
                .where(eq(itemProcessing.itemId, ITEM));
            await db()
                .insert(aiEnhancements)
                .values({
                    itemId: ITEM,
                    userId: OWNER,
                    transcriptionId: TRANSCRIPT,
                    summary: encryptText("Finished legacy summary"),
                    source: "riffado",
                    provider: "test",
                    model: "test",
                });
            const before = await db().select().from(aiEnhancements);
            await share();
            expect((await resolved("topics")).revisionId).toBe(
                `${ORG_PROFILE}-rev`,
            );
            const plan = planAdvance(await gatherFacts(ITEM, "private", OWNER));
            expect(
                plan.actions.some(
                    (action) =>
                        action.type === "queueSummary" ||
                        action.type === "queueTopics",
                ),
            ).toBe(false);
            expect(await db().select().from(aiEnhancements)).toEqual(before);
        });

        it.each([
            "mail",
            "audio",
        ] as const)("processes a new %s shared before its arrival advance", async (kind) => {
            let itemId = ITEM;
            if (kind === "mail") {
                itemId = "fresh-mail";
                await db()
                    .insert(chatterItems)
                    .values({
                        id: itemId,
                        userId: OWNER,
                        kind,
                        title: encryptText("Fresh mail"),
                        occurredAt: at,
                    });
                await db().insert(mailMessages).values({
                    id: itemId,
                    userId: OWNER,
                    rawHash: "fresh-hash",
                    receivedAt: at,
                    sizeBytes: 100,
                    auth: {},
                    senderVerified: true,
                });
                await db()
                    .insert(mailContents)
                    .values({
                        id: "fresh-content",
                        itemId,
                        userId: OWNER,
                        revision: 0,
                        parserVersion: 1,
                        segments: encryptJsonField([]),
                    });
                const settings = defaultProfileSettings("mail");
                settings.steps.summary.automatic = true;
                settings.steps.learn.automatic = false;
                await db()
                    .insert(processingProfiles)
                    .values({
                        id: "org-mail",
                        ownerUserId: orgUserId,
                        scope: "organization",
                        channel: "mail",
                        name: encryptText("Mail"),
                        currentRevisionId: "org-mail-rev",
                    });
                await db()
                    .insert(processingProfileRevisions)
                    .values({
                        id: "org-mail-rev",
                        profileId: "org-mail",
                        settings: encryptText(JSON.stringify(settings)),
                    });
                await db().insert(folderDefaultProfiles).values({
                    folderId: "org-parent",
                    channel: "mail",
                    profileId: "org-mail",
                });
                await db().insert(itemProcessing).values({
                    itemId,
                    userId: OWNER,
                    view: "private",
                    requestedGeneration: 1,
                    phases: {},
                });
            } else {
                await db()
                    .update(transcriptions)
                    .set({ source: "plaud" })
                    .where(eq(transcriptions.recordingId, ITEM));
                const settings = defaultProfileSettings("audio");
                settings.steps.transcribe.automatic = true;
                settings.steps.transcribe.plaudTranscript = "also_transcribe";
                await db()
                    .update(processingProfileRevisions)
                    .set({ settings: encryptText(JSON.stringify(settings)) })
                    .where(
                        eq(processingProfileRevisions.id, `${ORG_PROFILE}-rev`),
                    );
                await db()
                    .update(itemProcessing)
                    .set({
                        profileId: null,
                        profileRevisionId: null,
                        phases: {},
                    })
                    .where(eq(itemProcessing.itemId, ITEM));
            }
            await db()
                .insert(asyncJobs)
                .values({
                    id: "arrival-job",
                    userId: OWNER,
                    subjectId: itemId,
                    kind: "pipeline.advance",
                    payload: { itemId, view: "private", reason: "arrival" },
                });
            await addRecordingToFolder({
                userId: OWNER,
                recordingId: itemId,
                folderId: "org-child",
            });
            const current = await readProcessing(itemId, "private", OWNER);
            expect(
                Object.values(current?.phases ?? {}).some(
                    (phase) => phase.reason === "legacy",
                ),
            ).toBe(false);
            const facts = await gatherFacts(itemId, "private", OWNER, {
                legacyIfEmpty: false,
            });
            expect(
                (await gatherFacts(itemId, "private", OWNER)).legacyFallback,
            ).toBe(false);
            const plan = planAdvance(facts);
            expect(
                plan.actions.some(
                    (action) =>
                        action.type ===
                        (kind === "mail"
                            ? "queueSummary"
                            : "queueTranscription"),
                ),
            ).toBe(true);
            expect(facts.profile?.revisionId).toBe(
                kind === "mail" ? "org-mail-rev" : `${ORG_PROFILE}-rev`,
            );
        });

        it.each([
            "curator",
            "organization",
        ])("resolves and generates titles for a %s without a binding", async (actor) => {
            const chosen = phases();
            if (chosen.categorize) chosen.categorize.profileChoice = "manual";
            await db()
                .update(itemProcessing)
                .set({ phases: chosen })
                .where(eq(itemProcessing.itemId, ITEM));
            await db()
                .update(processingProfiles)
                .set({ isDefault: true })
                .where(eq(processingProfiles.id, ORG_PROFILE));
            await share();
            const actorUserId = actor === "curator" ? CURATOR : orgUserId;
            expect(
                (await resolveItemProfile(ITEM, "org", OWNER, actorUserId))
                    .revisionId,
            ).toBe(`${ORG_PROFILE}-rev`);
            await expect(
                generateTitleFromTranscription(
                    actorUserId,
                    ITEM,
                    "Planning notes",
                    "transcript",
                    OWNER,
                    "org",
                ),
            ).resolves.toBe("Shared planning");
        });

        it("uses the Organization row's assignment before its default for another actor", async () => {
            const chosen = phases();
            if (chosen.categorize) chosen.categorize.profileChoice = "manual";
            await db()
                .update(itemProcessing)
                .set({ phases: chosen })
                .where(eq(itemProcessing.itemId, ITEM));
            await db()
                .update(processingProfiles)
                .set({ isDefault: true })
                .where(eq(processingProfiles.id, ORG_PROFILE));
            await db()
                .insert(itemProcessing)
                .values({
                    itemId: ITEM,
                    userId: OWNER,
                    view: "org",
                    profileId: OTHER_PROFILE,
                    profileRevisionId: `${OTHER_PROFILE}-rev`,
                });
            await share();
            expect(
                (await resolveItemProfile(ITEM, "org", OWNER, CURATOR))
                    .revisionId,
            ).toBe(`${OTHER_PROFILE}-rev`);
        });

        it("initializes a missing base and displays its placement without invalidating on a later save", async () => {
            await db()
                .update(itemProcessing)
                .set({ profileId: null, profileRevisionId: null })
                .where(eq(itemProcessing.itemId, ITEM));
            await share();
            const current = await readProcessing(ITEM, "private", OWNER);
            expect(current).toMatchObject({
                profileId: ORG_PROFILE,
                profileRevisionId: `${ORG_PROFILE}-rev`,
            });
            expect(current?.phases.categorize?.profileChoice).toBe("placement");
            expect(
                (await loadPrivateItemProcessing(OWNER, ITEM))?.profile?.id,
            ).toBe(ORG_PROFILE);
            const response = await categorize(
                new NextRequest(
                    `http://localhost/api/recordings/${ITEM}/categorize`,
                    {
                        method: "POST",
                        body: JSON.stringify({ folderIds: ["org-child"] }),
                        headers: { "Content-Type": "application/json" },
                    },
                ),
                { params: Promise.resolve({ id: ITEM }) },
            );
            expect(response.status).toBe(200);
            const shown = await loadPrivateItemProcessing(OWNER, ITEM);
            expect(shown?.processAgain).toBe(false);
            expect(shown?.phases.transcribe?.state).toBe("done");
            expect(shown?.phases.learn?.state).toBe("done");
        });

        it.each([
            false,
            true,
        ])("preserves a run started without a base through placement initialization (manual change: %s)", async (manualChange) => {
            await db()
                .update(itemProcessing)
                .set({ profileId: null, profileRevisionId: null })
                .where(eq(itemProcessing.itemId, ITEM));
            await share();
            await moveRecordingBetweenFolders({
                userId: MEMBER,
                recordingId: ITEM,
                fromFolderId: "org-child",
                toFolderId: "org-other",
            });
            if (manualChange) {
                const response = await categorize(
                    new NextRequest(
                        `http://localhost/api/recordings/${ITEM}/categorize`,
                        {
                            method: "POST",
                            body: JSON.stringify({
                                folderIds: ["org-other"],
                                profileId: PERSONAL,
                            }),
                            headers: { "Content-Type": "application/json" },
                        },
                    ),
                    { params: Promise.resolve({ id: ITEM }) },
                );
                expect(response.status).toBe(200);
            }
            const result = await upsertEnhancement({
                userId: OWNER,
                recordingId: ITEM,
                transcriptionId: TRANSCRIPT,
                summary: "Finished during placement",
                keyPoints: [],
                actionItems: [],
                source: "riffado",
                provider: "test",
                model: "test",
                profileRevisionId: `${PERSONAL}-rev`,
                inputs: { ...content, itemProfileRevisionId: null },
            });
            expect(result.committed).toBe(!manualChange);
            if (!manualChange) {
                expect(
                    (await gatherFacts(ITEM, "private", OWNER)).summary.current,
                ).toBe(true);
                expect(
                    await storeGeneratedTitle(
                        OWNER,
                        ITEM,
                        "Shared planning",
                        undefined,
                        OWNER,
                        { ...content, profileRevisionId: null },
                    ),
                ).toBe(true);
                expect(
                    (await loadPrivateItemProcessing(OWNER, ITEM))
                        ?.processAgain,
                ).toBe(false);
            } else {
                expect(result.reason).toBe("outdated");
            }
        });

        it("clears a placement overlay through an explicit categorize request", async () => {
            await share();
            const response = await categorize(
                new NextRequest(
                    `http://localhost/api/recordings/${ITEM}/categorize`,
                    {
                        method: "POST",
                        body: JSON.stringify({
                            folderIds: ["org-child"],
                            profileId: PERSONAL,
                        }),
                        headers: { "Content-Type": "application/json" },
                    },
                ),
                { params: Promise.resolve({ id: ITEM }) },
            );
            expect(response.status).toBe(200);
            const current = await readProcessing(ITEM, "private", OWNER);
            expect(
                current?.phases.categorize?.placementProfile,
            ).toBeUndefined();
            expect(current?.phases.categorize?.profileChoice).toBe("manual");
            expect((await resolved("summary")).revisionId).toBe(
                `${PERSONAL}-rev`,
            );
        });

        async function manualPlacement() {
            await db()
                .update(processingProfiles)
                .set({ isDefault: true })
                .where(eq(processingProfiles.id, ORG_PROFILE));
            await db()
                .update(folderDefaultProfiles)
                .set({ manualOnly: true, profileId: null })
                .where(eq(folderDefaultProfiles.folderId, "org-parent"));
        }

        it("displays the effective placement profile and automation policy", async () => {
            await manualPlacement();
            await share();
            const shown = await loadPrivateItemProcessing(OWNER, ITEM);
            expect(shown).toMatchObject({
                manualOnly: true,
                profile: { id: ORG_PROFILE },
            });
            expect(
                (await readProcessing(ITEM, "private", OWNER))?.profileId,
            ).toBe(PERSONAL);
        });

        it.each([
            "done",
            "failed",
        ] as const)("settles a started transcription as %s under a manual-only placement", async (state) => {
            await manualPlacement();
            const running = phases();
            running.transcribe = {
                state: "running",
                reason: "automatic",
                automatic: true,
                generation: 1,
                at: at.toISOString(),
            };
            delete running.learn;
            delete running.summary;
            await db()
                .update(itemProcessing)
                .set({ phases: running })
                .where(eq(itemProcessing.itemId, ITEM));
            await share();
            if (state === "failed") {
                await db()
                    .delete(transcriptions)
                    .where(eq(transcriptions.recordingId, ITEM));
                await db()
                    .insert(asyncJobs)
                    .values({
                        id: "failed-transcription",
                        userId: OWNER,
                        subjectId: ITEM,
                        kind: "transcription",
                        status: "failed",
                        completedAt: new Date(),
                        payload: { trigger: "pipeline" },
                        errorCode: "TRANSCRIPTION_FAILED",
                    });
            }
            const plan = planAdvance(await gatherFacts(ITEM, "private", OWNER));
            expect(plan.actions).toContainEqual(
                expect.objectContaining({
                    type: "markPhase",
                    phase: "transcribe",
                    record: expect.objectContaining({ state }),
                }),
            );
            expect(
                plan.actions.some(
                    (action) => action.type === "queueTranscription",
                ),
            ).toBe(false);
        });

        it("keeps a started Learn run reviewable under a manual-only placement", async () => {
            await manualPlacement();
            await share();
            await db()
                .insert(learnRuns)
                .values({
                    id: "held-learn",
                    itemId: ITEM,
                    userId: OWNER,
                    scopeUserId: orgUserId,
                    view: "org",
                    trigger: "auto",
                    status: "ready",
                    transcriptionId: TRANSCRIPT,
                    transcriptRevision: 0,
                    vocabularyVersion: 0,
                    profileRevisionId: `${PERSONAL}-rev`,
                });
            const current = await readProcessing(ITEM, "private", OWNER);
            await db()
                .update(itemProcessing)
                .set({
                    phases: {
                        ...current?.phases,
                        learn: {
                            state: "running",
                            reason: "started",
                            generation: 1,
                            at: at.toISOString(),
                            inputs: content,
                        },
                    },
                })
                .where(eq(itemProcessing.itemId, ITEM));
            const plan = planAdvance(await gatherFacts(ITEM, "private", OWNER));
            expect(plan.actions).toContainEqual(
                expect.objectContaining({
                    type: "markPhase",
                    phase: "learn",
                    record: expect.objectContaining({
                        state: "waiting",
                        reason: "manual_review_pending",
                    }),
                }),
            );
            expect(
                plan.actions.some(
                    (action) =>
                        action.type === "startAutoLearn" ||
                        action.type === "queueSummary" ||
                        action.type === "queueTopics",
                ),
            ).toBe(false);
        });

        it("does not reference an unrelated Organization profile history", async () => {
            await share();
            expect(
                await profileHistoryReferences(db(), orgUserId, OTHER_PROFILE),
            ).toBe(false);
        });

        it("manual runs use the effective placement while an automatic summary holds the old revision", async () => {
            await db()
                .insert(asyncJobs)
                .values({
                    id: "held-summary",
                    userId: OWNER,
                    subjectId: ITEM,
                    kind: "summary",
                    payload: { trigger: "auto" },
                });
            await share();
            expect((await resolved("summary")).revisionId).toBe(
                `${PERSONAL}-rev`,
            );
            expect(
                (await resolveManualItemProfile(ITEM, "private", OWNER))
                    .revisionId,
            ).toBe(`${ORG_PROFILE}-rev`);
            await db()
                .update(asyncJobs)
                .set({ status: "completed" })
                .where(eq(asyncJobs.id, "held-summary"));
            await moveRecordingBetweenFolders({
                userId: CURATOR,
                recordingId: ITEM,
                fromFolderId: "org-child",
                toFolderId: "org-other",
            });
            expect(
                (await readProcessing(ITEM, "private", OWNER))?.phases
                    .categorize?.heldProfiles,
            ).toEqual({});
        });

        it.each([
            "local",
            "idp",
        ])("resolves placement reads entirely through the sharing transaction (%s authorization)", async (mode) => {
            await db()
                .insert(recordingFolderAssignments)
                .values({ itemId: ITEM, userId: OWNER, folderId: "org-child" });
            if (mode === "idp") {
                await db()
                    .insert(userAccessStates)
                    .values({
                        userId: OWNER,
                        issuer: "https://identity.example.test",
                        subject: "zava-subject",
                        capabilities: ["use"],
                        status: "active",
                        verifiedAt: new Date(),
                        source: "verifier",
                    });
            }
            mocks.env.AUTHZ_MODE = mode;
            const select = vi.spyOn(db(), "select").mockImplementation(() => {
                throw new Error("read outside transaction");
            });
            try {
                await db().transaction((tx) =>
                    bindPlacementProfileInTx(tx, {
                        itemId: ITEM,
                        ownerUserId: OWNER,
                        orgUserId,
                    }),
                );
            } finally {
                select.mockRestore();
                mocks.env.AUTHZ_MODE = "local";
            }
            expect((await resolved("summary")).revisionId).toBe(
                `${ORG_PROFILE}-rev`,
            );
        });

        it("finishes sharing if a resolved profile revision disappears before it is locked", async () => {
            const lock = revisionGuard.lockProfileRevisionInTx;
            const guard = vi
                .spyOn(revisionGuard, "lockProfileRevisionInTx")
                .mockImplementationOnce(async (tx, userId, revisionId) => {
                    await tx
                        .delete(processingProfileRevisions)
                        .where(
                            and(
                                eq(processingProfileRevisions.id, revisionId),
                                eq(
                                    processingProfileRevisions.profileId,
                                    ORG_PROFILE,
                                ),
                            ),
                        );
                    await lock(tx, userId, revisionId);
                });
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            try {
                await share();
                expect(warn).toHaveBeenCalledWith(
                    "Placement profile revision disappeared before binding",
                    expect.objectContaining({ itemId: ITEM }),
                );
                expect(
                    (await readProcessing(ITEM, "private", OWNER))?.phases
                        .categorize?.placementProfile,
                ).toBeUndefined();
                expect(
                    await db()
                        .select()
                        .from(recordingFolderAssignments)
                        .where(eq(recordingFolderAssignments.itemId, ITEM)),
                ).toHaveLength(1);
            } finally {
                guard.mockRestore();
                warn.mockRestore();
            }
        });

        it("recognizes an old automatic personal-folder assignment even if it differs from the account default", async () => {
            const chosen = phases();
            if (chosen.categorize) delete chosen.categorize.profileChoice;
            await profile("private-folder-profile", OWNER);
            await db()
                .insert(recordingFolders)
                .values({
                    id: "private-child",
                    userId: OWNER,
                    parentId: "private-root",
                    kind: "custom",
                    name: encryptText("Private project"),
                    nameHash: "private-child",
                });
            await db().insert(folderDefaultProfiles).values({
                folderId: "private-child",
                channel: "audio",
                profileId: "private-folder-profile",
            });
            await db().insert(recordingFolderAssignments).values({
                itemId: ITEM,
                userId: OWNER,
                folderId: "private-child",
            });
            await db()
                .update(itemProcessing)
                .set({
                    profileId: "private-folder-profile",
                    profileRevisionId: "private-folder-profile-rev",
                    phases: chosen,
                })
                .where(eq(itemProcessing.itemId, ITEM));
            await share();
            expect((await resolved("summary")).revisionId).toBe(
                `${ORG_PROFILE}-rev`,
            );
        });

        it("drops a held summary reference as soon as its step settles", async () => {
            await db()
                .insert(asyncJobs)
                .values({
                    id: "held-summary",
                    userId: OWNER,
                    subjectId: ITEM,
                    kind: "summary",
                    status: "processing",
                    payload: { trigger: "auto" },
                });
            await share();
            await upsertEnhancement({
                userId: OWNER,
                recordingId: ITEM,
                transcriptionId: TRANSCRIPT,
                summary: "Finished",
                keyPoints: [],
                actionItems: [],
                source: "riffado",
                provider: "test",
                model: "test",
                jobId: "held-summary",
                profileRevisionId: `${PERSONAL}-rev`,
                inputs: {
                    ...content,
                    itemProfileRevisionId: `${PERSONAL}-rev`,
                },
            });
            expect(
                (await readProcessing(ITEM, "private", OWNER))?.phases
                    .categorize?.heldProfiles?.summary,
            ).toBeUndefined();
        });

        it("uses placement manual-only for pending work, recovery and share confirmation", async () => {
            await manualPlacement();
            await share();
            expect(await pipelineMayQueue(OWNER, ITEM, "summary")).toBe(false);
            const current = await readProcessing(ITEM, "private", OWNER);
            await db()
                .update(itemProcessing)
                .set({
                    phases: {
                        ...current?.phases,
                        summary: {
                            state: "skipped",
                            reason: "no_provider",
                            generation: 1,
                            at: at.toISOString(),
                        },
                    },
                })
                .where(eq(itemProcessing.itemId, ITEM));
            expect(
                await db().transaction((tx) =>
                    listProviderRecoveryRowsInTx(tx, OWNER, false),
                ),
            ).toEqual([]);
            await db()
                .insert(mailPendingShares)
                .values({ itemId: ITEM, userId: OWNER, folderId: "org-other" });
            expect(
                await executeIntendedSharesWithOutcome(OWNER, ITEM),
            ).toMatchObject({ confirmationRequired: true, shared: false });
            expect(await confirmIntendedPlacements(OWNER, ITEM)).toBe(1);
        });

        it("allows pending work when the placement overrides a manual-only base", async () => {
            await db()
                .update(itemProcessing)
                .set({ manualOnly: true })
                .where(eq(itemProcessing.itemId, ITEM));
            await share();
            expect(await pipelineMayQueue(OWNER, ITEM, "summary")).toBe(true);
            const current = await readProcessing(ITEM, "private", OWNER);
            await db()
                .update(itemProcessing)
                .set({
                    phases: {
                        ...current?.phases,
                        summary: {
                            state: "skipped",
                            reason: "no_provider",
                            generation: 1,
                            at: at.toISOString(),
                        },
                    },
                })
                .where(eq(itemProcessing.itemId, ITEM));
            expect(
                await db().transaction((tx) =>
                    listProviderRecoveryRowsInTx(tx, OWNER, false),
                ),
            ).toEqual([{ itemId: ITEM, userId: OWNER, view: "private" }]);
        });

        it("does not match a shared item's task to the same owner's private task", async () => {
            await db()
                .insert(chatterItems)
                .values({
                    id: "private-task-item",
                    userId: OWNER,
                    kind: "mail",
                    title: encryptText("Private notes"),
                    occurredAt: at,
                });
            const [task] = await db()
                .insert(recordingTasks)
                .values({
                    itemId: "private-task-item",
                    userId: OWNER,
                    text: encryptText("Private commitment"),
                    source: "manual",
                    status: "open",
                })
                .returning({ id: recordingTasks.id });
            await share();
            const warning = vi
                .spyOn(console, "warn")
                .mockImplementation(() => {});
            try {
                await upsertEnhancement({
                    userId: OWNER,
                    recordingId: ITEM,
                    transcriptionId: TRANSCRIPT,
                    summary: "Shared summary",
                    keyPoints: [],
                    actionItems: [],
                    source: "riffado",
                    provider: "test",
                    model: "test",
                    tasks: {
                        source: "riffado",
                        tasks: [],
                        updates: [],
                        matches: [
                            {
                                taskId: task?.id ?? "",
                                quote: null,
                                evidenceStartMs: null,
                            },
                        ],
                        fingerprintOf: taskFingerprint,
                        reviewer: {
                            userId: OWNER,
                            emailHash: "",
                            isOrg: false,
                            isCurator: false,
                            orgUserId,
                        },
                    },
                });
                expect(warning).toHaveBeenCalledOnce();
            } finally {
                warning.mockRestore();
            }
            expect(await db().select().from(taskMentions)).toEqual([]);
        });

        it("refuses a non-curator member without advancing either row", async () => {
            await share();
            const previous = await readProcessing(ITEM, "private", OWNER);
            await expect(
                changeTranscriptSpeaker({
                    userId: OWNER,
                    transcriptionId: TRANSCRIPT,
                    revision: 0,
                    label: "speaker_0",
                    answer: { kind: "name", displayName: "Velko Taren" },
                    actorUserId: MEMBER,
                    orgUserId,
                }),
            ).rejects.toMatchObject({ statusCode: 409 });
            expect(await readProcessing(ITEM, "private", OWNER)).toEqual(
                previous,
            );
        });
    },
);
