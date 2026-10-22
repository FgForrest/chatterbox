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
    itemProcessing,
    recordingFolderAssignments,
    recordingFolders,
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
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async (id: string) =>
        id === "curator-tavro" || id === "org-zurna",
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: mocks.viewer } }),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));

import { GET } from "@/app/api/recordings/[id]/route";
import { claimDueJobs, enqueueJob } from "@/db/queries/async-jobs";
import {
    type ItemProcessingPresentation,
    loadPrivateItemProcessing,
} from "@/lib/pipeline/presentation";

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
