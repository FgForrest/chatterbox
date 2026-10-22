import { and, eq, inArray } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { completeJob } from "@/db/queries/async-jobs";
import {
    aiEnhancements,
    apiCredentials,
    asyncJobs,
    chatterItems,
    itemProcessing,
    knowledgeAliases,
    knowledgeEntities,
    knowledgeFactEvidence,
    knowledgeFacts,
    learnReviewItems,
    learnRuns,
    mailContents,
    mailMessages,
    people,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    transcriptCorrectionPasses,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { acceptCorrection } from "@/lib/knowledge/corrections";
import { createEntity } from "@/lib/knowledge/entities";
import { confirmFactFromRecording } from "@/lib/knowledge/facts";
import { changeTranscriptSpeaker } from "@/lib/knowledge/speaker-changes";
import {
    createPrivateType,
    seedCoreVocabulary,
} from "@/lib/knowledge/vocabulary";
import { isHeldForLearn } from "@/lib/learn/hold";
import { finishReview, loadReview } from "@/lib/learn/review";
import { ensureOrgAccount } from "@/lib/org/account";
import { gatherFacts } from "@/lib/pipeline/facts";
import { planAdvance } from "@/lib/pipeline/plan";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { requireRecordingView } from "@/lib/sharing/access";
import { SUMMARY_JOB_KIND } from "@/lib/summary/summary-job";
import { TOPICS_JOB_KIND } from "@/lib/topics/topics-job";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, key) => {
                    if (!ref.current)
                        throw new Error("test database not initialized");
                    const value = ref.current[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "organization@example.test",
            ORG_ACCOUNT_PASSWORD: "invented-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});
vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const OWNER = "settles-owner";
const ITEM = "settles-recording";
const PERSON = "settles-person";
const TURNS = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 12_000,
        text: "Nela leads Skylark. Fix this manual name.",
    },
];

describeWithDatabase("finished private Learn at share (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let folderId = "";
    let transcriptId = "";
    function db() {
        if (!database) throw new Error("test database not initialized");
        return database.db;
    }
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "learn_share_settles",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    async function audio(itemId = ITEM) {
        await insertRecordings(db(), {
            id: itemId,
            userId: OWNER,
            filename: encryptText("Skylark meeting"),
            deviceSn: "invented-device",
            plaudFileId: itemId,
            duration: 12_000,
            startTime: new Date(),
            endTime: new Date(),
            filesize: 10,
            fileMd5: "0".repeat(32),
            plaudVersion: "1",
            storageType: "local",
            storagePath: `${OWNER}/${itemId}.mp3`,
        });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: itemId,
                userId: OWNER,
                text: encryptText(TURNS[0].text),
                turns: encryptJsonField(TURNS),
                source: "riffado",
                provider: "invented",
                model: "invented",
            })
            .returning();
        if (!transcript) throw new Error("missing transcript");
        await db().insert(transcriptSpeakers).values({
            userId: OWNER,
            transcriptionId: transcript.id,
            label: "speaker_0",
            personId: PERSON,
            status: "confirmed",
            source: "user",
            confirmedByUserId: OWNER,
        });
        await db()
            .insert(itemProcessing)
            .values({
                itemId,
                userId: OWNER,
                view: "private",
                phases: {
                    categorize: {
                        state: "done",
                        reason: "categorized",
                        generation: 0,
                        at: new Date().toISOString(),
                    },
                    learn: {
                        state: "waiting",
                        reason: "review_pending",
                        generation: 0,
                        at: new Date().toISOString(),
                        inputs: {
                            contentId: transcript.id,
                            contentRevision: 0,
                            contentSourceId: "riffado",
                        },
                    },
                },
            });
        return transcript.id;
    }

    beforeEach(async () => {
        mockEnv.SELF_HOST_MODE = "shared";
        await db().delete(users);
        await db()
            .insert(users)
            .values({ id: OWNER, email: "owner@example.test" });
        orgUserId = (await ensureOrgAccount()) ?? "";
        await seedCoreVocabulary();
        const [folder] = await db()
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        if (!folder) throw new Error("missing Organization folder");
        folderId = folder.id;
        await db()
            .insert(people)
            .values({
                id: PERSON,
                userId: OWNER,
                displayName: encryptText("Nela Starling"),
            });
        transcriptId = await audio();
    });

    async function run(overrides: Partial<typeof learnRuns.$inferInsert> = {}) {
        const [row] = await db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: OWNER,
                itemId: ITEM,
                transcriptionId: transcriptId,
                view: "private",
                actorUserId: OWNER,
                trigger: "manual",
                status: "finished",
                transcriptRevision: 0,
                vocabularyVersion: 1,
                inputs: {
                    contentId: transcriptId,
                    contentRevision: 0,
                    contentSourceId: "riffado",
                },
                stats: { applied: 7, skipped: 2, dismissed: 3, kept_fact: 4 },
                finishedAt: new Date(),
                ...overrides,
            })
            .returning();
        if (!row) throw new Error("missing run");
        return row;
    }
    const share = (itemId = ITEM) =>
        addRecordingToFolder({ userId: OWNER, recordingId: itemId, folderId });
    const orgRuns = (itemId = ITEM) =>
        db()
            .select()
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.itemId, itemId),
                    eq(learnRuns.userId, OWNER),
                    eq(learnRuns.view, "org"),
                ),
            );
    const context = (itemId = ITEM, view: "private" | "org" = "org") =>
        requireRecordingView(view === "org" ? orgUserId : OWNER, itemId, view, {
            kinds: ["audio", "mail"],
        });

    it("exposes a finished receipt to the widget and pipeline without a Learn job or summary hold", async () => {
        const source = await run();
        await db()
            .update(chatterItems)
            .set({ summaryDueAt: new Date(Date.now() + 100_000) })
            .where(eq(chatterItems.id, ITEM));
        await share();
        const review = await loadReview(await context(), "riffado");
        expect(review.run).toMatchObject({
            status: "finished",
            sharedReview: { applied: 7, skipped: 2, dismissed: 3 },
        });
        expect(review.items).toEqual([]);
        const [receipt] = await orgRuns();
        expect(receipt?.inputs?.promotedFromRunId).toBe(source.id);
        expect(receipt?.stats).toEqual({
            applied: 7,
            skipped: 2,
            dismissed: 3,
        });
        expect(receipt?.jobId).toBeNull();
        expect(
            (
                await loadPrivateItemProcessing(
                    OWNER,
                    ITEM,
                    orgUserId,
                    "en",
                    "org",
                )
            )?.outputs.learn,
        ).toBe(true);
        const facts = await gatherFacts(ITEM, "private", OWNER);
        expect(facts.phases.learn?.state).toBe("done");
        expect(
            planAdvance(facts).actions.some(
                (action) => action.type === "startAutoLearn",
            ),
        ).toBe(false);
        expect(await isHeldForLearn(ITEM)).toBe(false);
        expect(
            await db()
                .select()
                .from(asyncJobs)
                .where(
                    and(
                        eq(asyncJobs.userId, OWNER),
                        eq(asyncJobs.kind, "learn.run"),
                        inArray(asyncJobs.status, ["pending", "processing"]),
                    ),
                ),
        ).toEqual([]);
        expect(
            await db()
                .select()
                .from(learnRuns)
                .where(eq(learnRuns.id, source.id)),
        ).toEqual([source]);
    });

    async function automaticProfile(
        plaudTranscript: "use" | "also_transcribe" = "use",
    ) {
        const settings = defaultProfileSettings("audio");
        settings.steps.topics.automatic = true;
        settings.steps.summary.automatic = true;
        settings.steps.learn.automatic = true;
        settings.steps.title.automatic = false;
        settings.steps.transcribe.plaudTranscript = plaudTranscript;
        const provider = {
            credentialId: "settles-provider",
            scope: "personal" as const,
        };
        settings.steps.topics.provider = provider;
        settings.steps.summary.provider = provider;
        settings.steps.learn.provider = provider;
        await db()
            .insert(apiCredentials)
            .values({
                id: provider.credentialId,
                userId: OWNER,
                provider: "invented",
                apiKey: encryptText("invented-key"),
                defaultModel: "invented-model",
            });
        await db()
            .insert(processingProfiles)
            .values({
                id: "settles-profile",
                ownerUserId: OWNER,
                channel: "audio",
                scope: "personal",
                name: encryptText("Skylark workflow"),
                currentRevisionId: "settles-profile-revision",
            });
        await db()
            .insert(processingProfileRevisions)
            .values({
                id: "settles-profile-revision",
                profileId: "settles-profile",
                settings: encryptText(JSON.stringify(settings)),
            });
        await db()
            .update(itemProcessing)
            .set({
                profileId: "settles-profile",
                profileRevisionId: "settles-profile-revision",
            })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, OWNER),
                    eq(itemProcessing.view, "private"),
                ),
            );
    }

    it.each([
        false,
        true,
    ])("preserves finished Learn, Topics and Summary across share and reshare (stale summary: %s)", async (stale) => {
        await automaticProfile();
        await run();
        const inputs = {
            contentId: transcriptId,
            contentRevision: 0,
            contentSourceId: "riffado",
        };
        const at = new Date().toISOString();
        const phases = {
            categorize: {
                state: "done" as const,
                reason: "categorized",
                profileChoice: "manual" as const,
                generation: 1,
                at,
            },
            transcribe: {
                state: "done" as const,
                reason: "content-available",
                generation: 1,
                at,
                inputs,
            },
            learn: {
                state: "done" as const,
                reason: "released",
                generation: 3,
                at,
                inputs,
            },
            summary: {
                state: "done" as const,
                reason: "completed",
                generation: 4,
                at,
                inputs,
                steps: {
                    topics: {
                        ...inputs,
                        state: "done" as const,
                        generation: 4,
                        profileRevisionId: "settles-profile-revision",
                    },
                    summary: {
                        ...inputs,
                        state: "done" as const,
                        generation: 4,
                        profileRevisionId: "settles-profile-revision",
                    },
                },
            },
        };
        await db()
            .update(itemProcessing)
            .set({ phases, requestedGeneration: 6 })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, OWNER),
                ),
            );
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: ITEM,
                userId: OWNER,
                transcriptionId: transcriptId,
                source: "riffado",
                summary: encryptText("Skylark plans"),
                provider: "invented",
                model: "invented",
                inputFingerprint: stale ? "outdated-reading" : null,
                inputs,
            });
        const verify = async () => {
            const facts = await gatherFacts(ITEM, "private", OWNER);
            expect(facts.profile?.automatic).toMatchObject({
                topics: true,
                summary: true,
            });
            expect(facts.stepAvailability).toMatchObject({
                topics: "available",
                summary: "available",
            });
            expect(facts.summary.stale).toBe(stale);
            expect(facts.phases.learn).toEqual(phases.learn);
            expect(facts.phases.summary).toEqual(phases.summary);
            expect(
                planAdvance(facts).actions.filter(
                    (action) =>
                        action.type === "queueTopics" ||
                        action.type === "queueSummary" ||
                        action.type === "startAutoLearn" ||
                        (action.type === "markPhase" &&
                            action.phase === "summary"),
                ),
            ).toEqual([]);
            expect(
                await db()
                    .select()
                    .from(asyncJobs)
                    .where(
                        and(
                            eq(asyncJobs.subjectId, ITEM),
                            eq(asyncJobs.userId, OWNER),
                            inArray(asyncJobs.kind, [
                                TOPICS_JOB_KIND,
                                SUMMARY_JOB_KIND,
                            ]),
                        ),
                    ),
            ).toEqual([]);
        };
        await verify();
        await share();
        expect(await orgRuns()).toHaveLength(1);
        await verify();
        await unshareRecording(OWNER, ITEM, { withdraw: true });
        await share();
        expect(await orgRuns()).toHaveLength(1);
        await verify();
    });

    it("selects the own-transcript review even when a Plaud review finished more recently", async () => {
        await automaticProfile();
        const source = await run({ createdAt: new Date(Date.now() - 60_000) });
        const [plaud] = await db()
            .insert(transcriptions)
            .values({
                recordingId: ITEM,
                userId: OWNER,
                source: "plaud",
                provider: "invented",
                model: "invented",
                text: encryptText("Imported Skylark transcript"),
            })
            .returning();
        if (!plaud) throw new Error("missing Plaud transcript");
        await run({
            transcriptionId: plaud.id,
            inputs: {
                contentId: plaud.id,
                contentRevision: 0,
                contentSourceId: "plaud",
            },
        });
        await share();
        const [receipt] = await orgRuns();
        expect(receipt).toMatchObject({
            transcriptionId: transcriptId,
            inputs: {
                promotedFromRunId: source.id,
                contentId: transcriptId,
                contentSourceId: "riffado",
            },
        });
        expect((await loadReview(await context(), "riffado")).run?.status).toBe(
            "finished",
        );
        const facts = await gatherFacts(ITEM, "private", OWNER);
        expect(facts.phases.learn?.inputs?.contentId).toBe(transcriptId);
        expect(
            planAdvance(facts).actions.some(
                (action) =>
                    action.type === "startAutoLearn" ||
                    (action.type === "markPhase" &&
                        action.phase === "learn" &&
                        action.record.state === "outdated"),
            ),
        ).toBe(false);
    });

    it.each([
        "use",
        "also_transcribe",
    ] as const)("settles a Plaud-only review only when the profile uses it (%s)", async (policy) => {
        await automaticProfile(policy);
        await db()
            .update(transcriptions)
            .set({ source: "plaud" })
            .where(
                and(
                    eq(transcriptions.id, transcriptId),
                    eq(transcriptions.userId, OWNER),
                ),
            );
        const source = await run({
            inputs: {
                contentId: transcriptId,
                contentRevision: 0,
                contentSourceId: "plaud",
            },
        });
        await share();
        if (policy === "also_transcribe") {
            expect(await orgRuns()).toEqual([]);
            return;
        }
        expect((await orgRuns())[0]?.inputs).toMatchObject({
            promotedFromRunId: source.id,
            contentSourceId: "plaud",
        });
        expect((await loadReview(await context(), "plaud")).run?.status).toBe(
            "finished",
        );
        const facts = await gatherFacts(ITEM, "private", OWNER);
        expect(facts.content).toBeNull();
        expect(facts.phases.learn).toMatchObject({
            state: "done",
            inputs: { contentId: transcriptId, contentSourceId: "plaud" },
        });
        expect(
            planAdvance(facts).actions.some(
                (action) =>
                    action.type === "startAutoLearn" ||
                    (action.type === "markPhase" &&
                        action.phase === "learn" &&
                        action.record.state === "outdated"),
            ),
        ).toBe(false);
    });

    it("reports no findings from an automatic empty run using only outcome counts", async () => {
        await run({
            trigger: "auto",
            stats: { kept_new_record: 0, tool_calls: 2 },
        });
        await share();
        expect((await orgRuns())[0]?.stats).toEqual({
            applied: 0,
            skipped: 0,
            dismissed: 0,
        });
        expect((await loadReview(await context())).run?.sharedReview).toEqual({
            applied: 0,
            skipped: 0,
            dismissed: 0,
        });
    });

    it("revokes a finished private run's worker claim before it can overwrite the shared completion", async () => {
        const source = await run();
        const [job] = await db()
            .insert(asyncJobs)
            .values({
                userId: OWNER,
                subjectId: ITEM,
                kind: "learn.run",
                status: "processing",
                claimToken: "private-stale-claim",
                payload: {
                    runId: source.id,
                    pipelineSteps: [
                        {
                            itemId: ITEM,
                            userId: OWNER,
                            phase: "learn",
                            generation: 0,
                        },
                    ],
                },
            })
            .returning();
        if (!job) throw new Error("missing worker job");
        const [processing] = await db()
            .select()
            .from(itemProcessing)
            .where(eq(itemProcessing.itemId, ITEM));
        await db()
            .update(itemProcessing)
            .set({
                phases: {
                    ...processing?.phases,
                    learn: {
                        state: "running",
                        reason: "started",
                        jobId: job.id,
                        generation: 0,
                        at: new Date().toISOString(),
                        inputs: {
                            contentId: transcriptId,
                            contentRevision: 0,
                            contentSourceId: "riffado",
                        },
                    },
                },
            })
            .where(eq(itemProcessing.itemId, ITEM));
        await share();
        expect(
            await completeJob({
                jobId: job.id,
                claimToken: "private-stale-claim",
                result: {
                    outcome: {
                        kind: "waiting",
                        waitingFor: { kind: "learnReview" },
                    },
                },
            }),
        ).toBe(false);
        const facts = await gatherFacts(ITEM, "private", OWNER);
        expect(facts.phases.learn).toMatchObject({
            state: "done",
            reason: "released",
        });
        expect(facts.phases.learn?.jobId).toBeUndefined();
        expect(await orgRuns()).toHaveLength(1);
    });

    it("still publishes the speaker, correction-pass fix, manual correction, and an earlier run's fact", async () => {
        const project = await createEntity(OWNER, {
            typeKey: "project",
            name: "Skylark",
        });
        await run({ createdAt: new Date(Date.now() - 60_000) });
        await confirmFactFromRecording({
            subject: { personId: PERSON },
            relationKey: "leads",
            object: { entityId: project.id },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
            speakerLabel: "speaker_0",
        });
        await run();
        await db()
            .insert(transcriptCorrections)
            .values({
                userId: OWNER,
                transcriptionId: transcriptId,
                transcriptRevision: 0,
                turnIndex: 0,
                charStart: 20,
                charEnd: 23,
                heard: encryptText("Fix"),
                heardHmac: "invented-hash",
                replacement: encryptText("Repair"),
                kind: "fix",
            });
        await acceptCorrection({
            userId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            anchor: {
                turnIndex: 0,
                charStart: 29,
                charEnd: 35,
                heard: "manual",
            },
            kind: "correct",
            target: { personId: PERSON },
            replacement: "Nela",
        });
        await share();
        expect(
            (await db().select().from(people).where(eq(people.id, PERSON)))[0]
                ?.userId,
        ).toBe(orgUserId);
        expect(
            await db()
                .select()
                .from(transcriptCorrections)
                .where(eq(transcriptCorrections.userId, orgUserId)),
        ).toHaveLength(2);
        expect(
            await db()
                .select()
                .from(knowledgeAliases)
                .where(eq(knowledgeAliases.userId, orgUserId)),
        ).toHaveLength(1);
        expect(
            await db()
                .select()
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, orgUserId)),
        ).toHaveLength(1);
        expect(
            await db()
                .select()
                .from(knowledgeFactEvidence)
                .where(eq(knowledgeFactEvidence.userId, orgUserId)),
        ).toHaveLength(1);
    });

    it("keeps a hand-named speaker through withdrawal, a private rename, and reshare", async () => {
        await run();
        await share();
        await unshareRecording(OWNER, ITEM, { withdraw: true });
        const renamed = await changeTranscriptSpeaker({
            userId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            label: "speaker_0",
            answer: { kind: "name", displayName: "Nela Robin" },
        });
        await share();
        const [speaker] = await db()
            .select()
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.transcriptionId, transcriptId));
        expect(speaker).toMatchObject({
            personId: renamed,
            status: "confirmed",
        });
        const [person] = await db()
            .select()
            .from(people)
            .where(eq(people.id, renamed ?? ""));
        expect(person?.userId).toBe(orgUserId);
        expect(person && decryptText(person.displayName)).toBe("Nela Robin");
    });

    it("promotes one person without email across two shared items", async () => {
        await run();
        const secondTranscript = await audio("settles-second");
        await run({
            itemId: "settles-second",
            transcriptionId: secondTranscript,
            inputs: { contentId: secondTranscript, contentRevision: 0 },
        });
        await share();
        await share("settles-second");
        expect(
            await db()
                .select()
                .from(people)
                .where(eq(people.userId, orgUserId)),
        ).toHaveLength(1);
        const speakers = await db()
            .select()
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.personId, PERSON));
        expect(speakers).toHaveLength(2);
    });

    it.each([
        "queued",
        "running",
        "ready",
    ] as const)("cancels an open %s private run and keeps the Organization restart rule", async (status) => {
        await run({ createdAt: new Date(Date.now() - 60_000) });
        const open = await run({ status, finishedAt: null });
        const [job] = await db()
            .insert(asyncJobs)
            .values({
                userId: OWNER,
                kind: "learn.run",
                subjectId: ITEM,
                payload: { runId: open.id },
                status: status === "running" ? "processing" : "pending",
            })
            .returning();
        await share();
        expect(await orgRuns()).toEqual([]);
        expect(
            (
                await db()
                    .select()
                    .from(learnRuns)
                    .where(eq(learnRuns.id, open.id))
            )[0]?.status,
        ).toBe("cancelled");
        expect(
            (
                await db()
                    .select()
                    .from(asyncJobs)
                    .where(eq(asyncJobs.id, job?.id ?? ""))
            )[0]?.status,
        ).toBe("failed");
        expect(
            (await gatherFacts(ITEM, "private", OWNER)).phases.learn,
        ).toMatchObject({ state: "pending", reason: "scope_changed" });
    });

    it("keeps the offer when there is no finished private run", async () => {
        await share();
        expect((await loadReview(await context())).run).toBeNull();
        expect(
            (
                await loadPrivateItemProcessing(
                    OWNER,
                    ITEM,
                    orgUserId,
                    "en",
                    "org",
                )
            )?.outputs.learn,
        ).toBe(false);
    });

    it.each([
        "revision",
        "contentId",
        "inputRevision",
    ])("does not settle a review with stale %s", async (stale) => {
        await run(
            stale === "revision"
                ? { transcriptRevision: 1 }
                : {
                      inputs: {
                          contentId:
                              stale === "contentId"
                                  ? "old-content"
                                  : transcriptId,
                          contentRevision: stale === "inputRevision" ? 1 : 0,
                      },
                  },
        );
        await share();
        expect(await orgRuns()).toEqual([]);
    });

    it("withdraws only the receipt, then writes one receipt on concurrent reshare", async () => {
        const source = await run();
        await Promise.all([share(), share()]);
        expect(await orgRuns()).toHaveLength(1);
        await unshareRecording(OWNER, ITEM, { withdraw: true });
        expect(await orgRuns()).toEqual([]);
        expect((await loadReview(await context(ITEM, "private"))).run?.id).toBe(
            source.id,
        );
        await Promise.all([share(), share()]);
        expect(await orgRuns()).toHaveLength(1);
    });

    it("promotes standalone accepted records from an actual finished review without replaying findings", async () => {
        const typeKey = await createPrivateType(OWNER, {
            kind: "entity",
            label: "Workshop",
        });
        const source = await run({
            status: "ready",
            stats: { kept_new_record: 3 },
            finishedAt: null,
        });
        const rows = await db()
            .insert(learnReviewItems)
            .values([
                {
                    runId: source.id,
                    userId: OWNER,
                    kind: "new_record" as const,
                    fingerprintHmac: "new-person",
                    decision: "accepted" as const,
                    payload: encryptJsonField({
                        ref: "person-ref",
                        kind: "person",
                        name: "Ivo Finch",
                        typeKey: null,
                        evidenceMs: [0],
                        reason: "mentioned",
                    }),
                },
                {
                    runId: source.id,
                    userId: OWNER,
                    kind: "new_record" as const,
                    fingerprintHmac: "new-entity",
                    decision: "accepted" as const,
                    payload: encryptJsonField({
                        ref: "entity-ref",
                        kind: "entity",
                        name: "Lark Lab",
                        typeKey,
                        evidenceMs: [0],
                        reason: "mentioned",
                    }),
                },
                {
                    runId: source.id,
                    userId: OWNER,
                    kind: "new_record" as const,
                    fingerprintHmac: "rejected-person",
                    decision: "rejected" as const,
                    payload: encryptJsonField({
                        ref: "rejected-ref",
                        kind: "person",
                        name: "Ada Wren",
                        typeKey: null,
                        evidenceMs: [0],
                        reason: "mentioned",
                    }),
                },
            ])
            .returning();
        const result = await finishReview(
            await context(ITEM, "private"),
            OWNER,
            { versions: Object.fromEntries(rows.map((row) => [row.id, 0])) },
        );
        expect(result.applied).toBe(2);
        expect(result.correcting).toBe(true);
        const newPeople = await db()
            .select()
            .from(people)
            .where(eq(people.userId, OWNER));
        const standalone = newPeople.find((person) => person.id !== PERSON);
        if (!standalone) throw new Error("missing standalone person");
        await db()
            .update(people)
            .set({ displayName: encryptText("Ivo Swift") })
            .where(eq(people.id, standalone.id));
        await db()
            .update(chatterItems)
            .set({ summaryDueAt: new Date(Date.now() + 100_000) })
            .where(eq(chatterItems.id, ITEM));
        await share();
        expect(
            await db()
                .select()
                .from(people)
                .where(eq(people.userId, orgUserId)),
        ).toHaveLength(2);
        expect(
            await db()
                .select()
                .from(knowledgeEntities)
                .where(eq(knowledgeEntities.userId, orgUserId)),
        ).toHaveLength(1);
        expect((await loadReview(await context())).run?.sharedReview).toEqual({
            applied: 2,
            skipped: 0,
            dismissed: 1,
        });
        expect(
            await db()
                .select()
                .from(learnReviewItems)
                .where(eq(learnReviewItems.userId, orgUserId)),
        ).toEqual([]);
        expect(await isHeldForLearn(ITEM)).toBe(false);
        expect(
            (await gatherFacts(ITEM, "private", OWNER)).phases.learn?.state,
        ).toBe("done");
        expect(
            (
                await db()
                    .select()
                    .from(transcriptCorrectionPasses)
                    .where(eq(transcriptCorrectionPasses.recordingId, ITEM))
            )[0]?.status,
        ).toBe("cancelled");
        expect(
            (
                await db()
                    .select()
                    .from(asyncJobs)
                    .where(
                        and(
                            eq(asyncJobs.kind, "learn.correct"),
                            eq(asyncJobs.userId, OWNER),
                        ),
                    )
            )[0]?.status,
        ).toBe("failed");
    });

    it.each([
        false,
        true,
    ])("keeps a chosen private contact private while promoting a record the review created (older metadata: %s)", async (older) => {
        const contactId = "settles-chosen-contact";
        await db()
            .insert(people)
            .values({
                id: contactId,
                userId: OWNER,
                displayName: encryptText("Tala Wren"),
                primaryEmail: encryptText("tala-private@example.test"),
            });
        const source = await run({ status: "ready", finishedAt: null });
        const rows = await db()
            .insert(learnReviewItems)
            .values([
                {
                    runId: source.id,
                    userId: OWNER,
                    kind: "new_record",
                    fingerprintHmac: "chosen-contact",
                    decision: "accepted",
                    choice: encryptJsonField({ personId: contactId }),
                    payload: encryptJsonField({
                        ref: "chosen-ref",
                        kind: "person",
                        name: "Songbird",
                        typeKey: null,
                        evidenceMs: [],
                        reason: "mentioned",
                    }),
                },
                {
                    runId: source.id,
                    userId: OWNER,
                    kind: "new_record",
                    fingerprintHmac: "created-contact",
                    decision: "accepted",
                    payload: encryptJsonField({
                        ref: "created-ref",
                        kind: "person",
                        name: "Oren Swift",
                        typeKey: null,
                        evidenceMs: [],
                        reason: "mentioned",
                    }),
                },
            ])
            .returning();
        expect(
            (
                await finishReview(await context(ITEM, "private"), OWNER, {
                    versions: Object.fromEntries(
                        rows.map((row) => [row.id, row.version]),
                    ),
                })
            ).applied,
        ).toBe(2);
        const created = (
            await db().select().from(people).where(eq(people.userId, OWNER))
        ).find((person) => decryptText(person.displayName) === "Oren Swift");
        if (!created) throw new Error("missing created contact");
        const [finished] = await db()
            .select()
            .from(learnRuns)
            .where(
                and(eq(learnRuns.id, source.id), eq(learnRuns.userId, OWNER)),
            );
        expect(finished?.inputs?.confirmedRecords).toEqual([
            { personId: created.id },
        ]);
        if (older) {
            const { confirmedRecords: _created, ...inputs } =
                finished?.inputs ?? {};
            await db()
                .update(learnRuns)
                .set({ inputs })
                .where(
                    and(
                        eq(learnRuns.id, source.id),
                        eq(learnRuns.userId, OWNER),
                    ),
                );
        }
        await share();
        expect(
            (
                await db().select().from(people).where(eq(people.id, contactId))
            )[0]?.userId,
        ).toBe(OWNER);
        expect(
            (
                await db()
                    .select()
                    .from(people)
                    .where(eq(people.id, created.id))
            )[0]?.userId,
        ).toBe(orgUserId);
        expect(
            (
                await db()
                    .select()
                    .from(knowledgeAliases)
                    .where(eq(knowledgeAliases.personId, contactId))
            )[0]?.userId,
        ).toBe(OWNER);
    });

    it("publishes standalone records from older runs and derives their stored outcome counts", async () => {
        const [person] = await db()
            .insert(people)
            .values({ userId: OWNER, displayName: encryptText("Sol Wren") })
            .returning();
        const entity = await createEntity(OWNER, {
            typeKey: "project",
            name: "Swift Hangar",
        });
        const source = await run({
            stats: { kept_new_record: 2 },
            createdAt: new Date(Date.now() - 60_000),
        });
        await db()
            .insert(learnReviewItems)
            .values([
                {
                    runId: source.id,
                    userId: OWNER,
                    kind: "new_record",
                    fingerprintHmac: "older-person",
                    outcome: "applied",
                    decision: "accepted",
                    payload: encryptJsonField({
                        kind: "person",
                        name: "Sol Wren",
                        typeKey: null,
                    }),
                },
                {
                    runId: source.id,
                    userId: OWNER,
                    kind: "new_record",
                    fingerprintHmac: "older-entity",
                    outcome: "applied",
                    decision: "accepted",
                    payload: encryptJsonField({
                        kind: "entity",
                        name: "Swift Hangar",
                        typeKey: "project",
                    }),
                },
            ]);
        await share();
        expect(
            (
                await db()
                    .select()
                    .from(people)
                    .where(eq(people.id, person?.id ?? ""))
            )[0]?.userId,
        ).toBe(orgUserId);
        expect(
            (
                await db()
                    .select()
                    .from(knowledgeEntities)
                    .where(eq(knowledgeEntities.id, entity.id))
            )[0]?.userId,
        ).toBe(orgUserId);
        expect((await loadReview(await context())).run?.sharedReview).toEqual({
            applied: 2,
            skipped: 0,
            dismissed: 0,
        });
    });

    it("keeps ambiguous same-named people private for older runs and still writes a receipt", async () => {
        const personIds = [
            "settles-ambiguous-first",
            "settles-ambiguous-second",
        ];
        const source = await run({
            stats: { kept_new_record: 1 },
            createdAt: new Date("2026-10-01T10:00:00.000Z"),
            finishedAt: new Date("2026-10-01T10:01:00.000Z"),
        });
        expect(source.inputs?.confirmedRecords).toBeUndefined();
        await db()
            .insert(people)
            .values(
                personIds.map((id) => ({
                    id,
                    userId: OWNER,
                    displayName: encryptText("Luma Kestrel"),
                    createdAt: new Date("2026-10-01T10:00:30.000Z"),
                })),
            );
        await db()
            .insert(learnReviewItems)
            .values({
                runId: source.id,
                userId: OWNER,
                kind: "new_record",
                fingerprintHmac: "ambiguous-older-person",
                outcome: "applied",
                decision: "accepted",
                choice: encryptJsonField({ name: "Luma Kestrel" }),
                payload: encryptJsonField({
                    kind: "person",
                    name: "Luma",
                    typeKey: null,
                }),
            });
        await share();
        expect(
            await db()
                .select({ id: people.id })
                .from(people)
                .where(
                    and(
                        eq(people.userId, OWNER),
                        inArray(people.id, personIds),
                    ),
                ),
        ).toHaveLength(2);
        expect(await orgRuns()).toEqual([
            expect.objectContaining({
                status: "finished",
                scopeUserId: orgUserId,
                inputs: expect.objectContaining({
                    promotedFromRunId: source.id,
                }),
                stats: { applied: 1, skipped: 0, dismissed: 0 },
            }),
        ]);
    });

    it("does not promote an older run's entity when its new-record type key is absent", async () => {
        const entity = await createEntity(OWNER, {
            typeKey: "project",
            name: "Kestrel Atrium",
        });
        const source = await run({
            stats: { kept_new_record: 1 },
            createdAt: new Date(entity.createdAt.getTime() - 1_000),
            finishedAt: new Date(entity.createdAt.getTime() + 1_000),
        });
        expect(source.inputs?.confirmedRecords).toBeUndefined();
        await db()
            .insert(learnReviewItems)
            .values({
                runId: source.id,
                userId: OWNER,
                kind: "new_record",
                fingerprintHmac: "older-entity-without-type",
                outcome: "applied",
                decision: "accepted",
                payload: encryptJsonField({
                    kind: "entity",
                    name: "Kestrel Atrium",
                }),
            });
        await share();
        expect(
            await db()
                .select({ id: knowledgeEntities.id })
                .from(knowledgeEntities)
                .where(
                    and(
                        eq(knowledgeEntities.userId, OWNER),
                        eq(knowledgeEntities.id, entity.id),
                    ),
                ),
        ).toEqual([{ id: entity.id }]);
        expect(await orgRuns()).toEqual([
            expect.objectContaining({
                status: "finished",
                scopeUserId: orgUserId,
                inputs: expect.objectContaining({
                    promotedFromRunId: source.id,
                }),
                stats: { applied: 1, skipped: 0, dismissed: 0 },
            }),
        ]);
    });

    it("keeps unknown historical outcome counts unknown and does not promote unproven records", async () => {
        const [person] = await db()
            .insert(people)
            .values({ userId: OWNER, displayName: encryptText("Sol Wren") })
            .returning();
        const source = await run({ stats: { kept_new_record: 1 } });
        await db()
            .insert(learnReviewItems)
            .values({
                runId: source.id,
                userId: OWNER,
                kind: "new_record",
                fingerprintHmac: "unknown-outcome",
                decision: "accepted",
                payload: encryptJsonField({
                    kind: "person",
                    name: "Sol Wren",
                    typeKey: null,
                }),
            });
        await share();
        expect((await loadReview(await context())).run?.sharedReview).toEqual({
            applied: null,
            skipped: null,
            dismissed: null,
        });
        expect(
            (
                await db()
                    .select()
                    .from(people)
                    .where(eq(people.id, person?.id ?? ""))
            )[0]?.userId,
        ).toBe(OWNER);
    });

    it("does not promote another owner's record through saved review references", async () => {
        await db()
            .insert(users)
            .values({ id: "settles-other-owner", email: "other@example.test" });
        const [other] = await db()
            .insert(people)
            .values({
                userId: "settles-other-owner",
                displayName: encryptText("Ada Wren"),
            })
            .returning();
        await run({
            inputs: {
                contentId: transcriptId,
                contentRevision: 0,
                confirmedRecords: [{ personId: other?.id }],
            },
        });
        await share();
        expect(
            (
                await db()
                    .select()
                    .from(people)
                    .where(eq(people.id, other?.id ?? ""))
            )[0]?.userId,
        ).toBe("settles-other-owner");
    });

    it("settles mail through the same publication path", async () => {
        const mailId = "settles-mail";
        await db()
            .insert(chatterItems)
            .values({
                id: mailId,
                kind: "mail",
                userId: OWNER,
                title: encryptText("Lark update"),
                occurredAt: new Date(),
            });
        await db()
            .insert(mailMessages)
            .values({
                id: mailId,
                userId: OWNER,
                rawHash: "invented-hash",
                receivedAt: new Date(),
                sizeBytes: 30,
                auth: encryptJsonField({}),
                senderVerified: true,
            });
        const [content] = await db()
            .insert(mailContents)
            .values({
                itemId: mailId,
                userId: OWNER,
                parserVersion: 1,
                segments: encryptJsonField([]),
            })
            .returning();
        if (!content) throw new Error("missing mail content");
        await run({
            itemId: mailId,
            transcriptionId: null,
            inputs: {
                contentId: content.id,
                contentRevision: 0,
                contentSourceId: "mail",
                confirmedRecords: [{ personId: PERSON }],
            },
        });
        await share(mailId);
        expect(
            (await db().select().from(people).where(eq(people.id, PERSON)))[0]
                ?.userId,
        ).toBe(orgUserId);
        expect((await loadReview(await context(mailId))).run?.status).toBe(
            "finished",
        );
        expect(
            (
                await loadPrivateItemProcessing(
                    OWNER,
                    mailId,
                    orgUserId,
                    "en",
                    "org",
                )
            )?.outputs.learn,
        ).toBe(true);
        await unshareRecording(OWNER, mailId, { withdraw: true });
        expect(await orgRuns(mailId)).toEqual([]);
        await share(mailId);
        expect(await orgRuns(mailId)).toHaveLength(1);
    });

    it("leaves private reviews alone without an Organization share", async () => {
        const source = await run();
        const [privateFolder] = await db()
            .insert(recordingFolders)
            .values({
                userId: OWNER,
                kind: "custom",
                name: encryptText("Skylark archive"),
                nameHash: "private-archive",
            })
            .returning();
        if (!privateFolder) throw new Error("missing private folder");
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: ITEM,
            folderId: privateFolder.id,
        });
        expect(
            await db()
                .select()
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.userId, OWNER),
                        eq(recordingFolderAssignments.itemId, ITEM),
                        eq(
                            recordingFolderAssignments.folderId,
                            privateFolder.id,
                        ),
                    ),
                ),
        ).toHaveLength(1);
        expect(
            (await loadReview(await context(ITEM, "private"))).run?.status,
        ).toBe("finished");
        expect(await orgRuns()).toEqual([]);
        expect(
            await db()
                .select()
                .from(learnRuns)
                .where(eq(learnRuns.id, source.id)),
        ).toEqual([source]);
    });
});
