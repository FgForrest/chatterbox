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
import { POST } from "@/app/api/recordings/[id]/transcribe/route";
import { PUT } from "@/app/api/settings/ai/providers/[id]/route";
import {
    claimDueJobs,
    completeJob,
    failJobAttempt,
} from "@/db/queries/async-jobs";
import { listProviderRecoveryRowsInTx } from "@/db/queries/pipeline";
import {
    apiCredentials,
    asyncJobs,
    chatterItems,
    itemProcessing,
    learnRuns,
    processingProfileRevisions,
    recordingFolderAssignments,
    recordingFolders,
    transcriptions,
    users,
} from "@/db/schema";
import { setDefaultProvider } from "@/lib/ai/default-provider";
import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import { gatherFacts } from "@/lib/pipeline/facts";
import { planAdvance } from "@/lib/pipeline/plan";
import { requestProviderRecovery } from "@/lib/pipeline/provider-recovery";
import { sweepAutomaticTranscriptionRetries } from "@/lib/pipeline/sweep";
import { requestAdvance } from "@/lib/pipeline/trigger";
import type { PipelinePhases } from "@/lib/pipeline/types";
import {
    createOrganizationProvider,
    updateOrganizationProvider,
} from "@/lib/profiles/organization-providers";
import { resolveDefaultProfile } from "@/lib/profiles/resolve";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { enqueueTranscriptionJob } from "@/lib/transcription/transcription-job";
import { transcriptionJobHandler } from "@/lib/transcription/transcription-job-handler";
import { localActor } from "@/tests/helpers/session-actor";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, transcribe } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property) => {
                    if (!ref.current)
                        throw new Error("Database not initialized");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        transcribe: vi.fn(),
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "test-password",
            DATABASE_URL: "postgres://unused",
            AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 100,
            API_TOKEN_HASH_SECRET: "recovery-test-secret",
            BETTER_AUTH_SECRET: "recovery-test-secret",
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
vi.mock("@/lib/encryption", () => ({ decrypt: (value: string) => value }));
vi.mock("@/lib/encryption/fields", () => ({
    decryptJsonField: (value: unknown) => value,
    encryptJsonField: (value: unknown) => value,
    decryptText: (value: string | null) => value,
    encryptText: (value: string | null) => value,
}));
vi.mock("@/lib/transcription/transcribe-recording", () => ({
    transcribeRecording: transcribe,
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({
        user: { id: "member", email: "member@example.test" },
    }),
    requireApiSessionActor: async () => ({
        session: { user: { id: "member" } },
        actor: {
            kind: "user",
            actorId: "member",
            issuer: null,
            subject: null,
            capabilities: new Set(["use"]),
            clientId: null,
            clientPermissions: new Set(),
            verifiedAt: null,
        },
    }),
}));

const url = getTestDatabaseUrl();
const suite = url ? describe : describe.skip;
const at = () => new Date().toISOString();
const categorized = () => ({
    state: "done" as const,
    reason: "categorized",
    generation: 1,
    at: at(),
});
const blocked = (): PipelinePhases => ({
    categorize: categorized(),
    transcribe: {
        state: "failed",
        reason: "NO_TRANSCRIPTION_PROVIDER",
        automatic: true,
        generation: 1,
        at: at(),
    },
});

suite("workflow recovery after provider failure (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    const db = () => database.db;

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "workflow_recovery",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        vi.clearAllMocks();
        mockEnv.IS_HOSTED = false;
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: "member", email: "member@example.test" },
                { id: "other", email: "other@example.test" },
                { id: "organization", email: "org@example.test", role: "org" },
            ]);
        for (const userId of ["member", "other"]) {
            await db()
                .insert(recordingFolders)
                .values({
                    id: `root-${userId}`,
                    userId,
                    name: "Private",
                    nameHash: `root-${userId}`,
                    kind: "private",
                });
            await db()
                .insert(recordingFolders)
                .values({
                    id: `folder-${userId}`,
                    userId,
                    name: "Notes",
                    nameHash: `hash-${userId}`,
                    parentId: `root-${userId}`,
                    kind: "custom",
                });
        }
    });

    async function seed(
        itemId: string,
        userId = "member",
        learn = true,
        transcript = false,
    ) {
        await insertRecordings(db(), {
            id: itemId,
            userId,
            deviceSn: "local",
            plaudFileId: itemId,
            filename: "Recovery recording",
            duration: 1000,
            startTime: new Date(),
            endTime: new Date(),
            filesize: 10,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${userId}/${itemId}.mp3`,
            plaudVersion: "1",
        });
        const profile = await resolveDefaultProfile(userId, "audio");
        const settings = defaultProfileSettings("audio");
        settings.steps.transcribe.automatic = true;
        settings.steps.learn.automatic = learn;
        settings.steps.summary.automatic = true;
        settings.steps.topics.automatic = true;
        await db()
            .update(processingProfileRevisions)
            .set({ settings: JSON.stringify(settings) })
            .where(eq(processingProfileRevisions.id, profile.revisionId));
        await db()
            .insert(recordingFolderAssignments)
            .values({ itemId, userId, folderId: `folder-${userId}` });
        await db()
            .insert(itemProcessing)
            .values({
                itemId,
                userId,
                view: "private",
                profileId: profile.profile.id,
                profileRevisionId: profile.revisionId,
                requestedGeneration: 1,
                phases: { categorize: categorized() },
            });
        if (transcript) await writeTranscript(itemId, userId);
    }
    async function writeTranscript(itemId: string, userId = "member") {
        await db()
            .insert(transcriptions)
            .values({
                id: `transcript-${itemId}`,
                recordingId: itemId,
                userId,
                text: "Synthetic transcript",
                turns: [
                    {
                        speaker: "speaker_0",
                        text: "Synthetic transcript",
                        startMs: 0,
                        endMs: 1000,
                    },
                ],
                provider: "test",
                model: "test",
                source: "riffado",
                revision: 1,
            });
        await requestAdvance({
            itemId,
            userId,
            view: "private",
            reason: "transcript",
        });
    }
    async function processing(itemId: string, userId = "member") {
        const [row] = await db()
            .select()
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, itemId),
                    eq(itemProcessing.userId, userId),
                    eq(itemProcessing.view, "private"),
                ),
            );
        return row;
    }
    async function run(
        itemId: string,
        reason = "transcript",
        userId = "member",
    ) {
        await pipelineAdvanceJobHandler.run({
            jobId: `driver-${itemId}`,
            userId,
            attempt: 1,
            maxAttempts: 10,
            payload: { itemId, view: "private", reason },
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
    }
    async function credential(userId = "member", id = "provider") {
        await db().insert(apiCredentials).values({
            id,
            userId,
            provider: "openai",
            apiKey: "test-key",
            defaultModel: "test-model",
        });
        return id;
    }
    async function active(kind: string) {
        return db()
            .select()
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.kind, kind),
                    inArray(asyncJobs.status, ["pending", "processing"]),
                ),
            );
    }
    async function clearDrivers() {
        await db()
            .update(asyncJobs)
            .set({ status: "completed", completedAt: new Date() })
            .where(eq(asyncJobs.kind, "pipeline.advance"));
    }
    async function post(itemId: string, retranscribe = false) {
        return POST(
            new Request(
                `http://localhost/api/recordings/${itemId}/transcribe`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ retranscribe }),
                },
            ),
            { params: Promise.resolve({ id: itemId }) },
        );
    }

    it("replays failure, Organization defaults, manual success, Learn and the review hold without a duplicate paid retry", async () => {
        await seed("incident");
        expect(
            (await gatherFacts("incident", "private", "member")).profile
                ?.transcribe?.automatic,
        ).toBe(true);
        await run("incident", "categorized");
        const [automatic] = await active("transcription");
        expect(automatic.payload).toMatchObject({
            trigger: "pipeline",
            force: false,
        });
        transcribe.mockResolvedValue({
            success: false,
            errorCode: "NO_TRANSCRIPTION_PROVIDER",
        });
        const [automaticClaim] = await claimDueJobs("transcription", 1);
        const payload = transcriptionJobHandler.parsePayload(automatic.payload);
        await expect(
            transcriptionJobHandler.run({
                jobId: automatic.id,
                userId: "member",
                attempt: 1,
                maxAttempts: 3,
                payload,
                signal: new AbortController().signal,
                reportProgress: vi.fn(),
            }),
        ).rejects.toMatchObject({ code: "NO_TRANSCRIPTION_PROVIDER" });
        await failJobAttempt({
            jobId: automatic.id,
            claimToken: automaticClaim.claimToken,
            message: "No provider",
            code: "NO_TRANSCRIPTION_PROVIDER",
            retryable: false,
            delayMs: 0,
        });
        await run("incident", "transcription-failed");
        expect((await processing("incident")).phases.transcribe).toMatchObject({
            state: "failed",
            reason: "NO_TRANSCRIPTION_PROVIDER",
        });
        await credential("organization", "org-provider");
        await setDefaultProvider(
            "organization",
            "transcription",
            "org-provider",
        );
        await setDefaultProvider("organization", "summary", "org-provider");
        expect(
            (await active("pipeline.advance")).map((job) => job.subjectId),
        ).toContain("incident");
        const response = await post("incident");
        expect(response.status).toBe(202);
        const first = await response.json();
        const [manualClaim] = await claimDueJobs("transcription", 1);
        const joined = await post("incident", true);
        expect(joined.status).toBe(202);
        expect(await joined.json()).toMatchObject({
            jobId: first.jobId,
            created: false,
        });
        expect(await active("transcription")).toHaveLength(1);
        transcribe.mockImplementationOnce(async () => {
            await writeTranscript("incident");
            return { success: true };
        });
        const manual = (await active("transcription"))[0];
        await expect(
            transcriptionJobHandler.run({
                jobId: manual.id,
                userId: "member",
                attempt: 1,
                maxAttempts: 3,
                payload: transcriptionJobHandler.parsePayload(manual.payload),
                signal: new AbortController().signal,
                reportProgress: vi.fn(),
            }),
        ).resolves.toEqual({
            transcribed: true,
            outcome: { kind: "done", reason: "content-available" },
        });
        await completeJob({
            jobId: first.jobId,
            claimToken: manualClaim.claimToken,
            result: { outcome: { kind: "done", reason: "content-available" } },
        });
        await run("incident");
        expect((await processing("incident")).phases.learn?.state).toBe(
            "running",
        );
        const [learn] = await db()
            .select()
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.itemId, "incident"),
                    eq(learnRuns.userId, "member"),
                ),
            );
        expect(learn.status).toBe("queued");
        await db()
            .update(learnRuns)
            .set({ status: "ready" })
            .where(eq(learnRuns.id, learn.id));
        const [learnClaim] = await claimDueJobs("learn.run", 1);
        await completeJob({
            jobId: learnClaim.id,
            claimToken: learnClaim.claimToken,
            result: {
                outcome: {
                    kind: "waiting",
                    reason: "review_pending",
                    waitingFor: { kind: "learnReview" },
                },
            },
        });
        await run("incident", "learn-settled");
        expect((await processing("incident")).phases.learn).toMatchObject({
            state: "waiting",
            reason: "review_pending",
        });
        const [item] = await db()
            .select()
            .from(chatterItems)
            .where(eq(chatterItems.id, "incident"));
        expect(item.summaryDueAt?.getTime()).toBeGreaterThan(
            Date.now() + 71 * 60 * 60_000,
        );
        expect(await active("summary")).toHaveLength(0);
    });

    it("re-evaluates no-provider summary and topics skips once, preserving input and generation fences", async () => {
        await seed("summary", "member", false, true);
        expect(
            (await gatherFacts("summary", "private", "member")).profile
                ?.automatic.summary,
        ).toBe(true);
        await run("summary");
        const skipped = await processing("summary");
        expect(skipped.phases.summary).toMatchObject({
            state: "done",
            steps: {
                summary: { state: "skipped", reason: "no_provider" },
                topics: { state: "skipped", reason: "no_provider" },
            },
        });
        const unavailable = await gatherFacts("summary", "private", "member");
        for (const reason of ["profile_off", "erased", "shared", "held"]) {
            const steps = Object.fromEntries(
                Object.entries(skipped.phases.summary?.steps ?? {}).map(
                    ([name, step]) => [name, { ...step, reason }],
                ),
            );
            const plan = planAdvance({
                ...unavailable,
                hasEnhancementCredential: true,
                stepAvailability: {
                    summary: "available",
                    topics: "available",
                    title: "available",
                },
                phases: {
                    ...unavailable.phases,
                    summary: {
                        ...skipped.phases.summary,
                        state: "done",
                        generation: skipped.requestedGeneration,
                        at: at(),
                        steps,
                    },
                },
            });
            expect(
                plan.actions.filter(
                    (action) =>
                        action.type === "queueSummary" ||
                        action.type === "queueTopics",
                ),
            ).toEqual([]);
        }
        await clearDrivers();
        await credential();
        await setDefaultProvider("member", "summary", "provider");
        expect(
            (await active("pipeline.advance")).map((job) => job.subjectId),
        ).toEqual(["summary"]);
        await run("summary", "provider-changed");
        expect(await active("summary")).toHaveLength(1);
        expect(await active("topics")).toHaveLength(1);
        const queued = await processing("summary");
        expect(queued.phases.summary?.steps?.summary).toMatchObject({
            contentId: "transcript-summary",
            contentRevision: 1,
            generation: queued.requestedGeneration,
        });
        expect(
            planAdvance(
                await gatherFacts("summary", "private", "member"),
            ).actions.filter((action) =>
                ["queueSummary", "queueTopics"].includes(action.type),
            ),
        ).toEqual([]);
    });

    it("starts recovered Learn before Summary and keeps provider recovery behind its hold", async () => {
        await seed("held-recovery", "member", true, true);
        await run("held-recovery");
        expect((await processing("held-recovery")).phases.learn).toMatchObject({
            state: "skipped",
            reason: "no_provider",
        });
        await clearDrivers();
        await credential();
        await setDefaultProvider("member", "summary", "provider");
        await run("held-recovery", "provider-changed");
        expect(await active("learn.run")).toHaveLength(1);
        expect(await active("summary")).toHaveLength(0);
        await run("held-recovery", "provider-changed");
        expect(await active("summary")).toHaveLength(0);
        expect(await active("topics")).toHaveLength(0);
    });

    it("only requests a user's recent provider-blocked items and leaves other users, manual, erased and old items alone", async () => {
        for (const id of ["affected", "healthy", "erased", "old", "manual"]) {
            await seed(id);
            await db()
                .update(itemProcessing)
                .set({
                    phases:
                        id === "healthy"
                            ? { categorize: categorized() }
                            : id === "erased"
                              ? {
                                    learn: {
                                        ...categorized(),
                                        state: "skipped",
                                        reason: "erased",
                                    },
                                }
                              : blocked(),
                    manualOnly: id === "manual",
                    updatedAt:
                        id === "old"
                            ? new Date(Date.now() - 31 * 86400_000)
                            : new Date(),
                })
                .where(eq(itemProcessing.itemId, id));
        }
        await seed("other-affected", "other");
        await db()
            .update(itemProcessing)
            .set({ phases: blocked() })
            .where(eq(itemProcessing.itemId, "other-affected"));
        await credential();
        await setDefaultProvider("member", "transcription", "provider");
        expect(
            (await active("pipeline.advance")).map((job) => job.subjectId),
        ).toEqual(["affected"]);
        const generation = (await processing("affected")).requestedGeneration;
        await setDefaultProvider("member", "transcription", "provider");
        expect((await processing("affected")).requestedGeneration).toBe(
            generation,
        );
        expect(
            (await processing("other-affected", "other")).requestedGeneration,
        ).toBe(1);
    });

    it("requests recovery only when a personal provider is re-enabled", async () => {
        for (const userId of ["member", "other"]) {
            const itemId = `personal-${userId}`;
            await seed(itemId, userId);
            await db()
                .update(itemProcessing)
                .set({ phases: blocked() })
                .where(
                    and(
                        eq(itemProcessing.itemId, itemId),
                        eq(itemProcessing.userId, userId),
                    ),
                );
        }
        await credential();
        await db()
            .update(apiCredentials)
            .set({ disabledAt: new Date() })
            .where(
                and(
                    eq(apiCredentials.id, "provider"),
                    eq(apiCredentials.userId, "member"),
                ),
            );
        async function update(body: Record<string, unknown>) {
            const response = await PUT(
                new Request(
                    "http://localhost/api/settings/ai/providers/provider",
                    {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                    },
                ),
                { params: Promise.resolve({ id: "provider" }) },
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ success: true });
        }

        await update({ defaultModel: "another-model" });
        expect(await active("pipeline.advance")).toEqual([]);
        await update({ disabled: true });
        expect(await active("pipeline.advance")).toEqual([]);
        expect((await processing("personal-member")).requestedGeneration).toBe(
            1,
        );

        await update({ disabled: false });
        const [driver] = await active("pipeline.advance");
        expect(await active("pipeline.advance")).toHaveLength(1);
        expect(driver).toMatchObject({
            userId: "member",
            subjectId: "personal-member",
            payload: {
                itemId: "personal-member",
                view: "private",
                reason: "provider-changed",
            },
        });
        const generation = (await processing("personal-member"))
            .requestedGeneration;
        expect(generation).toBe(2);
        expect(
            (await processing("personal-other", "other")).requestedGeneration,
        ).toBe(1);
        await clearDrivers();

        for (const body of [
            { disabled: false },
            { defaultModel: "test-model" },
            { disabled: true },
            { defaultModel: "another-model" },
        ]) {
            await update(body);
            expect(await active("pipeline.advance")).toEqual([]);
            expect(
                (await processing("personal-member")).requestedGeneration,
            ).toBe(generation);
        }
    });

    it("drains provider recovery through the scoped automatic retry guard without a duplicate paid retry", async () => {
        await seed("retry");
        const phases = blocked();
        if (!phases.transcribe) throw new Error("Expected transcription phase");
        phases.transcribe.at = new Date(Date.now() - 31 * 60_000).toISOString();
        await db()
            .update(itemProcessing)
            .set({ phases })
            .where(eq(itemProcessing.itemId, "retry"));
        expect(await sweepAutomaticTranscriptionRetries()).toBe(0);
        await credential();
        await setDefaultProvider("member", "transcription", "provider");
        const [driver] = await active("pipeline.advance");
        expect(await active("pipeline.advance")).toHaveLength(1);
        expect(driver.payload).toMatchObject({
            itemId: "retry",
            reason: "provider-changed",
        });
        const generation = (await processing("retry")).requestedGeneration;
        async function drain() {
            return pipelineAdvanceJobHandler.run({
                jobId: driver.id,
                userId: driver.userId,
                attempt: 1,
                maxAttempts: driver.maxAttempts,
                payload: pipelineAdvanceJobHandler.parsePayload(driver.payload),
                signal: new AbortController().signal,
                reportProgress: vi.fn(),
            });
        }
        await drain();
        const jobs = await active("transcription");
        expect(jobs).toHaveLength(1);
        expect(jobs[0].payload).toMatchObject({
            trigger: "pipeline",
            force: false,
        });
        const queuedGeneration = (await processing("retry"))
            .requestedGeneration;
        expect(queuedGeneration).toBeGreaterThan(generation);
        await drain();
        expect((await active("transcription")).map((job) => job.id)).toEqual([
            jobs[0].id,
        ]);
        expect((await processing("retry")).requestedGeneration).toBe(
            queuedGeneration,
        );
        expect(await sweepAutomaticTranscriptionRetries()).toBe(0);
    });

    it("recovers members on Organization add/enable and never expands that scope on hosted", async () => {
        for (const userId of ["member", "other"]) {
            await seed(`blocked-${userId}`, userId);
            await db()
                .update(itemProcessing)
                .set({ phases: blocked() })
                .where(eq(itemProcessing.itemId, `blocked-${userId}`));
        }
        const context = {
            userId: "organization",
            email: "org@example.test",
            orgUserId: "organization",
            actor: localActor("organization"),
        };
        const created = await createOrganizationProvider(context, {
            provider: "openai",
            encryptedApiKey: "test-key",
            baseUrl: null,
            defaultModel: "test-model",
            rates: {
                inputUsdPerMillion: null,
                outputUsdPerMillion: null,
                audioUsdPerHour: null,
            },
        });
        expect(await active("pipeline.advance")).toHaveLength(2);
        await clearDrivers();
        await updateOrganizationProvider(context, created.id, {
            disabled: true,
        });
        expect(await active("pipeline.advance")).toHaveLength(0);
        await updateOrganizationProvider(context, created.id, {
            disabled: false,
        });
        expect(await active("pipeline.advance")).toHaveLength(2);
        await clearDrivers();
        mockEnv.IS_HOSTED = true;
        expect(await requestProviderRecovery("organization")).toBe(0);
        expect(await active("pipeline.advance")).toHaveLength(0);
    });

    it("caps each owner at 20, interleaves members, and caps the whole selection", async () => {
        for (let index = 0; index < 24; index++) {
            await seed(`bulk-${index}`);
            await db()
                .update(itemProcessing)
                .set({ phases: blocked() })
                .where(eq(itemProcessing.itemId, `bulk-${index}`));
        }
        await seed("other-bulk", "other");
        await db()
            .update(itemProcessing)
            .set({ phases: blocked() })
            .where(eq(itemProcessing.itemId, "other-bulk"));
        const selected = await db().transaction((tx) =>
            listProviderRecoveryRowsInTx(tx, "organization", true, 5),
        );
        expect(selected).toHaveLength(5);
        expect(
            selected
                .slice(0, 2)
                .map((row) => row.userId)
                .sort(),
        ).toEqual(["member", "other"]);
        expect(await requestProviderRecovery("member")).toBe(20);
        expect(await active("pipeline.advance")).toHaveLength(20);
    });

    it("deduplicates racing forced jobs per view without replacing the accepted payload", async () => {
        await seed("concurrent");
        const jobs = await Promise.all(
            Array.from({ length: 8 }, () =>
                enqueueTranscriptionJob({
                    userId: "member",
                    recordingId: "concurrent",
                    trigger: "manual",
                    force: true,
                }),
            ),
        );
        expect(new Set(jobs.map((result) => result.job.id)).size).toBe(1);
        expect(jobs.filter((result) => result.created)).toHaveLength(1);
        const org = await enqueueTranscriptionJob({
            userId: "organization",
            recordingId: "concurrent",
            trigger: "manual",
            force: true,
            view: "org",
        });
        expect(org.job.id).not.toBe(jobs[0].job.id);
        expect(org.job.subjectId).toBe("org:concurrent");
    });
});
