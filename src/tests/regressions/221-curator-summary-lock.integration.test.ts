import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    asyncJobs,
    chatterItems,
    itemProcessing,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbRef, actor } = vi.hoisted(() => ({
    dbRef: { current: null as Record<PropertyKey, unknown> | null },
    actor: { userId: "curator-novra" },
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get: (_, key) => {
                if (!dbRef.current) throw new Error("database not ready");
                const value = dbRef.current[key];
                return typeof value === "function"
                    ? value.bind(dbRef.current)
                    : value;
            },
        },
    ),
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSessionActor: async () => ({
        session: { user: { id: actor.userId } },
        actor: {},
    }),
}));
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: async () => true,
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org-telvo",
    assertOrgScopeWritable: () => {},
}));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveSelectedProfile: async () => ({
        profile: { channel: "mail" },
        revisionId: "revision-telvo",
    }),
}));
vi.mock("@/lib/jobs/watch", () => ({
    watchJob: async () => ({ row: null, reason: "timeout" }),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: () => {} }));
vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

import { POST } from "@/app/api/recordings/[id]/summary/route";
import * as pipelineJobs from "@/db/queries/pipeline-jobs";

const url = getTestDatabaseUrl();
(url ? describe : describe.skip)("#221 curator summary locking", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "curator_summary_221",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        const db = database.db;
        await db.insert(users).values(
            ["owner-zivra", "curator-novra", "org-telvo"].map((id) => ({
                id,
                email: `${id}@example.test`,
            })),
        );
        await db.insert(chatterItems).values({
            id: "item-zivra",
            userId: "owner-zivra",
            kind: "mail",
            title: "Fictional notes",
            occurredAt: new Date(),
        });
        await db.insert(recordingFolders).values({
            id: "folder-telvo",
            userId: "org-telvo",
            name: "Fictional shared folder",
            nameHash: "f".repeat(64),
        });
        await db.insert(recordingFolderAssignments).values({
            itemId: "item-zivra",
            folderId: "folder-telvo",
            userId: "org-telvo",
        });
        await db.insert(processingProfiles).values({
            id: "profile-telvo",
            ownerUserId: "org-telvo",
            scope: "organization",
            channel: "mail",
            name: "Fictional profile",
        });
        await db.insert(processingProfileRevisions).values({
            id: "revision-telvo",
            profileId: "profile-telvo",
            settings: "fixture",
        });
        const input = {
            contentId: "content-zivra",
            contentSourceId: "mail",
            contentRevision: 1,
        };
        await db.insert(itemProcessing).values({
            itemId: "item-zivra",
            userId: "owner-zivra",
            view: "private",
            phases: {
                summary: {
                    state: "pending",
                    generation: 1,
                    at: new Date().toISOString(),
                    inputs: input,
                    steps: {
                        summary: { ...input, generation: 1, state: "pending" },
                    },
                },
            },
        });
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it.each([
        "curator-novra",
        "org-telvo",
    ])("locks the owner's driver before the profile guard and binds the summary requested by %s", async (actorId) => {
        actor.userId = actorId;
        const locks = vi.spyOn(pipelineJobs, "lockPipelineTargetsInTx");
        try {
            const response = await POST(
                new Request(
                    "http://localhost/api/recordings/item-zivra/summary?view=org",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ profileId: "profile-telvo" }),
                    },
                ),
                { params: Promise.resolve({ id: "item-zivra" }) },
            );
            expect(response.status).toBe(202);
            const { jobId } = await response.json();
            expect(locks).toHaveBeenNthCalledWith(
                1,
                expect.anything(),
                [{ itemId: "item-zivra", userId: "owner-zivra" }],
                true,
            );
            const [job] = await database.db
                .select()
                .from(asyncJobs)
                .where(
                    and(eq(asyncJobs.id, jobId), eq(asyncJobs.userId, actorId)),
                );
            expect(job.payload.pipelineSteps).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        itemId: "item-zivra",
                        userId: "owner-zivra",
                        phase: "summary",
                        step: "summary",
                    }),
                ]),
            );
            const [processing] = await database.db
                .select()
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, "item-zivra"),
                        eq(itemProcessing.userId, "owner-zivra"),
                        eq(itemProcessing.view, "private"),
                    ),
                );
            expect(processing.phases.summary?.steps?.summary?.jobId).toBe(
                jobId,
            );
            await database.db
                .delete(asyncJobs)
                .where(
                    and(eq(asyncJobs.id, jobId), eq(asyncJobs.userId, actorId)),
                );
        } finally {
            locks.mockRestore();
        }
    });
});
