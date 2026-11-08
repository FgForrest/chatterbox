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
    apiCredentials,
    asyncJobs,
    itemProcessing,
    learnRuns,
    mailPendingShares,
    recordingFolders,
    recordings,
    transcriptions,
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
        APIError: class extends Error {
            code?: string;
            status?: number;
        },
        complete: vi.fn(),
        summary: vi.fn(),
        profile: vi.fn(),
        provider: vi.fn(),
        caller: { id: "owner" },
        organization: { id: null as string | null },
        limits: { automatic: 100 },
        keys: {
            encryption:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            secret: "trim-test-secret",
        },
        proxy: new Proxy(
            {},
            {
                get: (_target, key) => {
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
        get BETTER_AUTH_SECRET() {
            return mocks.keys.secret;
        },
        get ENCRYPTION_KEY() {
            return mocks.keys.encryption;
        },
        IS_HOSTED: false,
        AUTHZ_MODE: "local",
        SELF_HOST_MODE: "personal",
        get AUTO_SUMMARY_RATE_LIMIT_PER_HOUR() {
            return mocks.limits.automatic;
        },
        ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: 100,
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => mocks.organization.id,
    isOrgAccount: async () => false,
    isOrgScopeEnabled: () => true,
    isOrgScopeVisible: () => true,
    assertOrgScopeWritable: () => {},
}));
vi.mock("@/lib/summary/generate-summary", () => ({
    generateSummaryForRecording: mocks.summary,
}));
vi.mock("@/lib/recordings/title-after-summary", () => ({
    updateTitleAfterSummary: async () => ({ kind: "skipped", reason: "fake" }),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: mocks.profile,
}));
vi.mock("@/lib/profiles/providers", () => ({
    resolveStepProvider: mocks.provider,
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: mocks.caller.id } }),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("openai", () => ({
    APIError: mocks.APIError,
    OpenAI: class {
        static APIError = mocks.APIError;
        chat = { completions: { create: mocks.complete } };
    },
}));

import { POST as processAgain } from "@/app/api/recordings/[id]/process-again/route";
import { POST as decline } from "@/app/api/recordings/[id]/trim-proposal/route";
import {
    claimDueJobs,
    completeJob,
    enqueueJob,
    prepareClaimedPipelineJob,
} from "@/db/queries/async-jobs";
import { reconcilePipelineSteps } from "@/db/queries/pipeline-reconciler";
import { reapAudioForRecording } from "@/db/queries/retention";
import {
    lockTrimRecording,
    readOwnerTrimProposal,
    resolveTrimInTx,
} from "@/db/queries/trim-proposal";
import {
    decryptJsonField,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { collectTrimProposals } from "@/lib/export/trim-proposal";
import { importTrimProposalInTx } from "@/lib/export/trim-proposal-import";
import * as learnInput from "@/lib/learn/llm-input";
import { executeIntendedSharesWithOutcome } from "@/lib/pipeline/share-intent";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { requestRecordingCut } from "@/lib/recordings/cut";
import {
    commitRecordingCut,
    recordingCutJobHandler,
} from "@/lib/recordings/cut-job-handler";
import {
    queueTrim,
    TRIM_JOB_KIND,
    trimJobHandler,
} from "@/lib/recordings/trim-job";
import type { StoredTrimProposal } from "@/lib/recordings/trim-proposal";
import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import { lockItemTaskGraphInTx } from "@/lib/tasks/mentions";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import { insertRecordings } from "@/tests/integration/items";

const turns = [
    { speaker: "S1", startMs: 0, endMs: 2000, text: "Unrelated weekend talk." },
    {
        speaker: "S1",
        startMs: 3000,
        endMs: 7000,
        text: "Jitka Dvořáková approves the budget.",
    },
    { speaker: "S2", startMs: 8000, endMs: 10000, text: "Unrelated closing." },
];
const content = {
    contentId: "transcript",
    contentSourceId: "riffado",
    contentRevision: 0,
};
const admin = getTestDatabaseUrl();
describe.skipIf(!admin)("durable private trim proposals", () => {
    let database: TestPostgresDatabase;
    const db = () => database.db;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            admin ?? "",
            "trim_proposal",
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
    async function recording(
        id = "recording",
        userId = "owner",
        transcriptId = "transcript",
    ) {
        await insertRecordings(db(), {
            id,
            userId,
            filename: encryptText("Budget meeting"),
            duration: 10000,
            startTime: new Date(),
            endTime: new Date(),
            filesize: 10,
            deviceSn: "local",
            plaudFileId: id,
            fileMd5: "a".repeat(32),
            storageType: "local",
            storagePath: `${userId}/${id}.ogg`,
            plaudVersion: "1",
        });
        await db()
            .insert(transcriptions)
            .values({
                id: transcriptId,
                userId,
                recordingId: id,
                text: encryptText(turns.map((t) => t.text).join("\n")),
                turns: encryptJsonField(turns),
                source: "riffado",
                provider: "Custom",
                model: "fake",
            });
        await db().insert(itemProcessing).values({
            itemId: id,
            userId,
            view: "private",
            requestedGeneration: 1,
            processedGeneration: 1,
        });
    }
    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.caller.id = "owner";
        mocks.limits.automatic = 100;
        mocks.organization.id = null;
        mocks.keys.encryption =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        mocks.keys.secret = "trim-test-secret";
        await db().delete(users);
        await db()
            .insert(users)
            .values(
                ["owner", "other"].map((id) => ({
                    id,
                    email: `${id}@example.com`,
                    uiLocale: "cs-CZ",
                })),
            );
        await recording();
        await db().insert(apiCredentials).values({
            id: "chat",
            userId: "owner",
            provider: "Custom",
            apiKey: "unused",
            defaultModel: "fake",
        });
        mocks.profile.mockResolvedValue({
            revisionId: "recipe",
            settings: defaultProfileSettings("audio"),
            assigned: true,
            profile: { id: "profile", ownerUserId: "owner" },
        });
        mocks.provider.mockResolvedValue({
            kind: "credential",
            credential: {
                id: "chat",
                provider: "Custom",
                apiKey: "fake",
                baseUrl: "https://example.com/v1",
                defaultModel: "fake",
                maxOutputTokens: null,
            },
            payerUserId: "owner",
            reserveCall: async () => {},
            organizationCredential: false,
        });
        mocks.complete.mockResolvedValue({
            choices: [
                {
                    finish_reason: "stop",
                    message: {
                        content: JSON.stringify({
                            start: {
                                firstKeptSentenceId: "t1s0",
                                startMs: 3000,
                                reason: "Úvod nesouvisí se schůzkou.",
                            },
                            end: null,
                        }),
                    },
                },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 30 },
        });
    });
    async function run() {
        await queueTrim("owner", "recording", content);
        const [job] = await claimDueJobs(TRIM_JOB_KIND, 1);
        expect(job).toBeDefined();
        const result = await trimJobHandler.run({
            userId: "owner",
            jobId: job.id,
            claimToken: job.claimToken,
            payload: trimJobHandler.parsePayload(job.payload),
            attempt: 1,
            maxAttempts: 2,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        if (result)
            await completeJob({
                jobId: job.id,
                claimToken: job.claimToken,
                result,
            });
        return job;
    }
    async function current() {
        const [row] = await db()
            .select()
            .from(recordings)
            .where(eq(recordings.id, "recording"));
        const [processing] = await db()
            .select()
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, "recording"),
                    eq(itemProcessing.userId, "owner"),
                ),
            );
        return {
            row,
            processing,
            proposal: decryptJsonField<StoredTrimProposal>(row.trimProposal),
        };
    }
    it("deduplicates enqueue and atomically publishes encrypted content with a no-job four-hour wait", async () => {
        await Promise.all([
            queueTrim("owner", "recording", content),
            queueTrim("owner", "recording", content),
        ]);
        await run();
        const { row, processing, proposal } = await current();
        expect(row.trimProposal).toHaveProperty("c");
        expect(JSON.stringify(row.trimProposal)).not.toContain("Úvod");
        expect(proposal).not.toBeNull();
        expect(
            Date.parse(proposal?.deadline ?? "") -
                Date.parse(proposal?.createdAt ?? ""),
        ).toBe(4 * 3600000);
        expect(processing.phases.trim).toMatchObject({
            state: "waiting",
            waitingFor: { kind: "trimReview", until: proposal?.deadline },
        });
        expect(processing.phases.trim?.jobId).toBeUndefined();
        const jobs = await db()
            .select()
            .from(asyncJobs)
            .where(eq(asyncJobs.kind, TRIM_JOB_KIND));
        expect(jobs).toHaveLength(1);
        expect(JSON.stringify(jobs)).not.toContain("Úvod");
        expect(mocks.complete).toHaveBeenCalledOnce();
        const request = mocks.complete.mock.calls[0][0];
        expect(request.messages[1].content).toContain("Unrelated closing");
        expect(request.messages[0].content).toContain("Czech");
        expect(request.max_tokens).toBe(4096);
    });
    it.each([
        (reply: string) => `\`\`\`json\n${reply}\n\`\`\``,
        (reply: string) => `Here is the proposal:
${reply}`,
    ])("accepts wrapped JSON without a repair call %#", async (wrap) => {
        const response = await mocks.complete();
        response.choices[0].message.content = wrap(
            response.choices[0].message.content,
        );
        mocks.complete.mockClear().mockResolvedValue(response);
        await run();
        expect((await current()).processing.phases.trim?.state).toBe("waiting");
        expect((await current()).proposal?.start?.startMs).toBe(3000);
        expect(mocks.complete).toHaveBeenCalledOnce();
    });
    it.each([
        null,
        2048,
    ])("budgets reasoning output while respecting a card cap of %s", async (cap) => {
        const resolved = await mocks.provider();
        resolved.credential.defaultModel = "gpt-5";
        resolved.credential.maxOutputTokens = cap;
        mocks.provider.mockResolvedValue(resolved);
        await run();
        expect(mocks.complete.mock.calls[0][0].max_completion_tokens).toBe(
            cap ?? 4096,
        );
        expect(mocks.complete.mock.calls[0][0].max_tokens).toBeUndefined();
    });
    it("silently skips when no usable chat provider exists", async () => {
        mocks.provider.mockRejectedValue(
            new AppError(
                ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
                "No chat provider",
                400,
                { providerSelection: "absent" },
            ),
        );
        await run();
        expect((await current()).processing.phases.trim?.reason).toBe(
            "no_provider",
        );
        expect(mocks.complete).not.toHaveBeenCalled();
    });
    it("continues on empty and malformed output without creating a proposal", async () => {
        mocks.complete.mockResolvedValue({
            choices: [
                {
                    finish_reason: "stop",
                    message: { content: '{"start":null,"end":null}' },
                },
            ],
        });
        await run();
        expect((await current()).processing.phases.trim).toMatchObject({
            state: "done",
            reason: "no_proposal",
        });
        expect((await current()).proposal).toBeNull();
    });
    it("skips truncated output", async () => {
        mocks.complete.mockResolvedValue({
            choices: [{ finish_reason: "length", message: { content: "{}" } }],
        });
        await run();
        expect((await current()).processing.phases.trim).toMatchObject({
            state: "skipped",
            reason: "invalid_output",
        });
    });
    it("skips a broken explicit provider without falling through", async () => {
        mocks.provider.mockRejectedValue(new Error("missing configured card"));
        await run();
        expect(mocks.complete).not.toHaveBeenCalled();
        expect((await current()).processing.phases.trim?.reason).toBe(
            "provider_unavailable",
        );
    });
    it.each([
        "not JSON",
        '{"start":null,"end":null,"middle":[]}',
    ])("rejects malformed output without a repair call: %s", async (content) => {
        mocks.complete.mockResolvedValue({
            choices: [{ finish_reason: "stop", message: { content } }],
        });
        await run();
        expect((await current()).processing.phases.trim).toMatchObject({
            state: "skipped",
            reason: "invalid_output",
        });
        expect(mocks.complete).toHaveBeenCalledOnce();
    });
    it("skips provider context rejection without another provider or shortened request", async () => {
        const error = new mocks.APIError("Sensitive provider response");
        error.code = "context_length_exceeded";
        error.status = 400;
        mocks.complete.mockRejectedValue(error);
        await run();
        expect((await current()).processing.phases.trim).toMatchObject({
            state: "skipped",
            reason: "context_limit",
        });
        expect(mocks.provider).toHaveBeenCalledOnce();
        expect(mocks.complete).toHaveBeenCalledOnce();
    });
    it("skips unsupported secondary transcripts before buying a request", async () => {
        await db()
            .insert(transcriptions)
            .values({
                id: "untimed",
                recordingId: "recording",
                userId: "owner",
                text: encryptText("Untimed text"),
                source: "plaud",
                provider: "Custom",
                model: "fake",
            });
        await run();
        expect((await current()).processing.phases.trim).toMatchObject({
            state: "skipped",
            reason: "unsupported_cut",
        });
        expect(mocks.complete).not.toHaveBeenCalled();
    });
    it("rejects a byte-limit overflow without shortening or calling a provider", async () => {
        const huge = [{ ...turns[0], text: "whole-transcript ".repeat(40000) }];
        await db()
            .update(transcriptions)
            .set({
                text: encryptText(huge[0].text),
                turns: encryptJsonField(huge),
            })
            .where(
                and(
                    eq(transcriptions.id, "transcript"),
                    eq(transcriptions.userId, "owner"),
                ),
            );
        await run();
        expect((await current()).processing.phases.trim).toMatchObject({
            state: "skipped",
            reason: "context_limit",
        });
        expect(mocks.complete).not.toHaveBeenCalled();
    });
    it("sanitizes transient errors and leaves the queue's bounded retry policy authoritative", async () => {
        mocks.complete.mockRejectedValue(
            new mocks.APIError("Sensitive transcript from provider"),
        );
        await expect(run()).rejects.toMatchObject({
            message: "TRIM_PROVIDER_FAILED",
            retryable: true,
        });
        expect(trimJobHandler.maxAttempts).toBe(2);
        expect(mocks.complete).toHaveBeenCalledOnce();
    });
    it("accepts different Plaud sentence starts and cuts its text by sentence start", async () => {
        await db()
            .update(recordings)
            .set({ audioReapedAt: new Date() })
            .where(eq(recordings.id, "recording"));
        const plaudTurns = [
            {
                speaker: "S1",
                startMs: 0,
                endMs: 10000,
                text: "Secondary opening. Secondary budget. Secondary closing.",
                sentenceStartsMs: [0, 4000, 8500],
            },
        ];
        await db()
            .insert(transcriptions)
            .values({
                id: "plaud-transcript",
                recordingId: "recording",
                userId: "owner",
                source: "plaud",
                text: encryptText(plaudTurns[0].text),
                turns: encryptJsonField(plaudTurns),
                provider: "Plaud",
                model: "fake",
            });
        await run();
        const proposal = (await current()).proposal;
        expect(proposal?.start?.startMs).toBe(3000);
        await requestRecordingCut("owner", "recording", {
            startMs: 3000,
            endMs: 10000,
            trimProposalId: proposal?.id,
            revisions: [
                { id: "transcript", revision: 0 },
                { id: "plaud-transcript", revision: 0 },
            ],
        });
        const [cut] = await claimDueJobs("recording.cut", 1);
        await db().transaction(async (tx) => {
            await lockItemTaskGraphInTx(tx, {
                itemId: "recording",
                ownerUserId: "owner",
            });
            await commitRecordingCut(
                tx,
                "owner",
                cut.id,
                recordingCutJobHandler.parsePayload(cut.payload),
                null,
                null,
                cut.claimToken,
            );
        });
        const [secondary] = await db()
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.id, "plaud-transcript"));
        expect(readTranscriptTurns(secondary)).toMatchObject([
            {
                text: "Secondary budget. Secondary closing.",
                startMs: 1000,
                endMs: 7000,
                sentenceStartsMs: [1000, 5500],
            },
        ]);
    });
    it("refuses confirmation after a transcript revision changes", async () => {
        await run();
        const proposal = (await current()).proposal;
        await db()
            .update(transcriptions)
            .set({ revision: 1 })
            .where(
                and(
                    eq(transcriptions.id, "transcript"),
                    eq(transcriptions.userId, "owner"),
                ),
            );
        await expect(
            requestRecordingCut("owner", "recording", {
                startMs: 3000,
                endMs: 10000,
                trimProposalId: proposal?.id,
                revisions: [{ id: "transcript", revision: 0 }],
            }),
        ).rejects.toThrow();
        expect(await readOwnerTrimProposal("owner", "recording")).toBeNull();
        expect((await current()).processing.phases.trim?.reason).toBe(
            "content_changed",
        );
    });
    it("defers admission at the dedicated hourly cap without buying inference", async () => {
        mocks.limits.automatic = 1;
        await consumeRateLimitBucket("auto-trim:user:owner", {
            limit: 1,
            windowMs: 3600000,
        });
        await expect(run()).rejects.toMatchObject({ name: "JobDeferredError" });
        expect(mocks.complete).not.toHaveBeenCalled();
        expect(
            (await current()).processing.phases.trim?.waitingFor?.kind,
        ).not.toBe("trimReview");
    });
    it("defers Organization quota denial without calling or selecting another provider", async () => {
        const resolved = await mocks.provider();
        mocks.provider.mockClear().mockResolvedValue({
            ...resolved,
            payerUserId: "other",
            organizationCredential: true,
            reserveCall: async () => {
                throw new AppError(ErrorCode.AI_RATE_LIMITED, "Quota", 429, {
                    resetAt: new Date(Date.now() + 60000).toISOString(),
                });
            },
        });
        await expect(run()).rejects.toMatchObject({ name: "JobDeferredError" });
        expect(mocks.complete).not.toHaveBeenCalled();
        expect(mocks.provider).toHaveBeenCalledOnce();
    });
    it("invalidates a pending proposal when retention reaps the audio", async () => {
        await run();
        const remove = vi.fn(async () => {});
        expect(
            await reapAudioForRecording(
                "recording",
                "owner",
                { isOrg: false, orgUserId: null },
                new Date(),
                remove,
            ),
        ).toBe(true);
        expect(remove).toHaveBeenCalledOnce();
        expect((await current()).proposal).toBeNull();
        expect((await current()).processing.phases.trim).toMatchObject({
            state: "done",
            reason: "audio_reaped",
        });
    });
    it("does not buy another call for audio replacement without a new transcript", async () => {
        await run();
        await db().transaction((tx) =>
            resolveTrimInTx(tx, {
                userId: "owner",
                recordingId: "recording",
                reason: "audio_changed",
                force: true,
            }),
        );
        await queueTrim("owner", "recording", content);
        expect(mocks.complete).toHaveBeenCalledOnce();
        expect((await current()).proposal).toBeNull();
    });
    it("enforces ownership on reads and decisions", async () => {
        await run();
        expect(await readOwnerTrimProposal("other", "recording")).toBeNull();
        mocks.caller.id = "other";
        const response = await decline(
            new Request(
                "http://localhost/api/recordings/recording/trim-proposal",
                {
                    method: "POST",
                    body: JSON.stringify({
                        proposalId: (await current()).proposal?.id,
                    }),
                },
            ),
            { params: Promise.resolve({ id: "recording" }) },
        );
        expect(response.status).toBe(404);
        expect((await current()).proposal).not.toBeNull();
    });
    it("resolves only once when expiry and decline race on independent connections", async () => {
        await run();
        const proposal = (await current()).proposal;
        const settled = await Promise.all([
            db().transaction((tx) =>
                resolveTrimInTx(tx, {
                    userId: "owner",
                    recordingId: "recording",
                    reason: "timed_out",
                    now: new Date(proposal?.deadline ?? ""),
                }),
            ),
            db().transaction((tx) =>
                resolveTrimInTx(tx, {
                    userId: "owner",
                    recordingId: "recording",
                    reason: "declined",
                }),
            ),
        ]);
        expect(settled.filter(Boolean)).toHaveLength(1);
        expect((await current()).proposal).toBeNull();
    });
    it("does not release while a cut is active and rejects stale proposal confirmation", async () => {
        await run();
        const proposal = (await current()).proposal;
        await requestRecordingCut("owner", "recording", {
            startMs: 3000,
            endMs: 10000,
            revisions: [{ id: "transcript", revision: 0 }],
            trimProposalId: proposal?.id,
        });
        expect(
            await db().transaction((tx) =>
                resolveTrimInTx(tx, {
                    userId: "owner",
                    recordingId: "recording",
                    reason: "timed_out",
                    now: new Date(proposal?.deadline ?? ""),
                }),
            ),
        ).toBe(false);
        expect((await current()).proposal?.id).toBe(proposal?.id);
    });
    it("rechecks the trim gate inside automatic enqueue and allows an owner manual summary to bypass it", async () => {
        await run();
        await expect(
            enqueueJob({
                userId: "owner",
                kind: "summary",
                subjectId: "recording",
                payload: { recordingId: "recording", trigger: "auto" },
            }),
        ).rejects.toThrow("Waiting for the trim");
        await enqueueJob({
            userId: "owner",
            kind: "summary",
            subjectId: "recording",
            payload: { recordingId: "recording", trigger: "manual" },
        });
        expect((await current()).processing.phases.trim?.reason).toBe(
            "bypassed_manual",
        );
        expect((await current()).proposal).toBeNull();
    });
    async function executeSummary(
        job: Awaited<ReturnType<typeof claimDueJobs>>[number],
    ) {
        if (!(await prepareClaimedPipelineJob(job.id, job.claimToken)))
            return false;
        const result = await summaryJobHandler.run({
            userId: job.userId,
            jobId: job.id,
            claimToken: job.claimToken,
            payload: summaryJobHandler.parsePayload(job.payload),
            attempt: job.attempts,
            maxAttempts: job.maxAttempts,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        if (result)
            await completeJob({
                jobId: job.id,
                claimToken: job.claimToken,
                result,
            });
        return true;
    }
    it.each([
        "declined",
        "timed_out",
        "cut_applied",
    ])("defers a queued-before-hold summary without spending an attempt, then runs after %s", async (reason) => {
        if (reason === "cut_applied")
            await db()
                .update(recordings)
                .set({ audioReapedAt: new Date() })
                .where(eq(recordings.id, "recording"));
        const queued = await enqueueJob({
            userId: "owner",
            kind: "summary",
            subjectId: "recording",
            payload: { recordingId: "recording", trigger: "auto" },
        });
        const response = await processAgain(
            new Request(
                "http://localhost/api/recordings/recording/process-again",
                { method: "POST" },
            ),
            { params: Promise.resolve({ id: "recording" }) },
        );
        expect(response.status).toBe(200);
        await run();
        const proposal = (await current()).proposal;
        expect((await current()).processing.phases.trim?.state).toBe("waiting");
        const [job] = await claimDueJobs("summary", 1);
        expect(job.id).toBe(queued.job.id);
        mocks.summary.mockResolvedValue({
            committed: true,
            ownerUserId: "owner",
            summary: "Budget summary",
            keyPoints: [],
            actionItems: [],
            provider: "Custom",
            model: "fake",
        });
        expect(await executeSummary(job)).toBe(false);
        expect(mocks.summary).not.toHaveBeenCalled();
        const [deferred] = await db()
            .select()
            .from(asyncJobs)
            .where(eq(asyncJobs.id, job.id));
        expect(deferred).toMatchObject({
            status: "pending",
            attempts: 0,
            claimToken: null,
        });
        if (reason === "cut_applied") {
            await requestRecordingCut("owner", "recording", {
                startMs: 3000,
                endMs: 10000,
                trimProposalId: proposal?.id,
                revisions: [{ id: "transcript", revision: 0 }],
            });
            const [cut] = await claimDueJobs("recording.cut", 1);
            await db().transaction(async (tx) => {
                await lockItemTaskGraphInTx(tx, {
                    itemId: "recording",
                    ownerUserId: "owner",
                });
                await commitRecordingCut(
                    tx,
                    "owner",
                    cut.id,
                    recordingCutJobHandler.parsePayload(cut.payload),
                    null,
                    null,
                    cut.claimToken,
                );
            });
            await completeJob({ jobId: cut.id, claimToken: cut.claimToken });
            const [cancelled] = await db()
                .select()
                .from(asyncJobs)
                .where(eq(asyncJobs.id, job.id));
            expect(cancelled.status).toBe("failed");
            const [retained] = await db()
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.id, "transcript"));
            expect(retained.revision).toBe(1);
            expect(
                readTranscriptTurns(retained)?.map((t) => t.text),
            ).not.toContain(turns[0].text);
            await enqueueJob({
                userId: "owner",
                kind: "summary",
                subjectId: "recording",
                payload: { recordingId: "recording", trigger: "auto" },
            });
        } else {
            await db().transaction((tx) =>
                resolveTrimInTx(tx, {
                    userId: "owner",
                    recordingId: "recording",
                    reason,
                    ...(reason === "timed_out"
                        ? { now: new Date(proposal?.deadline ?? "") }
                        : {}),
                }),
            );
            await db()
                .update(asyncJobs)
                .set({ nextAttemptAt: new Date(0) })
                .where(eq(asyncJobs.id, job.id));
        }
        expect((await current()).processing.phases.trim?.reason).toBe(reason);
        const [released] = await claimDueJobs("summary", 1);
        expect(await executeSummary(released)).toBe(true);
        expect(mocks.summary).toHaveBeenCalledOnce();
    });
    it.each([
        "topics",
        "pipeline.action",
        "learn.run",
    ])("defers previously queued automatic %s", async (kind) => {
        const queued = await enqueueJob({
            userId: "owner",
            kind,
            subjectId: "recording",
            payload: { recordingId: "recording", trigger: "auto" },
            pipeline: {
                itemId: "recording",
                userId: "owner",
                phase: kind === "learn.run" ? "learn" : "summary",
                ...(kind === "learn.run"
                    ? {}
                    : { step: kind === "topics" ? "topics" : "summary" }),
            },
        });
        await run();
        const [job] = await claimDueJobs(kind, 1);
        expect(await prepareClaimedPipelineJob(job.id, job.claimToken)).toBe(
            false,
        );
        const [deferred] = await db()
            .select()
            .from(asyncJobs)
            .where(eq(asyncJobs.id, queued.job.id));
        expect(deferred).toMatchObject({ status: "pending", attempts: 0 });
    });
    it.each([
        "owner",
        "other",
    ])("allows a queued manual summary by %s without inferring curator consent", async (actor) => {
        await db()
            .update(itemProcessing)
            .set({
                phases: {
                    summary: {
                        state: "done",
                        generation: 1,
                        at: new Date().toISOString(),
                        inputs: content,
                        steps: {
                            summary: {
                                ...content,
                                state: "done",
                                generation: 1,
                            },
                        },
                    },
                },
            })
            .where(
                and(
                    eq(itemProcessing.itemId, "recording"),
                    eq(itemProcessing.userId, "owner"),
                ),
            );
        await enqueueJob({
            userId: actor,
            kind: "summary",
            subjectId: "recording",
            payload: { recordingId: "recording", trigger: "manual" },
            pipeline: {
                itemId: "recording",
                userId: "owner",
                phase: "summary",
                step: "summary",
                existingOnly: true,
            },
        });
        await run();
        const [job] = await claimDueJobs("summary", 1);
        expect(await prepareClaimedPipelineJob(job.id, job.claimToken)).toBe(
            true,
        );
        expect((await current()).processing.phases.trim?.reason).toBe(
            actor === "owner" ? "bypassed_manual" : "review_pending",
        );
        expect((await current()).proposal === null).toBe(actor === "owner");
    });
    it.each([
        "owner",
        "other",
    ])("reads a queued manual Learn trigger from its run for %s", async (actor) => {
        await db()
            .update(itemProcessing)
            .set({
                phases: {
                    learn: {
                        state: "done",
                        generation: 1,
                        at: new Date().toISOString(),
                        inputs: content,
                    },
                },
            })
            .where(
                and(
                    eq(itemProcessing.itemId, "recording"),
                    eq(itemProcessing.userId, "owner"),
                ),
            );
        await db().insert(learnRuns).values({
            id: "manual-run",
            itemId: "recording",
            userId: "owner",
            scopeUserId: "owner",
            actorUserId: actor,
            view: "private",
            trigger: "manual",
            transcriptionId: "transcript",
            transcriptRevision: 0,
            vocabularyVersion: 1,
            inputs: content,
        });
        await enqueueJob({
            userId: actor,
            kind: "learn.run",
            subjectId: "recording",
            payload: { runId: "manual-run" },
            pipeline: {
                itemId: "recording",
                userId: "owner",
                phase: "learn",
                existingOnly: true,
            },
        });
        await run();
        const [job] = await claimDueJobs("learn.run", 1);
        expect(await prepareClaimedPipelineJob(job.id, job.claimToken)).toBe(
            true,
        );
        expect((await current()).processing.phases.trim?.reason).toBe(
            actor === "owner" ? "bypassed_manual" : "review_pending",
        );
    });
    it("also defers a pre-deployment unbound automatic summary", async () => {
        await db()
            .insert(asyncJobs)
            .values({
                id: "unbound-summary",
                userId: "owner",
                kind: "summary",
                subjectId: "recording",
                payload: { recordingId: "recording", trigger: "auto" },
            });
        await run();
        const [job] = await claimDueJobs("summary", 1);
        expect(await prepareClaimedPipelineJob(job.id, job.claimToken)).toBe(
            false,
        );
        const [deferred] = await db()
            .select()
            .from(asyncJobs)
            .where(eq(asyncJobs.id, job.id));
        expect(deferred).toMatchObject({
            status: "pending",
            attempts: 0,
            claimToken: null,
        });
    });
    it.each([
        { fileMd5: "changed" },
        { duration: 11000 },
        { cutAt: new Date(0) },
    ])("resolves changed audio metadata after a locked reread: %j", async (change) => {
        await run();
        await db()
            .update(recordings)
            .set(change)
            .where(eq(recordings.id, "recording"));
        expect(await readOwnerTrimProposal("owner", "recording")).toBeNull();
        expect((await current()).processing.phases.trim?.reason).toBe(
            "content_changed",
        );
    });
    it("polls a valid proposal without rendering content or waiting on the recording writer", async () => {
        await run();
        const render = vi.spyOn(learnInput, "modelInput");
        let release: () => void = () => {};
        let ready: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const locked = new Promise<void>((resolve) => {
            ready = resolve;
        });
        const writer = db().transaction(async (tx) => {
            await lockTrimRecording(tx, "owner", "recording");
            ready();
            await gate;
        });
        await locked;
        try {
            const read = readOwnerTrimProposal("owner", "recording");
            const result = await Promise.race([
                read,
                new Promise<null>((resolve) =>
                    setTimeout(() => resolve(null), 1000),
                ),
            ]);
            expect(result?.id).toBe((await current()).proposal?.id);
            expect(render).not.toHaveBeenCalled();
        } finally {
            release();
            await writer;
            render.mockRestore();
        }
    });
    it("reconciles expiry as a decision without a lost repair or another inference", async () => {
        await run();
        const proposal = (await current()).proposal;
        expect(
            await reconcilePipelineSteps(
                100,
                5,
                new Date(proposal?.deadline ?? ""),
            ),
        ).toBe(1);
        const { processing } = await current();
        expect(processing.phases.trim?.reason).toBe("timed_out");
        expect(processing.phases.trim?.replanAttempts).toBeUndefined();
        expect(mocks.complete).toHaveBeenCalledOnce();
    });
    it("does not let a reclaimed claim publish", async () => {
        let release: () => void = () => {};
        const blocked = new Promise<void>((done) => {
            release = done;
        });
        const original = mocks.complete.getMockImplementation();
        mocks.complete.mockImplementation(async (...args: unknown[]) => {
            await blocked;
            return original?.(...args);
        });
        await queueTrim("owner", "recording", content);
        const [job] = await claimDueJobs(TRIM_JOB_KIND, 1);
        const running = trimJobHandler.run({
            ...job,
            jobId: job.id,
            payload: trimJobHandler.parsePayload(job.payload),
            attempt: 1,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        await db()
            .update(asyncJobs)
            .set({ claimToken: "new-claim" })
            .where(eq(asyncJobs.id, job.id));
        release();
        await running;
        expect((await current()).proposal).toBeNull();
    });
    it("exports decrypted pending data only to the owner and rebinds it with new ids and keys", async () => {
        await run();
        const original = (await current()).proposal;
        const [archived] = await collectTrimProposals(
            { kind: "personal", userId: "owner" },
            ["recording"],
        );
        expect(archived.proposal?.start?.reason).toContain("Úvod");
        expect(archived.proposal).not.toHaveProperty("inputFingerprint");
        expect(
            await collectTrimProposals(
                { kind: "organization", orgUserId: "other" },
                ["recording"],
            ),
        ).toEqual([]);
        expect(
            await collectTrimProposals({ kind: "personal", userId: "other" }, [
                "recording",
            ]),
        ).toEqual([]);
        mocks.keys.encryption =
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        mocks.keys.secret = "destination-trim-secret";
        await recording("restored", "other", "restored-transcript");
        expect(
            await db().transaction((tx) =>
                importTrimProposalInTx(tx, {
                    archived,
                    userId: "other",
                    recordingIds: new Map([["recording", "restored"]]),
                    transcriptIds: new Map([
                        ["transcript", "restored-transcript"],
                    ]),
                    profileRevisionIds: new Map([
                        ["recipe", "restored-recipe"],
                    ]),
                }),
            ),
        ).toBe("pending");
        const restored = await readOwnerTrimProposal("other", "restored");
        expect(restored?.deadline).toBe(original?.deadline);
        expect(restored?.transcript.id).toBe("restored-transcript");
        expect(restored?.profileRevisionId).toBe("restored-recipe");
        expect(restored?.id).not.toBe(original?.id);
        expect(restored?.inputFingerprint).not.toBe(original?.inputFingerprint);
    });
    it.each([
        "expired",
        "mismatched",
        "changed correction rendering",
    ])("resolves %s backup data and can never confirm it", async (kind) => {
        await run();
        const [archived] = await collectTrimProposals(
            { kind: "personal", userId: "owner" },
            ["recording"],
        );
        if (kind === "expired" && archived.proposal)
            archived.proposal.deadline = new Date(0).toISOString();
        if (kind === "mismatched") archived.inputDigest = "different";
        if (kind === "changed correction rendering" && archived.proposal)
            archived.proposal.renderingDigest = "different";
        await recording("restored", "other", "restored-transcript");
        expect(
            await db().transaction((tx) =>
                importTrimProposalInTx(tx, {
                    archived,
                    userId: "other",
                    recordingIds: new Map([["recording", "restored"]]),
                    transcriptIds: new Map([
                        ["transcript", "restored-transcript"],
                    ]),
                    profileRevisionIds: new Map([
                        ["recipe", "restored-recipe"],
                    ]),
                }),
            ),
        ).toBe("resolved");
        expect(await readOwnerTrimProposal("other", "restored")).toBeNull();
        await expect(
            requestRecordingCut("other", "restored", {
                startMs: 3000,
                endMs: 10000,
                trimProposalId: archived.proposal?.id,
            }),
        ).rejects.toThrow("changed or expired");
    });
    it("holds the same recording lock across a decision and a competing writer", async () => {
        await run();
        let unlock: () => void = () => {};
        let locked: () => void = () => {};
        const gate = new Promise<void>((done) => {
            unlock = done;
        });
        const ready = new Promise<void>((done) => {
            locked = done;
        });
        const first = db().transaction(async (tx) => {
            await lockTrimRecording(tx, "owner", "recording");
            locked();
            await gate;
            return resolveTrimInTx(tx, {
                userId: "owner",
                recordingId: "recording",
                reason: "declined",
            });
        });
        await ready;
        let finished = false;
        const second = db().transaction(async (tx) => {
            await lockTrimRecording(tx, "owner", "recording");
            finished = true;
        });
        await new Promise((done) => setTimeout(done, 30));
        expect(finished).toBe(false);
        unlock();
        await Promise.all([first, second]);
        expect(finished).toBe(true);
    });
    it.each([
        "waiting",
        "running",
    ] as const)("holds intended shares transactionally while trim is %s", async (state) => {
        await run();
        mocks.organization.id = "org";
        await db().insert(users).values({
            id: "org",
            email: "organization@example.com",
            role: "org",
        });
        await db()
            .insert(recordingFolders)
            .values([
                {
                    id: "org-root",
                    userId: "org",
                    name: encryptText("Organization"),
                    nameHash: "root",
                    kind: "public",
                },
                {
                    id: "org-child",
                    userId: "org",
                    parentId: "org-root",
                    name: encryptText("Team"),
                    nameHash: "child",
                },
            ]);
        await db().insert(mailPendingShares).values({
            itemId: "recording",
            userId: "owner",
            folderId: "org-child",
        });
        if (state === "running") {
            const currentState = await current();
            const previousTrim = currentState.processing.phases.trim;
            if (!previousTrim) throw new Error("Missing trim phase");
            await db()
                .update(itemProcessing)
                .set({
                    phases: {
                        ...currentState.processing.phases,
                        trim: {
                            ...previousTrim,
                            state: "running",
                        },
                    },
                })
                .where(
                    and(
                        eq(itemProcessing.itemId, "recording"),
                        eq(itemProcessing.userId, "owner"),
                    ),
                );
        }
        const result = await executeIntendedSharesWithOutcome(
            "owner",
            "recording",
        );
        expect(result).toMatchObject({
            waitingForTrim: true,
            shared: false,
            remaining: true,
        });
        expect(await db().select().from(mailPendingShares)).toHaveLength(1);
        await db()
            .delete(asyncJobs)
            .where(eq(asyncJobs.kind, "pipeline.advance"));
        expect(
            await db().transaction((tx) =>
                resolveTrimInTx(tx, {
                    userId: "owner",
                    recordingId: "recording",
                    reason: "declined",
                }),
            ),
        ).toBe(true);
        expect(
            (await executeIntendedSharesWithOutcome("owner", "recording"))
                .waitingForTrim,
        ).not.toBe(true);
        expect(
            await db()
                .select()
                .from(asyncJobs)
                .where(eq(asyncJobs.kind, "pipeline.advance")),
        ).toHaveLength(1);
    });
});
