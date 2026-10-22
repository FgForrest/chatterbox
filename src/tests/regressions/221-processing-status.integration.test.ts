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
    asyncJobs,
    chatterItems,
    itemProcessing,
    learnReviewItems,
    learnRuns,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    transcriptions,
    users,
} from "@/db/schema";
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
        viewer: "owner-veln",
        orgWritable: true,
        loadMailDetail: vi.fn(),
        proxy: new Proxy(
            {},
            {
                get: (_, key) => {
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
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        DATABASE_URL: "postgres://unused",
        BETTER_AUTH_SECRET: "fixture-secret",
        ENCRYPTION_KEY: "0".repeat(64),
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org-zurna",
    isOrgScopeEnabled: () => mocks.orgWritable,
    assertOrgScopeWritable: vi.fn(),
}));
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: async () =>
        mocks.viewer === "curator-tavro" || mocks.viewer === "org-zurna",
    userCuratesOrganizationNow: async (id: string) =>
        id === "curator-tavro" || id === "org-zurna",
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: mocks.viewer } }),
    requireApiSessionActor: async () => ({
        session: { user: { id: mocks.viewer } },
        actor: { userId: mocks.viewer },
    }),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/profiles/providers", () => ({
    resolveStepProvider: async () => ({
        kind: "credential",
        payerUserId: mocks.viewer,
    }),
}));
vi.mock("@/lib/mail/detail", () => ({ loadMailDetail: mocks.loadMailDetail }));

import { GET as mailGet } from "@/app/api/mail/[id]/route";
import { POST as retryLearn } from "@/app/api/recordings/[id]/learn/route";
import { POST as finishLearnReview } from "@/app/api/recordings/[id]/review/finish/route";
import { GET } from "@/app/api/recordings/[id]/route";
import { claimDueJobs, enqueueJob } from "@/db/queries/async-jobs";
import { loadPipelineProcessingJobs } from "@/db/queries/pipeline-processing";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import {
    type ItemProcessingPresentation,
    loadPrivateItemProcessing,
} from "@/lib/pipeline/presentation";
import { readProcessing, updatePhaseInTx } from "@/lib/pipeline/state";
import { defaultProfileSettings } from "@/lib/profiles/settings";

const url = getTestDatabaseUrl();
const owner = "owner-veln";
const itemId = "item-veln";
(url ? describe : describe.skip)(
    "#221 processing API with durable jobs and a shared driver",
    () => {
        let database: TestPostgresDatabase;
        const db = () => database.db;
        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                url ?? "",
                "processing_status_221",
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
        beforeEach(async () => {
            mocks.viewer = owner;
            mocks.loadMailDetail.mockReset();
            mocks.orgWritable = true;
            await db().delete(users);
            await db()
                .insert(users)
                .values(
                    [owner, "org-zurna", "member-felno", "curator-tavro"].map(
                        (id) => ({ id, email: `${id}@example.test` }),
                    ),
                );
            await insertRecordings(db(), {
                id: itemId,
                userId: owner,
                deviceSn: "device-veln",
                plaudFileId: "file-veln",
                filename: "Fixture note",
                startTime: new Date(),
                duration: 1000,
                endTime: new Date(),
                filesize: 1,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: "fixture.mp3",
                plaudVersion: "1",
            });
            await db()
                .insert(itemProcessing)
                .values({
                    itemId,
                    userId: owner,
                    view: "private",
                    phases: {
                        learn: {
                            state: "waiting",
                            reason: "review_pending",
                            generation: 2,
                            at: new Date().toISOString(),
                            waitingFor: {
                                kind: "learnReview",
                                until: "2099-01-01T00:00:00Z",
                            },
                        },
                    },
                });
        });
        async function share() {
            await db().insert(recordingFolders).values({
                id: "folder-zurna",
                userId: "org-zurna",
                name: "Fixture",
                nameHash: "fixture-zurna",
                kind: "custom",
            });
            await db()
                .insert(recordingFolderAssignments)
                .values({ itemId, userId: owner, folderId: "folder-zurna" });
            await db()
                .insert(itemProcessing)
                .values({
                    itemId,
                    userId: owner,
                    view: "org",
                    phases: {
                        learn: {
                            state: "failed",
                            reason: "wrong-row",
                            generation: 99,
                            at: new Date().toISOString(),
                        },
                    },
                });
        }
        async function response(view: "private" | "org") {
            return GET(
                new Request(
                    `http://localhost/api/recordings/${itemId}?processing=1&view=${view}`,
                ),
                { params: Promise.resolve({ id: itemId }) },
            );
        }
        it.each([
            "owner-veln",
            "curator-tavro",
            "member-felno",
        ])("serves the private driver's state to shared org viewer %s", async (viewer) => {
            await share();
            mocks.viewer = viewer;
            const result = await response("org");
            expect(result.status).toBe(200);
            const { processing } = (await result.json()) as {
                processing: ItemProcessingPresentation;
            };
            expect(processing.steps.learn).toMatchObject({
                state: "waiting",
                reason: "review_pending",
                waitingFor: { kind: "learnReview" },
            });
            expect(processing.phases.learn?.generation).toBe(2);
            expect(processing.steps.learn.actions).toEqual([]);
            expect(Number.isFinite(Date.parse(processing.nextCheckAt))).toBe(
                true,
            );
            expect((await response("private")).status).toBe(
                viewer === owner ? 200 : 404,
            );
        });
        it.each([
            "owner-veln",
            "curator-tavro",
            "member-felno",
        ])("filters a retry for org viewer %s", async (viewer) => {
            await share();
            mocks.viewer = viewer;
            await db()
                .update(itemProcessing)
                .set({
                    phases: {
                        learn: {
                            state: "failed",
                            reason: "lost",
                            generation: 3,
                            at: new Date().toISOString(),
                            retryable: true,
                        },
                    },
                })
                .where(
                    and(
                        eq(itemProcessing.itemId, itemId),
                        eq(itemProcessing.userId, owner),
                        eq(itemProcessing.view, "private"),
                    ),
                );
            const result = await response("org");
            expect(result.status).toBe(200);
            const { processing } = (await result.json()) as {
                processing: ItemProcessingPresentation;
            };
            expect(processing.steps.learn.actions).toEqual(
                viewer === "member-felno" ? [] : ["retry"],
            );
        });
        async function prepareLearnActions() {
            await share();
            const settings = defaultProfileSettings("audio");
            settings.steps.learn.correctAfterLearn = false;
            await db()
                .insert(processingProfiles)
                .values({
                    id: "profile-org-veln",
                    ownerUserId: "org-zurna",
                    scope: "organization",
                    channel: "audio",
                    name: encryptText("Fixture profile"),
                    isDefault: true,
                    currentRevisionId: "revision-org-veln",
                });
            await db()
                .insert(processingProfileRevisions)
                .values({
                    id: "revision-org-veln",
                    profileId: "profile-org-veln",
                    settings: encryptText(JSON.stringify(settings)),
                });
            await db()
                .update(itemProcessing)
                .set({
                    profileId: "profile-org-veln",
                    profileRevisionId: "revision-org-veln",
                })
                .where(
                    and(
                        eq(itemProcessing.itemId, itemId),
                        eq(itemProcessing.userId, owner),
                        eq(itemProcessing.view, "private"),
                    ),
                );
            await db()
                .insert(transcriptions)
                .values({
                    id: "transcript-actions-veln",
                    recordingId: itemId,
                    userId: owner,
                    text: encryptText("Fixture words"),
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 1_000,
                            text: "Fixture words",
                        },
                    ]),
                    provider: "fixture",
                    model: "fixture",
                    source: "riffado",
                });
        }
        it.each([
            owner,
            "curator-tavro",
            "member-felno",
        ])("routes an Organization Learn retry from %s to the owner's driver", async (viewer) => {
            await prepareLearnActions();
            await db()
                .update(itemProcessing)
                .set({
                    phases: {
                        learn: {
                            state: "failed",
                            reason: "lost",
                            retryable: true,
                            generation: 2,
                            at: new Date().toISOString(),
                        },
                    },
                })
                .where(
                    and(
                        eq(itemProcessing.itemId, itemId),
                        eq(itemProcessing.userId, owner),
                        eq(itemProcessing.view, "private"),
                    ),
                );
            const orgBefore = await readProcessing(itemId, "org", owner);
            const privateBefore = await readProcessing(
                itemId,
                "private",
                owner,
            );
            mocks.viewer = viewer;
            const result = await retryLearn(
                new Request(
                    `http://localhost/api/recordings/${itemId}/learn?view=org`,
                    { method: "POST" },
                ),
                { params: Promise.resolve({ id: itemId }) },
            );
            expect(result.status).toBe(viewer === "member-felno" ? 403 : 202);
            expect(await readProcessing(itemId, "org", owner)).toEqual(
                orgBefore,
            );
            const current = await readProcessing(itemId, "private", owner);
            if (viewer === "member-felno")
                expect(current).toEqual(privateBefore);
            else {
                const body = await result.json();
                expect(current?.phases.learn).toMatchObject({
                    state: "running",
                    jobId: body.jobId,
                });
                const [queued] = await db()
                    .select()
                    .from(asyncJobs)
                    .where(
                        and(
                            eq(asyncJobs.id, body.jobId),
                            eq(asyncJobs.userId, viewer),
                        ),
                    );
                expect(queued?.payload.pipelineSteps).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            itemId,
                            userId: owner,
                            phase: "learn",
                        }),
                    ]),
                );
                expect(
                    (
                        await loadPrivateItemProcessing(
                            owner,
                            itemId,
                            viewer,
                            "en",
                            "org",
                        )
                    )?.steps.learn.state,
                ).toBe("queued");
            }
        });
        it.each([
            owner,
            "curator-tavro",
            "member-felno",
        ])("routes an Organization Learn review from %s to the owner's driver", async (viewer) => {
            await prepareLearnActions();
            await db().insert(learnRuns).values({
                id: "review-run-veln",
                userId: owner,
                scopeUserId: "org-zurna",
                itemId,
                transcriptionId: "transcript-actions-veln",
                view: "org",
                actorUserId: owner,
                trigger: "manual",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status: "ready",
                profileRevisionId: "revision-org-veln",
            });
            await db()
                .insert(learnReviewItems)
                .values({
                    id: "review-item-veln",
                    runId: "review-run-veln",
                    userId: "org-zurna",
                    kind: "correction",
                    fingerprintHmac: "fixture-review-veln",
                    payload: encryptJsonField({
                        startMs: 0,
                        endMs: 1_000,
                        from: "Fixture",
                        to: "Fixture",
                        reason: "Fixture",
                    }),
                    preTicked: false,
                });
            const privateBefore = await readProcessing(
                itemId,
                "private",
                owner,
            );
            const orgBefore = await readProcessing(itemId, "org", owner);
            mocks.viewer = viewer;
            expect(
                (
                    await loadPrivateItemProcessing(
                        owner,
                        itemId,
                        viewer,
                        "en",
                        "org",
                    )
                )?.steps.learn.actions,
            ).toEqual(viewer === "member-felno" ? [] : ["reviewLearn"]);
            const result = await finishLearnReview(
                new Request(
                    `http://localhost/api/recordings/${itemId}/review/finish?view=org`,
                    {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                            versions: { "review-item-veln": 0 },
                        }),
                    },
                ),
                { params: Promise.resolve({ id: itemId }) },
            );
            expect(result.status).toBe(viewer === "member-felno" ? 403 : 200);
            expect(await readProcessing(itemId, "org", owner)).toEqual(
                orgBefore,
            );
            const current = await readProcessing(itemId, "private", owner);
            if (viewer === "member-felno")
                expect(current).toEqual(privateBefore);
            else {
                expect(await result.json()).toMatchObject({
                    status: "finished",
                });
                expect(current?.requestedGeneration).toBeGreaterThan(
                    privateBefore?.requestedGeneration ?? 0,
                );
            }
        });
        it("keeps the existing org authorization for an unshared item", async () => {
            expect((await response("org")).status).toBe(404);
            mocks.viewer = "member-felno";
            expect((await response("private")).status).toBe(404);
        });
        it("counts only pending jobs the same worker would claim ahead, by priority then due time", async () => {
            const target = await enqueueJob({
                userId: owner,
                kind: "learn.run",
                priority: 10,
                pipeline: { itemId, userId: owner, phase: "learn" },
            });
            await db()
                .insert(asyncJobs)
                .values([
                    { userId: "member-felno", kind: "learn.run", priority: 20 },
                    { userId: owner, kind: "learn.run", priority: 1 },
                    { userId: owner, kind: "summary", priority: 99 },
                    {
                        userId: owner,
                        kind: "learn.run",
                        priority: 99,
                        nextAttemptAt: new Date(Date.now() + 600_000),
                    },
                ]);
            const queued = await loadPrivateItemProcessing(owner, itemId);
            expect(queued?.steps.learn).toMatchObject({
                state: "queued",
                waitingFor: { kind: "job", jobId: target.job.id, position: 2 },
            });
            await claimDueJobs("learn.run", 2);
            expect(
                (await loadPrivateItemProcessing(owner, itemId))?.steps.learn
                    .state,
            ).toBe("running");
            await db()
                .update(asyncJobs)
                .set({ heartbeatAt: new Date(Date.now() - 121_000) })
                .where(
                    and(
                        eq(asyncJobs.id, target.job.id),
                        eq(asyncJobs.userId, owner),
                    ),
                );
            expect(
                (await loadPrivateItemProcessing(owner, itemId))?.steps.learn
                    .state,
            ).toBe("stalled");
        });
        it.each([
            "heartbeatAt",
            "startedAt",
            "updatedAt",
        ] as const)("uses the database clock for %s staleness under Europe/Prague", async (clock) => {
            const previous = process.env.TZ;
            process.env.TZ = "Europe/Prague";
            try {
                const target = await enqueueJob({
                    userId: owner,
                    kind: "learn.run",
                    pipeline: { itemId, userId: owner, phase: "learn" },
                });
                await db()
                    .update(asyncJobs)
                    .set({
                        status: "processing",
                        heartbeatAt: null,
                        startedAt: null,
                        [clock]: new Date(),
                    })
                    .where(
                        and(
                            eq(asyncJobs.id, target.job.id),
                            eq(asyncJobs.userId, owner),
                        ),
                    );
                expect(
                    (
                        await loadPipelineProcessingJobs(
                            owner,
                            itemId,
                            (
                                await readProcessing(itemId, "private", owner)
                            )?.phases ?? {},
                        )
                    )[0]?.stale,
                ).toBe(false);
                expect(
                    (await loadPrivateItemProcessing(owner, itemId))?.steps
                        .learn.state,
                ).toBe("running");
                await db()
                    .update(asyncJobs)
                    .set({ [clock]: new Date(Date.now() - 121_000) })
                    .where(
                        and(
                            eq(asyncJobs.id, target.job.id),
                            eq(asyncJobs.userId, owner),
                        ),
                    );
                const result = await loadPrivateItemProcessing(owner, itemId);
                expect(result?.steps.learn.state).toBe("stalled");
                expect(result?.nextCheckInMs).toBe(30_000);
            } finally {
                if (previous === undefined) delete process.env.TZ;
                else process.env.TZ = previous;
            }
        });
        it("presents a future pending attempt as a retry and returns to the queue when due", async () => {
            const target = await enqueueJob({
                userId: owner,
                kind: "learn.run",
                pipeline: { itemId, userId: owner, phase: "learn" },
            });
            const retryAt = new Date(Date.now() + 30_000);
            await db()
                .update(asyncJobs)
                .set({ nextAttemptAt: retryAt })
                .where(
                    and(
                        eq(asyncJobs.id, target.job.id),
                        eq(asyncJobs.userId, owner),
                    ),
                );
            const result = await loadPrivateItemProcessing(owner, itemId);
            expect(result?.steps.learn).toMatchObject({
                state: "queued",
                waitingFor: {
                    kind: "job",
                    status: "retry",
                    retryAt: retryAt.toISOString(),
                },
            });
            expect(result?.steps.learn.waitingFor?.position).toBeUndefined();
            expect(result?.nextCheckInMs).toBeGreaterThan(25_000);
            expect(result?.nextCheckInMs).toBeLessThanOrEqual(30_000);
            await db()
                .update(asyncJobs)
                .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
                .where(
                    and(
                        eq(asyncJobs.id, target.job.id),
                        eq(asyncJobs.userId, owner),
                    ),
                );
            expect(
                (await loadPrivateItemProcessing(owner, itemId))?.steps.learn,
            ).toMatchObject({
                state: "queued",
                waitingFor: { status: "queued", position: 1 },
            });
        });
        it.each([
            "review_pending_timeout",
            "manual_review_pending",
        ])("drops the durable and projected deadline on live -> %s", async (reason) => {
            const until = new Date(Date.now() + 900_000);
            await db()
                .update(chatterItems)
                .set({ summaryDueAt: until })
                .where(
                    and(
                        eq(chatterItems.id, itemId),
                        eq(chatterItems.userId, owner),
                    ),
                );
            expect(
                (await loadPrivateItemProcessing(owner, itemId))?.steps.learn
                    .waitingFor?.until,
            ).toBe(until.toISOString());
            await db().transaction((tx) =>
                updatePhaseInTx(tx, itemId, "private", owner, "learn", {
                    state: "waiting",
                    reason,
                    generation: 3,
                    at: new Date().toISOString(),
                    waitingFor: {
                        kind: "learnReview",
                        until: until.toISOString(),
                    },
                }),
            );
            expect(
                (await readProcessing(itemId, "private", owner))?.phases.learn
                    ?.waitingFor?.until,
            ).toBeUndefined();
            const result = await loadPrivateItemProcessing(owner, itemId);
            expect(result?.steps.learn.reason).toBe(reason);
            expect(result?.steps.learn.waitingFor?.until).toBeUndefined();
            expect(result?.nextCheckInMs).toBe(60_000);
        });
        async function makeMail() {
            await db().insert(chatterItems).values({
                id: "mail-veln",
                userId: owner,
                kind: "mail",
                title: "Fixture mail",
                occurredAt: new Date(),
            });
        }
        async function shareMail() {
            await db().insert(recordingFolders).values({
                id: "mail-folder-zurna",
                userId: "org-zurna",
                name: "Fixture",
                nameHash: "mail-fixture-zurna",
                kind: "custom",
            });
            await db().insert(recordingFolderAssignments).values({
                itemId: "mail-veln",
                userId: owner,
                folderId: "mail-folder-zurna",
            });
        }
        function mailResponse(view: "private" | "org", processing = true) {
            return mailGet(
                new Request(
                    `http://localhost/api/mail/mail-veln?view=${view}${processing ? "&processing=1" : ""}`,
                ),
                { params: Promise.resolve({ id: "mail-veln" }) },
            );
        }
        it.each([
            owner,
            "curator-tavro",
            "member-felno",
        ])("validates both mail views for %s before reading processing or detail", async (viewer) => {
            await makeMail();
            await shareMail();
            mocks.viewer = viewer;
            const result = await mailResponse("org");
            expect(result.status).toBe(200);
            expect((await result.json()).processing.itemId).toBe("mail-veln");
            expect(mocks.loadMailDetail).not.toHaveBeenCalled();
            expect((await mailResponse("private")).status).toBe(
                viewer === owner ? 200 : 404,
            );
            mocks.loadMailDetail.mockResolvedValue({ title: "Fixture mail" });
            expect((await mailResponse("org", false)).status).toBe(200);
            expect(mocks.loadMailDetail).toHaveBeenCalledWith(
                viewer,
                "mail-veln",
            );
            mocks.loadMailDetail.mockClear();
            expect((await mailResponse("private", false)).status).toBe(
                viewer === owner ? 200 : 404,
            );
            if (viewer !== owner)
                expect(mocks.loadMailDetail).not.toHaveBeenCalled();
        });
        it("rejects unavailable mail views, tombstones, missing mail and audio ids", async () => {
            await makeMail();
            expect((await mailResponse("org")).status).toBe(404);
            mocks.viewer = "member-felno";
            expect((await mailResponse("private")).status).toBe(404);
            expect((await mailResponse("org")).status).toBe(404);
            await shareMail();
            expect((await mailResponse("org")).status).toBe(200);
            await db()
                .delete(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.itemId, "mail-veln"),
                        eq(recordingFolderAssignments.userId, owner),
                    ),
                );
            expect((await mailResponse("org")).status).toBe(404);
            mocks.viewer = owner;
            await db()
                .update(chatterItems)
                .set({ deletedAt: new Date() })
                .where(
                    and(
                        eq(chatterItems.id, "mail-veln"),
                        eq(chatterItems.userId, owner),
                    ),
                );
            expect((await mailResponse("private")).status).toBe(404);
            for (const id of [itemId, "missing-mail-tavro"]) {
                expect(
                    (
                        await mailGet(
                            new Request(
                                `http://localhost/api/mail/${id}?processing=1`,
                            ),
                            { params: Promise.resolve({ id }) },
                        )
                    ).status,
                ).toBe(404);
            }
            expect(mocks.loadMailDetail).not.toHaveBeenCalled();
        });
        it("presents a curator-owned job through its owner binding without exposing another user's jobs", async () => {
            const target = await enqueueJob({
                userId: "curator-tavro",
                kind: "learn.run",
                pipeline: { itemId, userId: owner, phase: "learn" },
            });
            expect(
                (await loadPrivateItemProcessing(owner, itemId))?.steps.learn
                    .waitingFor?.jobId,
            ).toBe(target.job.id);
            expect(
                await loadPrivateItemProcessing("member-felno", itemId),
            ).toBeNull();
        });
        it("keeps shared content view-only while the Organization is unavailable", async () => {
            await share();
            mocks.orgWritable = false;
            await db()
                .update(itemProcessing)
                .set({
                    phases: {
                        learn: {
                            state: "failed",
                            reason: "lost",
                            retryable: true,
                            generation: 2,
                            at: new Date().toISOString(),
                        },
                    },
                })
                .where(
                    and(
                        eq(itemProcessing.itemId, itemId),
                        eq(itemProcessing.userId, owner),
                        eq(itemProcessing.view, "private"),
                    ),
                );
            for (const viewer of [owner, "curator-tavro"]) {
                mocks.viewer = viewer;
                const result = await response("org");
                expect(result.status).toBe(200);
                const { processing } = (await result.json()) as {
                    processing: ItemProcessingPresentation;
                };
                expect(processing.steps.learn.actions).toEqual([]);
            }
        });
        it("ranks Share work by fair user rounds and excludes users whose worker is already busy", async () => {
            const first = new Date(Date.now() - 60_000);
            const second = new Date(Date.now() - 30_000);
            const [target] = await db()
                .insert(asyncJobs)
                .values({
                    userId: owner,
                    kind: "pipeline.action",
                    priority: 1,
                    nextAttemptAt: second,
                    payload: { pipelineSteps: [] },
                })
                .returning();
            const [ahead] = await db()
                .insert(asyncJobs)
                .values({
                    userId: owner,
                    kind: "pipeline.action",
                    priority: 10,
                    nextAttemptAt: first,
                })
                .returning();
            const [other] = await db()
                .insert(asyncJobs)
                .values({
                    userId: "member-felno",
                    kind: "pipeline.action",
                    priority: 0,
                    nextAttemptAt: second,
                })
                .returning();
            await db()
                .update(itemProcessing)
                .set({
                    phases: {
                        share: {
                            state: "running",
                            jobId: target.id,
                            generation: 1,
                            at: new Date().toISOString(),
                        },
                    },
                })
                .where(
                    and(
                        eq(itemProcessing.itemId, itemId),
                        eq(itemProcessing.userId, owner),
                        eq(itemProcessing.view, "private"),
                    ),
                );
            expect(
                (await loadPrivateItemProcessing(owner, itemId))?.steps.share
                    .waitingFor?.position,
            ).toBe(3);
            expect(
                new Set(
                    (await claimDueJobs("pipeline.action", 2)).map(
                        (row) => row.id,
                    ),
                ),
            ).toEqual(new Set([ahead.id, other.id]));
            expect(
                (await loadPrivateItemProcessing(owner, itemId))?.steps.share
                    .waitingFor?.position,
            ).toBe(1);
        });
        it("presents a real pending legacy job even without a stored job binding", async () => {
            const [legacy] = await db()
                .insert(asyncJobs)
                .values({ userId: owner, kind: "learn.run", subjectId: itemId })
                .returning();
            expect(
                (await loadPrivateItemProcessing(owner, itemId))?.steps.learn,
            ).toMatchObject({
                state: "queued",
                waitingFor: { kind: "job", jobId: legacy.id },
            });
        });
    },
);
