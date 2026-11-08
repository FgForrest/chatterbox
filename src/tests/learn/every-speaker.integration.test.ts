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
    chatterItems,
    itemProcessing,
    knowledgeFactEvidence,
    learnDismissals,
    learnReviewItems,
    learnRuns,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, fallback } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        fallback: vi.fn(),
        dbProxy: new Proxy(
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
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            AUTHZ_MODE: "local",
            ORG_ACCOUNT_EMAIL: "org@example.test",
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
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/export/document-sidecars", () => ({
    refreshExistingRecordingSidecars: vi.fn(),
    exportRecordingSidecarsIfEnabled: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: vi.fn() }));

vi.mock("@/lib/learn/run-fallback", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    runFallbackPass: fallback,
}));
vi.mock("@/lib/learn/chat-clients", () => ({
    learnChatClients: async () => ({
        chat: {},
        provider: "openai",
        model: "test",
        payerUserId: "quick-owner",
    }),
}));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));

import { encrypt } from "@/lib/encryption";
import * as encryptionFields from "@/lib/encryption/fields";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { createEntity } from "@/lib/knowledge/entities";
import { confirmManualFact } from "@/lib/knowledge/facts";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { readItemKnowledge } from "@/lib/knowledge/read-item-knowledge";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { releaseAutoLearnHold } from "@/lib/learn/auto-learn";
import {
    learnFingerprintHmac,
    learnJobHandler,
} from "@/lib/learn/learn-job-handler";
import {
    pendingReviewCount,
    recordingsNeedingReview,
    reviewQueue,
} from "@/lib/learn/pending";
import {
    finishKnownFactsOnly,
    finishReview,
    loadReview,
} from "@/lib/learn/review";
import { type LearnRunFrame, validateLearnOutput } from "@/lib/learn/validate";
import { ensureOrgAccount } from "@/lib/org/account";
import { gatherFacts } from "@/lib/pipeline/facts";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { requireRecordingView } from "@/lib/sharing/access";
import { notifyIfShared } from "@/lib/sharing/notify";
import { emitEvent } from "@/lib/webhooks/emit";
import { insertRecordings } from "@/tests/integration/items";
import { shareRecording } from "@/tests/mcp/fixtures";

const url = getTestDatabaseUrl();
const OWNER = "quick-owner";
const ITEM = "quick-item";
const turns = [0, 1].map((n) => ({
    speaker: `speaker_${n}`,
    startMs: n * 5000,
    endMs: (n + 1) * 5000,
    text: "The project is ready.",
}));
(url ? describe : describe.skip)("optional speaker review (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let transcriptId = "";
    const db = () => database.db;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(url ?? "", "every_speaker");
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30000);
    beforeEach(async () => {
        vi.clearAllMocks();
        knowledgeStore().invalidateAll();
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "owner@example.test" },
                { id: "stranger", email: "stranger@example.test" },
            ]);
        await seedCoreVocabulary();
        await db()
            .insert(apiCredentials)
            .values({
                userId: OWNER,
                provider: "openai",
                apiKey: encrypt("test-key"),
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            });
        await insertRecordings(db(), {
            id: ITEM,
            userId: OWNER,
            deviceSn: "test",
            plaudFileId: "test",
            filename: encryptText("A meeting"),
            duration: 10000,
            startTime: new Date("2026-10-01T10:00:00Z"),
            endTime: new Date("2026-10-01T10:00:10Z"),
            filesize: 1,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: "example.mp3",
            plaudVersion: "1",
        });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: ITEM,
                userId: OWNER,
                source: "riffado",
                text: encryptText("Path finder is ready."),
                turns: encryptJsonField(turns),
                provider: "openai",
                model: "test",
                revision: 0,
            })
            .returning();
        transcriptId = transcript.id;
        const settings = defaultProfileSettings("audio");
        settings.steps.summary.automatic = true;
        settings.steps.learn.correctAfterLearn = false;
        await db()
            .insert(processingProfiles)
            .values({
                id: "quick-profile",
                ownerUserId: OWNER,
                scope: "personal",
                channel: "audio",
                name: encryptText("Test"),
                currentRevisionId: "quick-revision",
            });
        await db()
            .insert(processingProfileRevisions)
            .values({
                id: "quick-revision",
                profileId: "quick-profile",
                settings: encryptText(JSON.stringify(settings)),
            });
        await db()
            .insert(itemProcessing)
            .values({
                itemId: ITEM,
                userId: OWNER,
                view: "private",
                profileId: "quick-profile",
                profileRevisionId: "quick-revision",
                phases: {
                    categorize: {
                        state: "done",
                        reason: "categorized",
                        generation: 0,
                        at: new Date().toISOString(),
                    },
                },
            });
        await db()
            .insert(recordingFolders)
            .values([
                {
                    id: "quick-root",
                    userId: OWNER,
                    name: encryptText("Private"),
                    nameHash: "quick-root",
                    kind: "private",
                },
                {
                    id: "quick-folder",
                    userId: OWNER,
                    parentId: "quick-root",
                    name: encryptText("Meetings"),
                    nameHash: "quick-folder",
                    kind: "custom",
                },
            ]);
        await db().insert(recordingFolderAssignments).values({
            itemId: ITEM,
            userId: OWNER,
            folderId: "quick-folder",
        });
    });
    const empty = {
        newRecords: [],
        speakers: [],
        corrections: [],
        facts: [],
        relationPhrases: [],
    };
    const frame = (): LearnRunFrame => ({
        revision: 0,
        currentRevision: 0,
        transcriptKey: `${transcriptId}@0`,
        turns,
        language: "en",
        provider: null,
        people: new Map(),
        entities: new Map(),
        relations: new Map(),
        answeredLabels: new Map(),
        confirmedHeardAs: new Set(),
        knownFacts: new Map(),
        dismissed: new Set(),
    });
    const ready = async (
        optional = true,
        knownFactId?: string,
        entityId?: string,
    ) => {
        const items = validateLearnOutput(empty, frame()).items;
        const [run] = await db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: OWNER,
                actorUserId: OWNER,
                itemId: ITEM,
                transcriptionId: transcriptId,
                view: "private",
                trigger: "auto",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status: "ready",
            })
            .returning();
        const rows = items.map((item) => ({
            runId: run.id,
            userId: OWNER,
            kind: item.kind,
            fingerprintHmac: learnFingerprintHmac(item.fingerprint),
            payload: encryptJsonField(
                optional
                    ? item.payload
                    : {
                          ...item.payload,
                          unmentioned: undefined,
                          reason: "Nobody known.",
                      },
            ),
            preTicked: false,
        }));
        if (knownFactId && entityId)
            rows.push({
                runId: run.id,
                userId: OWNER,
                kind: "known_fact",
                fingerprintHmac: "known-fact",
                payload: encryptJsonField({
                    factId: knownFactId,
                    subject: { entityId },
                    relationKey: "means",
                    object: { literal: "A test project" },
                    startMs: 0,
                    endMs: 5000,
                    speakerLabel: null,
                }),
                preTicked: true,
            });
        const saved = await db()
            .insert(learnReviewItems)
            .values(rows)
            .returning();
        return {
            run,
            saved,
            versions: Object.fromEntries(
                saved.map((row) => [row.id, row.version]),
            ),
        };
    };
    it.each([
        false,
        true,
    ])("leaves untouched no-name rows unanswered without dismissals (quick: %s), and offers them next run", async (quick) => {
        for (const optional of [true, false]) {
            const { run, saved, versions } = await ready(optional);
            const access = await requireRecordingView(OWNER, ITEM, "private");
            const result = await finishReview(access, OWNER, {
                runId: run.id,
                versions,
                quick,
            });
            expect(result).toMatchObject({
                status: "finished",
                applied: 0,
                dismissed: 0,
                skipped: [],
            });
            expect(await db().select().from(learnDismissals)).toEqual([]);
            expect(await db().select().from(transcriptSpeakers)).toEqual([]);
            const outcomes = await db()
                .select()
                .from(learnReviewItems)
                .where(eq(learnReviewItems.runId, run.id));
            expect(outcomes.every((row) => row.outcome === "not_now")).toBe(
                true,
            );
            expect(
                validateLearnOutput(empty, frame()).items.map(
                    (item) => (item.payload as { label: string }).label,
                ),
            ).toEqual(["speaker_0", "speaker_1"]);
            expect(saved).toHaveLength(2);
            expect((await loadReview(access)).items).toEqual([]);
            expect(
                (await readItemKnowledge(OWNER, ITEM, "private", "speakers"))
                    .item.review?.items,
            ).toEqual([]);
        }
    });
    it("auto-finishes only unmentioned rows and releases the summary hold", async () => {
        const { run } = await ready();
        await db()
            .update(chatterItems)
            .set({ summaryDueAt: new Date(Date.now() + 72 * 3600000) })
            .where(
                and(eq(chatterItems.id, ITEM), eq(chatterItems.userId, OWNER)),
            );
        expect(
            (await loadPrivateItemProcessing(OWNER, ITEM))
                ?.learnFindingsWaiting,
        ).toBe(0);
        expect(await finishKnownFactsOnly(run.id, OWNER)).toBe(true);
        expect((await gatherFacts(ITEM, "private", OWNER)).learnRunOpen).toBe(
            false,
        );
        const [item] = await db()
            .select()
            .from(chatterItems)
            .where(eq(chatterItems.id, ITEM));
        expect(item.summaryDueAt).toBeNull();
        expect(await db().select().from(learnDismissals)).toEqual([]);
        expect(
            (await db().select().from(asyncJobs)).some(
                (job) => job.kind === "pipeline.advance",
            ),
        ).toBe(true);
    });
    it("keeps Learn's own nobody-known rows reviewable and counted", async () => {
        const { run } = await ready(false);
        expect(await finishKnownFactsOnly(run.id, OWNER)).toBe(false);
        expect(
            (await loadPrivateItemProcessing(OWNER, ITEM))
                ?.learnFindingsWaiting,
        ).toBe(2);
        expect(
            (await gatherFacts(ITEM, "private", OWNER)).learnRunReadyForReview,
        ).toBe(true);
    });
    it("never dismisses an application-added row even after an unticked choice", async () => {
        const { run, saved, versions } = await ready();
        await db()
            .update(learnReviewItems)
            .set({
                decision: "rejected",
                choice: encryptJsonField({ unknown: true }),
            })
            .where(eq(learnReviewItems.id, saved[0].id));
        const access = await requireRecordingView(OWNER, ITEM, "private");
        expect(
            await finishReview(access, OWNER, { runId: run.id, versions }),
        ).toMatchObject({ applied: 0, dismissed: 0, skipped: [] });
        expect(await db().select().from(learnDismissals)).toEqual([]);
        expect((await loadReview(access)).items).toEqual([]);
    });
    it("auto-finishes optional rows in the Organization scope without dismissals", async () => {
        const orgId = await ensureOrgAccount();
        if (!orgId) throw new Error("Organization account missing");
        await shareRecording(db(), ITEM, orgId);
        const { run } = await ready();
        await db()
            .update(learnRuns)
            .set({ view: "org", scopeUserId: orgId, actorUserId: orgId })
            .where(eq(learnRuns.id, run.id));
        await db()
            .update(learnReviewItems)
            .set({ userId: orgId })
            .where(eq(learnReviewItems.runId, run.id));
        expect(await finishKnownFactsOnly(run.id, orgId)).toBe(true);
        expect(await db().select().from(learnDismissals)).toEqual([]);
        expect(await db().select().from(transcriptSpeakers)).toEqual([]);
    });
    it("still applies repeated known facts when optional rows are the only other content", async () => {
        const entity = await createEntity(OWNER, {
            typeKey: "term",
            name: "Sample project",
        });
        const fact = await confirmManualFact(OWNER, {
            subject: { entityId: entity.id },
            relationKey: "means",
            object: { literal: "A test project" },
        });
        const { run } = await ready(true, fact, entity.id);
        expect(await finishKnownFactsOnly(run.id, OWNER)).toBe(true);
        expect(
            (await db().select().from(knowledgeFactEvidence)).some(
                (row) => row.factId === fact,
            ),
        ).toBe(true);
        expect(await db().select().from(learnDismissals)).toEqual([]);
    });
    it.each([
        false,
        true,
    ])("applies an explicit unknown or person choice on an optional row (quick: %s)", async (quick) => {
        const { run, saved, versions } = await ready();
        await db()
            .update(learnReviewItems)
            .set({
                decision: "accepted",
                choice: encryptJsonField({ unknown: true }),
            })
            .where(eq(learnReviewItems.id, saved[0].id));
        const access = await requireRecordingView(OWNER, ITEM, "private");
        expect(
            await finishReview(access, OWNER, {
                runId: run.id,
                versions,
                quick,
            }),
        ).toMatchObject({ applied: 1, dismissed: 0 });
        expect((await loadReview(access)).items).toMatchObject([
            { id: saved[0].id, outcome: "applied", choice: { unknown: true } },
        ]);
        expect(
            (await readItemKnowledge(OWNER, ITEM, "private", "speakers")).item
                .review?.items,
        ).toHaveLength(1);
        const [answer] = await db().select().from(transcriptSpeakers);
        expect(answer).toMatchObject({
            label: "speaker_0",
            markedUnknown: true,
            status: "confirmed",
        });
    });

    it("counts real findings, including nobody-known rows, across Knowledge, processing and pending badges", async () => {
        const { run } = await ready();
        await db()
            .insert(learnReviewItems)
            .values([
                {
                    runId: run.id,
                    userId: OWNER,
                    kind: "speaker",
                    fingerprintHmac: "nobody-known",
                    payload: encryptJsonField({
                        label: "speaker_2",
                        personId: null,
                        reason: "Nobody known",
                        evidenceMs: [],
                    }),
                    preTicked: false,
                },
                {
                    runId: run.id,
                    userId: OWNER,
                    kind: "correction",
                    fingerprintHmac: "correction",
                    payload: encryptJsonField({
                        heard: "project",
                        anchors: [],
                    }),
                    preTicked: false,
                },
            ]);
        expect(
            (await readItemKnowledge(OWNER, ITEM, "private", "speakers")).item
                .learn?.pending,
        ).toBe(2);
        expect(
            (await loadPrivateItemProcessing(OWNER, ITEM))
                ?.learnFindingsWaiting,
        ).toBe(2);
        const nonSpeakerPayloads = (await db().select().from(learnReviewItems))
            .filter((row) => row.kind !== "speaker")
            .map((row) => JSON.stringify(row.payload));
        const decrypt = vi.spyOn(encryptionFields, "decryptJsonField");
        try {
            expect(
                (await loadPrivateItemProcessing(OWNER, ITEM))
                    ?.learnFindingsWaiting,
            ).toBe(2);
            expect(
                decrypt.mock.calls.some(([payload]) =>
                    nonSpeakerPayloads.includes(JSON.stringify(payload)),
                ),
            ).toBe(false);
        } finally {
            decrypt.mockRestore();
        }
        expect(await pendingReviewCount(OWNER, false)).toBe(1);
        expect(await recordingsNeedingReview(OWNER, false)).toEqual(
            new Set([ITEM]),
        );
        expect(await reviewQueue(OWNER, false)).toHaveLength(1);
    });

    it.each([
        false,
        true,
    ])("drops unmentioned rows before publishing a run without reviewable findings (known facts: %s)", async (known) => {
        const entity = await createEntity(OWNER, {
            typeKey: "term",
            name: "Sample project",
        });
        const fact = await confirmManualFact(OWNER, {
            subject: { entityId: entity.id },
            relationKey: "means",
            object: { literal: "A test project" },
        });
        const { run } = await ready();
        await db()
            .delete(learnReviewItems)
            .where(eq(learnReviewItems.runId, run.id));
        await db()
            .update(learnRuns)
            .set({ status: "queued" })
            .where(eq(learnRuns.id, run.id));
        const settings = defaultProfileSettings("audio");
        settings.steps.summary.automatic = true;
        settings.steps.learn.correctAfterLearn = true;
        await db()
            .update(processingProfileRevisions)
            .set({ settings: encryptText(JSON.stringify(settings)) })
            .where(eq(processingProfileRevisions.id, "quick-revision"));
        await db()
            .update(chatterItems)
            .set({ summaryDueAt: new Date(Date.now() + 72 * 3600000) })
            .where(eq(chatterItems.id, ITEM));
        fallback.mockResolvedValueOnce({
            output: {
                ...empty,
                facts: known
                    ? [
                          {
                              subject: { entityId: entity.id },
                              relationKey: "means",
                              object: { literal: "A test project" },
                              start: "00:00",
                              end: "00:05",
                              speakerLabel: null,
                              sensitivity: "none",
                          },
                      ]
                    : [],
            },
            calls: 1,
            lookups: 0,
            windows: 1,
            repairs: 0,
            failedWindows: 0,
        });
        const snapshots: {
            status: string;
            kinds: string[];
            correcting: boolean;
        }[] = [];
        const transact = db().transaction.bind(db());
        const spy = vi
            .spyOn(db(), "transaction")
            .mockImplementation(async (work, config) => {
                const result = await transact(work, config);
                const [stored] = await db()
                    .select()
                    .from(learnRuns)
                    .where(eq(learnRuns.id, run.id));
                const rows = await db()
                    .select()
                    .from(learnReviewItems)
                    .where(eq(learnReviewItems.runId, run.id));
                const jobs = await db().select().from(asyncJobs);
                snapshots.push({
                    status: stored.status,
                    kinds: rows.map((row) => row.kind),
                    correcting: jobs.some(
                        (job) => job.kind === "learn.correct",
                    ),
                });
                return result;
            });
        try {
            expect(
                await learnJobHandler.run({
                    payload: { runId: run.id },
                    userId: OWNER,
                    jobId: "optional-job",
                    attempt: 1,
                    maxAttempts: 1,
                    signal: new AbortController().signal,
                    reportProgress: () => {},
                }),
            ).toMatchObject({
                status: "finished",
                outcome: { kind: "done", reason: "released" },
            });
        } finally {
            spy.mockRestore();
        }
        expect(
            snapshots.some((snapshot) => snapshot.kinds.includes("speaker")),
        ).toBe(false);
        if (known) {
            expect(
                snapshots
                    .filter((snapshot) => snapshot.status === "ready")
                    .every((snapshot) =>
                        snapshot.kinds.every((kind) => kind === "known_fact"),
                    ),
            ).toBe(true);
            expect(
                (await db().select().from(knowledgeFactEvidence)).some(
                    (row) =>
                        row.factId === fact &&
                        row.transcriptionId === transcriptId,
                ),
            ).toBe(true);
        } else
            expect(
                snapshots.some((snapshot) => snapshot.status === "ready"),
            ).toBe(false);
        expect(
            snapshots.find((snapshot) => snapshot.status === "finished")
                ?.correcting,
        ).toBe(true);
        expect(await pendingReviewCount(OWNER, false)).toBe(0);
        expect(await recordingsNeedingReview(OWNER, false)).toEqual(new Set());
        expect(await reviewQueue(OWNER, false)).toEqual([]);
        expect(
            (await loadPrivateItemProcessing(OWNER, ITEM))
                ?.learnFindingsWaiting,
        ).toBe(0);
        const jobs = await db().select().from(asyncJobs);
        expect(jobs.filter((job) => job.kind === "learn.correct")).toHaveLength(
            1,
        );
        expect(
            (await db().select().from(chatterItems))[0].summaryDueAt,
        ).not.toBeNull();
        const correctionJob = jobs.find((job) => job.kind === "learn.correct");
        await db()
            .update(asyncJobs)
            .set({ status: "completed" })
            .where(eq(asyncJobs.id, correctionJob?.id ?? ""));
        expect(await releaseAutoLearnHold(ITEM)).toBe(true);
        expect(
            (await db().select().from(chatterItems))[0].summaryDueAt,
        ).toBeNull();
        expect(notifyIfShared).not.toHaveBeenCalled();
        expect(emitEvent).not.toHaveBeenCalled();
    });
});
