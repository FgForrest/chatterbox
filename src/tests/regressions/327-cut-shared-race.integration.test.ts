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
    asyncJobs,
    chatterItems,
    itemProcessing,
    mailPendingShares,
    processingProfileRevisions,
    processingProfiles,
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

const mocks = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        ref,
        exports: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
        notify: vi.fn().mockResolvedValue(undefined),
        orgLookup: vi.fn().mockResolvedValue("org"),
        proxy: new Proxy(
            {},
            {
                get(_target, key) {
                    const value = ref.current?.[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
    };
});
vi.mock("@/db", () => ({ db: mocks.proxy }));
vi.mock("@/lib/env", () => ({
    env: {
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        BETTER_AUTH_SECRET: "cut-shared-regression",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: mocks.orgLookup,
    isOrgScopeEnabled: () => true,
    isOrgScopeVisible: () => true,
    assertOrgScopeWritable: () => {},
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: mocks.exports,
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: async () => ({ deleteFile: mocks.deleteFile }),
}));
vi.mock("@/lib/org/events", () => ({ notifyOrgChange: mocks.notify }));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async () => false,
}));

import {
    buryExhaustedStaleJobs,
    claimDueJobs,
    completeJob,
    failJobAttempt,
    settleTerminalJobInTx,
} from "@/db/queries/async-jobs";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { lockOrgTree } from "@/lib/folders/folders";
import { lockOrgPeople } from "@/lib/knowledge/org-people";
import { modelInput } from "@/lib/learn/llm-input";
import {
    enqueuePipelineAction,
    pipelineActionJobHandler,
} from "@/lib/pipeline/action-job";
import { gatherFacts } from "@/lib/pipeline/facts";
import { planAdvance } from "@/lib/pipeline/plan";
import { executeIntendedSharesWithOutcome } from "@/lib/pipeline/share-intent";
import type { PipelineFacts } from "@/lib/pipeline/types";
import { requestRecordingCut } from "@/lib/recordings/cut";
import {
    commitRecordingCut,
    recordingCutJobHandler,
} from "@/lib/recordings/cut-job-handler";
import type { StoredTrimProposal } from "@/lib/recordings/trim-proposal";
import { requireRecordingView } from "@/lib/sharing/access";
import { lockItemTaskGraphInTx } from "@/lib/tasks/mentions";
import { insertRecordings } from "@/tests/integration/items";
import { seededAudioProfileSettings } from "@/tests/profiles/seeded-profile-fixture";

const url = getTestDatabaseUrl();
const range = { startMs: 2000, endMs: 8000 };
describe.skipIf(!url)(
    "#327 shared cuts and intended-share serialization",
    () => {
        let database: TestPostgresDatabase;
        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                url ?? "",
                "cut_share_race",
            );
            mocks.ref.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
        }, 120000);
        afterAll(async () => {
            mocks.ref.current = null;
            await database?.dispose();
        }, 30000);
        beforeEach(async () => {
            vi.clearAllMocks();
            mocks.deleteFile.mockReset().mockResolvedValue(undefined);
            mocks.orgLookup.mockReset().mockResolvedValue("org");
            const db = database.db;
            await db.delete(users);
            await db.insert(users).values([
                { id: "owner", email: "owner@example.test" },
                { id: "org", email: "org@example.test", role: "org" },
            ]);
            await insertRecordings(db, {
                id: "recording",
                userId: "owner",
                filename: encryptText("Generated title"),
                duration: 10000,
                startTime: new Date(),
                endTime: new Date(),
                filesize: 10,
                deviceSn: "local",
                plaudFileId: "uploaded",
                fileMd5: "a".repeat(32),
                storageType: "local",
                storagePath: "owner/audio.ogg",
                plaudVersion: "1",
                audioReapedAt: new Date(),
            });
            await db.insert(transcriptions).values({
                id: "transcript",
                recordingId: "recording",
                userId: "owner",
                text: encryptText("Opening. Kept words. Ending."),
                turns: encryptJsonField([
                    {
                        speaker: "S1",
                        startMs: 0,
                        endMs: 2000,
                        text: "Opening.",
                    },
                    {
                        speaker: "S1",
                        startMs: 2000,
                        endMs: 8000,
                        text: "Kept words.",
                    },
                    {
                        speaker: "S1",
                        startMs: 8000,
                        endMs: 10000,
                        text: "Ending.",
                    },
                ]),
                source: "riffado",
                provider: "test",
                model: "test",
            });
            await db.insert(transcriptSpeakers).values({
                userId: "owner",
                transcriptionId: "transcript",
                label: "S1",
                markedUnknown: true,
                status: "confirmed",
                source: "user",
                confirmedByUserId: "owner",
            });
            await db.insert(recordingFolders).values({
                id: "org-root",
                userId: "org",
                kind: "public",
                name: encryptText("Organization"),
                nameHash: "root",
            });
            await db.insert(recordingFolders).values({
                id: "org-folder",
                userId: "org",
                parentId: "org-root",
                kind: "custom",
                name: encryptText("Meetings"),
                nameHash: "meetings",
            });
            const settings = seededAudioProfileSettings({
                autoSummarize: true,
                autoDetectTopics: true,
            });
            settings.steps.trim.automatic = false;
            await db.insert(processingProfiles).values({
                id: "profile",
                ownerUserId: "owner",
                scope: "personal",
                channel: "audio",
                name: encryptText("Profile"),
                currentRevisionId: "revision",
            });
            await db.insert(processingProfileRevisions).values({
                id: "revision",
                profileId: "profile",
                settings: encryptText(JSON.stringify(settings)),
            });
            await db.insert(itemProcessing).values({
                itemId: "recording",
                userId: "owner",
                view: "private",
                profileId: "profile",
                profileRevisionId: "revision",
                requestedGeneration: 1,
                phases: {
                    categorize: {
                        state: "done",
                        generation: 1,
                        at: new Date().toISOString(),
                    },
                    summary: {
                        state: "done",
                        generation: 1,
                        at: new Date().toISOString(),
                        steps: {
                            title: {
                                state: "done",
                                contentId: "transcript",
                                contentRevision: 0,
                                generation: 1,
                            },
                        },
                    },
                },
            });
            await db.insert(aiEnhancements).values({
                itemId: "recording",
                userId: "owner",
                source: "riffado",
                provider: "test",
                model: "test",
                summary: encryptText("Old summary"),
            });
        });
        async function facts(): Promise<PipelineFacts> {
            const result = await gatherFacts("recording", "private", "owner", {
                legacyIfEmpty: false,
            });
            return {
                ...result,
                hasEnhancementCredential: true,
                stepAvailability: {
                    summary: "available",
                    topics: "available",
                    title: "available",
                },
            };
        }
        async function cutJob() {
            await requestRecordingCut("owner", "recording", range);
            const [job] = await claimDueJobs("recording.cut", 1);
            return {
                ...job,
                payload: recordingCutJobHandler.parsePayload(job.payload),
            };
        }
        async function commit(job: Awaited<ReturnType<typeof cutJob>>) {
            await database.db.transaction(async (tx) => {
                await lockOrgTree(tx);
                await lockOrgPeople(tx);
                await lockItemTaskGraphInTx(tx, {
                    itemId: "recording",
                    ownerUserId: "owner",
                });
                await commitRecordingCut(
                    tx,
                    "owner",
                    job.id,
                    job.payload,
                    null,
                    "org",
                    job.claimToken,
                );
            });
        }
        it("commits an accepted trim proposal and settles the retained revision without proposing again", async () => {
            const db = database.db;
            const [transcript] = await db
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.id, "transcript"));
            const fingerprint = (await modelInput(transcript)).fingerprint;
            if (!fingerprint) throw new Error("Missing input fingerprint");
            const proposal: StoredTrimProposal = {
                schemaVersion: 1,
                id: "reviewed-trim",
                promptVersion: 1,
                createdAt: new Date().toISOString(),
                deadline: new Date(Date.now() + 14_400_000).toISOString(),
                transcript: {
                    id: "transcript",
                    source: "riffado",
                    revision: 0,
                },
                revisions: [{ id: "transcript", revision: 0 }],
                inputFingerprint: fingerprint,
                audio: {
                    duration: 10000,
                    fileMd5: "a".repeat(32),
                    cutAt: null,
                },
                profileRevisionId: "revision",
                provider: {
                    credentialId: "chat",
                    provider: "Custom",
                    model: "fake",
                    payerUserId: "owner",
                },
                start: {
                    firstKeptSentenceId: "t1s0",
                    startMs: 2000,
                    reason: "Unrelated opening",
                },
                end: {
                    firstRemovedSentenceId: "t2s0",
                    startMs: 8000,
                    reason: "Unrelated ending",
                },
            };
            await db
                .update(recordings)
                .set({ trimProposal: encryptJsonField(proposal) })
                .where(
                    and(
                        eq(recordings.id, "recording"),
                        eq(recordings.userId, "owner"),
                    ),
                );
            const [processing] = await db
                .select()
                .from(itemProcessing)
                .where(eq(itemProcessing.view, "private"));
            await db
                .update(itemProcessing)
                .set({
                    phases: {
                        ...processing.phases,
                        trim: {
                            proposalId: proposal.id,
                            state: "waiting",
                            generation: 1,
                            at: proposal.createdAt,
                            inputs: {
                                contentId: "transcript",
                                contentSourceId: "riffado",
                                contentRevision: 0,
                            },
                            waitingFor: {
                                kind: "trimReview",
                                until: proposal.deadline,
                            },
                        },
                    },
                })
                .where(
                    and(
                        eq(itemProcessing.itemId, "recording"),
                        eq(itemProcessing.view, "private"),
                    ),
                );
            await requestRecordingCut("owner", "recording", {
                ...range,
                revisions: [{ id: "transcript", revision: 0 }],
                trimProposalId: proposal.id,
            });
            const [claimed] = await claimDueJobs("recording.cut", 1);
            const job = {
                ...claimed,
                payload: recordingCutJobHandler.parsePayload(claimed.payload),
            };
            await commit(job);
            const [retained] = await db
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.id, "transcript"));
            expect(decryptText(retained.text)).toBe("S1: Kept words.");
            const [recording] = await db
                .select()
                .from(recordings)
                .where(eq(recordings.id, "recording"));
            expect(recording.trimProposal).toBeNull();
            const after = await facts();
            expect(after.phases.trim).toMatchObject({
                state: "done",
                reason: "cut_applied",
                inputs: { contentId: "transcript", contentRevision: 1 },
            });
            if (after.profile) after.profile.trim = { automatic: true };
            expect(
                planAdvance(after).actions.some(
                    (action) => action.type === "queueTrim",
                ),
            ).toBe(false);
        });
        it("resets the shared content and both stored views, then replans both export scopes", async () => {
            const db = database.db;
            await db.insert(recordingFolderAssignments).values({
                itemId: "recording",
                userId: "owner",
                folderId: "org-folder",
            });
            await db
                .update(itemProcessing)
                .set({
                    phases: {
                        categorize: {
                            state: "done",
                            generation: 1,
                            at: new Date().toISOString(),
                        },
                    },
                })
                .where(eq(itemProcessing.view, "private"));
            await db.insert(itemProcessing).values({
                itemId: "recording",
                userId: "owner",
                view: "org",
                phases: {
                    summary: {
                        state: "done",
                        generation: 1,
                        at: new Date().toISOString(),
                        steps: {
                            title: {
                                state: "done",
                                contentId: "transcript",
                                contentRevision: 0,
                                generation: 1,
                            },
                        },
                    },
                },
            });
            await db.insert(asyncJobs).values([
                {
                    id: "org-summary",
                    userId: "org",
                    subjectId: "org:recording",
                    kind: "summary",
                    status: "processing",
                },
                {
                    id: "owner-topics",
                    userId: "owner",
                    subjectId: "recording",
                    kind: "topics",
                    status: "pending",
                },
                {
                    id: "stale-share",
                    userId: "owner",
                    subjectId: "executeShares:recording",
                    kind: "pipeline.action",
                    status: "pending",
                },
            ]);
            const job = await cutJob();
            await recordingCutJobHandler.run({
                userId: "owner",
                jobId: job.id,
                payload: job.payload,
                attempt: 1,
                maxAttempts: 3,
                signal: new AbortController().signal,
                reportProgress: vi.fn(),
            });
            expect(
                await db.select().from(recordingFolderAssignments),
            ).toMatchObject([{ itemId: "recording", folderId: "org-folder" }]);
            const orgAccess = await requireRecordingView(
                "org",
                "recording",
                "org",
            );
            expect(orgAccess.contentUserId).toBe("owner");
            expect(await db.select().from(aiEnhancements)).toEqual([]);
            expect(
                decryptText((await db.select().from(chatterItems))[0].title),
            ).toBe("");
            expect((await db.select().from(transcriptions))[0]).toMatchObject({
                revision: 1,
                topics: null,
            });
            for (const row of await db.select().from(itemProcessing))
                expect(row.phases.summary).toBeUndefined();
            for (const id of ["org-summary", "owner-topics", "stale-share"])
                expect(
                    (
                        await db
                            .select()
                            .from(asyncJobs)
                            .where(eq(asyncJobs.id, id))
                    )[0].status,
                ).toBe("failed");
            expect(planAdvance(await facts()).actions).toContainEqual({
                type: "queueSummary",
                presetId: null,
                strict: true,
            });
            expect(mocks.exports).toHaveBeenCalledWith("owner");
            expect(mocks.exports).toHaveBeenCalledWith("org");
        });
        it("holds every intent while pending and processing, then shares only after fresh summary planning", async () => {
            const db = database.db;
            await db.insert(mailPendingShares).values({
                itemId: "recording",
                userId: "owner",
                folderId: "org-folder",
            });
            const queued = await requestRecordingCut(
                "owner",
                "recording",
                range,
            );
            for (const status of ["pending", "processing"] as const) {
                await db
                    .update(asyncJobs)
                    .set({ status })
                    .where(eq(asyncJobs.id, queued.id));
                const before = await facts();
                expect(before.share?.cutJobActive).toBe(true);
                expect(
                    planAdvance(before).actions.some(
                        (action) => action.type === "executeShares",
                    ),
                ).toBe(false);
                const log = vi.spyOn(console, "info");
                expect(
                    await executeIntendedSharesWithOutcome(
                        "owner",
                        "recording",
                    ),
                ).toMatchObject({
                    shared: false,
                    remaining: true,
                    waitingForCut: true,
                });
                expect(
                    log.mock.calls.filter(
                        ([line]) =>
                            line ===
                            "[share] waiting item=recording reason=cut",
                    ),
                ).toHaveLength(1);
                log.mockRestore();
                expect(await db.select().from(mailPendingShares)).toHaveLength(
                    1,
                );
                expect(
                    await db.select().from(recordingFolderAssignments),
                ).toEqual([]);
            }
            await db
                .update(asyncJobs)
                .set({ status: "pending" })
                .where(eq(asyncJobs.id, queued.id));
            const [claimed] = await claimDueJobs("recording.cut", 1);
            const job = {
                ...claimed,
                payload: recordingCutJobHandler.parsePayload(claimed.payload),
            };
            expect(
                recordingCutJobHandler.parsePayload({
                    ...job.payload,
                    withdraw: true,
                }),
            ).toEqual(job.payload);
            await commit(job);
            const afterCut = await facts();
            expect(
                planAdvance(afterCut).actions.some(
                    (action) => action.type === "queueSummary",
                ),
            ).toBe(true);
            expect(
                planAdvance(afterCut).actions.some(
                    (action) => action.type === "executeShares",
                ),
            ).toBe(false);
            await db
                .update(itemProcessing)
                .set({ processedGeneration: afterCut.generation })
                .where(eq(itemProcessing.view, "private"));
            await db
                .delete(asyncJobs)
                .where(eq(asyncJobs.kind, "pipeline.advance"));
            expect(
                await completeJob({
                    jobId: job.id,
                    claimToken: job.claimToken,
                }),
            ).toBe(true);
            const [processing] = await db
                .select()
                .from(itemProcessing)
                .where(eq(itemProcessing.view, "private"));
            expect(processing.requestedGeneration).toBeGreaterThan(
                afterCut.generation,
            );
            expect(
                await db
                    .select()
                    .from(asyncJobs)
                    .where(eq(asyncJobs.kind, "pipeline.advance")),
            ).toHaveLength(1);
            await db.insert(asyncJobs).values({
                id: "fresh-summary",
                userId: "owner",
                kind: "summary",
                subjectId: "recording",
                status: "processing",
            });
            expect(
                planAdvance(await facts()).actions.some(
                    (action) => action.type === "executeShares",
                ),
            ).toBe(false);
            await db
                .update(asyncJobs)
                .set({ status: "completed" })
                .where(eq(asyncJobs.id, "fresh-summary"));
            const ready = await facts();
            const content = ready.content;
            if (!content) throw new Error("Missing retained transcript");
            await db.insert(aiEnhancements).values({
                itemId: "recording",
                userId: "owner",
                source: "riffado",
                provider: "test",
                model: "test",
                summary: encryptText("Kept words summary"),
                inputs: {
                    contentId: content.contentId,
                    contentSourceId: content.contentSourceId,
                    contentRevision: content.contentRevision,
                    itemProfileRevisionId: "revision",
                },
            });
            await db
                .update(itemProcessing)
                .set({
                    phases: {
                        categorize: processing.phases.categorize,
                        summary: {
                            state: "done",
                            generation: ready.generation,
                            at: new Date().toISOString(),
                            inputs: content,
                            steps: {
                                summary: {
                                    ...content,
                                    state: "done",
                                    generation: ready.generation,
                                },
                                topics: {
                                    ...content,
                                    state: "done",
                                    generation: ready.generation,
                                },
                                title: {
                                    ...content,
                                    state: "done",
                                    generation: ready.generation,
                                },
                            },
                        },
                    },
                })
                .where(eq(itemProcessing.view, "private"));
            expect(planAdvance(await facts()).actions).toContainEqual({
                type: "executeShares",
            });
            const log = vi.spyOn(console, "info");
            expect(
                await executeIntendedSharesWithOutcome("owner", "recording"),
            ).toMatchObject({ shared: true, remaining: false });
            expect(log).toHaveBeenCalledWith(
                "[share] filed item=recording folder=org-folder",
            );
            log.mockRestore();
            expect(await db.select().from(mailPendingShares)).toEqual([]);
            expect(
                await db.select().from(recordingFolderAssignments),
            ).toMatchObject([{ folderId: "org-folder" }]);
            expect(
                decryptText((await db.select().from(transcriptions))[0].text),
            ).toBe("S1: Kept words.");
        });
        it("serializes the share recheck behind the cut transaction's item lock", async () => {
            const db = database.db;
            await db.insert(mailPendingShares).values({
                itemId: "recording",
                userId: "owner",
                folderId: "org-folder",
            });
            const job = await cutJob();
            const locked = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const cutting = db.transaction(async (tx) => {
                await lockOrgTree(tx);
                await lockOrgPeople(tx);
                await lockItemTaskGraphInTx(tx, {
                    itemId: "recording",
                    ownerUserId: "owner",
                });
                locked.resolve();
                await release.promise;
                await commitRecordingCut(
                    tx,
                    "owner",
                    job.id,
                    job.payload,
                    null,
                    "org",
                    job.claimToken,
                );
            });
            await locked.promise;
            let finished = false;
            const sharing = executeIntendedSharesWithOutcome(
                "owner",
                "recording",
            ).then((result) => {
                finished = true;
                return result;
            });
            try {
                await new Promise((resolve) => setTimeout(resolve, 30));
                expect(finished).toBe(false);
            } finally {
                release.resolve();
            }
            await cutting;
            expect(await sharing).toMatchObject({
                shared: false,
                remaining: true,
                waitingForCut: true,
            });
        });

        it.each([
            "completed",
            "failed",
            "cancelled",
            "lost",
        ])("wakes a cut-held share that settles after the cut %s and its planner", async (ending) => {
            const db = database.db;
            await db.insert(mailPendingShares).values({
                itemId: "recording",
                userId: "owner",
                folderId: "org-folder",
            });
            await enqueuePipelineAction("owner", "recording", {
                type: "executeShares",
            });
            const [share] = await claimDueJobs("pipeline.action", 1);
            const cut = await cutJob();
            const result = await pipelineActionJobHandler.run({
                userId: "owner",
                jobId: share.id,
                claimToken: share.claimToken,
                payload: pipelineActionJobHandler.parsePayload(share.payload),
                attempt: share.attempts,
                maxAttempts: share.maxAttempts,
                signal: new AbortController().signal,
                reportProgress: vi.fn(),
            });
            expect(result).toMatchObject({
                outcome: { kind: "waiting", reason: "cut" },
            });
            if (ending === "completed")
                await completeJob({
                    jobId: cut.id,
                    claimToken: cut.claimToken,
                });
            else if (ending === "cancelled")
                await db.transaction((tx) =>
                    settleTerminalJobInTx(tx, {
                        jobId: cut.id,
                        cancelForUserId: "owner",
                        status: "failed",
                        code: "cancelled",
                    }),
                );
            else if (ending === "lost") {
                await db
                    .update(asyncJobs)
                    .set({ attempts: 3, heartbeatAt: new Date(0) })
                    .where(eq(asyncJobs.id, cut.id));
                expect(await buryExhaustedStaleJobs(1000)).toBe(1);
            } else
                await failJobAttempt({
                    jobId: cut.id,
                    claimToken: cut.claimToken,
                    message: "failed",
                    code: "CONFLICT",
                    retryable: false,
                    delayMs: 0,
                });
            const before = await facts();
            expect(
                planAdvance(before).actions.some(
                    (a) => a.type === "executeShares",
                ),
            ).toBe(false);
            await db
                .update(itemProcessing)
                .set({ processedGeneration: before.generation })
                .where(eq(itemProcessing.view, "private"));
            await db
                .delete(asyncJobs)
                .where(eq(asyncJobs.kind, "pipeline.advance"));
            expect(
                await completeJob({
                    jobId: share.id,
                    claimToken: share.claimToken,
                    result: result ?? null,
                }),
            ).toBe(true);
            const [processing] = await db
                .select()
                .from(itemProcessing)
                .where(eq(itemProcessing.view, "private"));
            expect(processing.requestedGeneration).toBeGreaterThan(
                processing.processedGeneration,
            );
            expect(
                await db
                    .select()
                    .from(asyncJobs)
                    .where(eq(asyncJobs.kind, "pipeline.advance")),
            ).toHaveLength(1);
            expect(await db.select().from(mailPendingShares)).toHaveLength(1);
        });
        it("does not wake a share waiting for confirmation", async () => {
            const db = database.db;
            await enqueuePipelineAction("owner", "recording", {
                type: "executeShares",
            });
            const [share] = await claimDueJobs("pipeline.action", 1);
            const before = await facts();
            await db
                .delete(asyncJobs)
                .where(eq(asyncJobs.kind, "pipeline.advance"));
            await completeJob({
                jobId: share.id,
                claimToken: share.claimToken,
                result: {
                    outcome: {
                        kind: "waiting",
                        reason: "confirmation_required",
                        waitingFor: { kind: "confirmation" },
                    },
                },
            });
            expect((await facts()).generation).toBe(before.generation);
            expect(
                await db
                    .select()
                    .from(asyncJobs)
                    .where(eq(asyncJobs.kind, "pipeline.advance")),
            ).toHaveLength(0);
        });
        it("refuses a cancelled share claim after cut completion while the fresh summary is pending", async () => {
            const db = database.db;
            await db.insert(mailPendingShares).values({
                itemId: "recording",
                userId: "owner",
                folderId: "org-folder",
            });
            await enqueuePipelineAction("owner", "recording", {
                type: "executeShares",
            });
            const [share] = await claimDueJobs("pipeline.action", 1);
            const cut = await cutJob();
            const started = Promise.withResolvers<void>();
            const resume = Promise.withResolvers<string>();
            mocks.orgLookup.mockImplementationOnce(() => {
                started.resolve();
                return resume.promise;
            });
            const sharing = expect(
                pipelineActionJobHandler.run({
                    userId: "owner",
                    jobId: share.id,
                    claimToken: share.claimToken,
                    payload: pipelineActionJobHandler.parsePayload(
                        share.payload,
                    ),
                    attempt: share.attempts,
                    maxAttempts: share.maxAttempts,
                    signal: new AbortController().signal,
                    reportProgress: vi.fn(),
                }),
            ).rejects.toMatchObject({ code: "CONFLICT" });
            await started.promise;
            try {
                await commit(cut);
                await completeJob({
                    jobId: cut.id,
                    claimToken: cut.claimToken,
                });
                await db.insert(asyncJobs).values({
                    id: "fresh-summary",
                    userId: "owner",
                    kind: "summary",
                    subjectId: "recording",
                    status: "pending",
                });
            } finally {
                resume.resolve("org");
            }
            await sharing;
            expect(await db.select().from(mailPendingShares)).toHaveLength(1);
            expect(
                await db.select().from(recordingFolderAssignments),
            ).toHaveLength(0);
        });
        it("plans both export scopes and notifies readers despite cleanup failure on commit and recovery", async () => {
            const db = database.db;
            await db.insert(recordingFolderAssignments).values({
                itemId: "recording",
                userId: "owner",
                folderId: "org-folder",
            });
            mocks.deleteFile.mockRejectedValue(
                new Error("Storage unavailable"),
            );
            const job = await cutJob();
            for (let attempt = 1; attempt <= 2; attempt++) {
                await db
                    .update(asyncJobs)
                    .set({ attempts: attempt })
                    .where(eq(asyncJobs.id, job.id));
                const count = mocks.exports.mock.calls.length;
                await expect(
                    recordingCutJobHandler.run({
                        userId: "owner",
                        jobId: job.id,
                        payload: job.payload,
                        attempt,
                        maxAttempts: 3,
                        signal: new AbortController().signal,
                        reportProgress: vi.fn(),
                    }),
                ).rejects.toThrow("The recording could not be cut.");
                expect(mocks.exports.mock.calls.slice(count)).toEqual([
                    ["owner"],
                    ["org"],
                ]);
                expect(mocks.notify).toHaveBeenCalledTimes(attempt);
                expect(
                    (await db.select().from(transcriptions))[0].revision,
                ).toBe(1);
                expect(
                    await db
                        .select()
                        .from(asyncJobs)
                        .where(
                            eq(
                                asyncJobs.kind,
                                "recording-storage-reconciliation",
                            ),
                        ),
                ).toHaveLength(1);
            }
        });
        it("logs an exhausted stale cut failure exactly once", async () => {
            const job = await cutJob();
            await database.db
                .update(asyncJobs)
                .set({ attempts: 3, heartbeatAt: new Date(0) })
                .where(eq(asyncJobs.id, job.id));
            const log = vi.spyOn(console, "info");
            try {
                expect(await buryExhaustedStaleJobs(1000)).toBe(1);
                expect(await buryExhaustedStaleJobs(1000)).toBe(0);
                expect(
                    log.mock.calls.filter(([line]) =>
                        String(line).startsWith("[cut] failed"),
                    ),
                ).toEqual([
                    [
                        `[cut] failed recording=recording job=${job.id} code=lost`,
                    ],
                ]);
            } finally {
                log.mockRestore();
            }
        });
        it("wakes held shares after a terminal cut failure too", async () => {
            const job = await cutJob();
            await database.db
                .update(transcriptions)
                .set({ revision: 1 })
                .where(eq(transcriptions.id, "transcript"));
            const log = vi.spyOn(console, "info");
            await expect(
                recordingCutJobHandler.run({
                    userId: "owner",
                    jobId: job.id,
                    payload: job.payload,
                    attempt: 1,
                    maxAttempts: 3,
                    signal: new AbortController().signal,
                    reportProgress: vi.fn(),
                }),
            ).rejects.toMatchObject({ code: "CONFLICT" });
            expect(
                log.mock.calls.filter(([line]) =>
                    String(line).startsWith("[cut] failed"),
                ),
            ).toHaveLength(0);
            await database.db
                .delete(asyncJobs)
                .where(eq(asyncJobs.kind, "pipeline.advance"));
            expect(
                await failJobAttempt({
                    jobId: job.id,
                    claimToken: job.claimToken,
                    message:
                        "The recording or transcript changed. Reload it and choose the cut again.",
                    code: "CONFLICT",
                    retryable: false,
                    delayMs: 0,
                }),
            ).toMatchObject({ status: "failed" });
            expect(log).toHaveBeenCalledWith(
                `[cut] failed recording=recording job=${job.id} code=CONFLICT`,
            );
            expect(
                await failJobAttempt({
                    jobId: job.id,
                    claimToken: job.claimToken,
                    message: "late failure",
                    code: "CONFLICT",
                    retryable: false,
                    delayMs: 0,
                }),
            ).toBeNull();
            expect(
                log.mock.calls.filter(([line]) =>
                    String(line).startsWith("[cut] failed"),
                ),
            ).toHaveLength(1);
            log.mockRestore();
            expect(
                await database.db
                    .select()
                    .from(asyncJobs)
                    .where(
                        and(
                            eq(asyncJobs.kind, "pipeline.advance"),
                            eq(asyncJobs.subjectId, "recording"),
                        ),
                    ),
            ).toHaveLength(1);
        });
        it("scopes active summary jobs to their view and sees a cut from both views", async () => {
            await database.db.insert(asyncJobs).values({
                id: "private-summary",
                userId: "owner",
                subjectId: "recording",
                kind: "summary",
                status: "processing",
            });
            const orgFacts = () =>
                gatherFacts("recording", "org", "owner", {
                    legacyIfEmpty: false,
                });
            expect((await facts()).summary.jobActive).toBe(true);
            const org = await orgFacts();
            expect(org.summary.jobActive).toBe(false);
            expect(org.summary.phaseJobActive).toBe(false);
            expect(org.share?.cutJobActive).toBe(false);
            await requestRecordingCut("owner", "recording", range);
            const during = await orgFacts();
            expect(during.share?.cutJobActive).toBe(true);
            expect(during.summary.phaseJobActive).toBe(false);
            expect((await facts()).share?.cutJobActive).toBe(true);
        });
    },
);
