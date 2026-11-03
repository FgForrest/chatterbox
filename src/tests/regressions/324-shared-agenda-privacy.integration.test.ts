import { eq } from "drizzle-orm";
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
    agendaPoints,
    agendaSuggestions,
    agendaTasks,
    aiEnhancements,
    chatterItems,
    folderShares,
    meetingAgendas,
    receivedFolderAttachments,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    users,
} from "@/db/schema";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const state = vi.hoisted(() => ({
    actor: "owner",
    current: null as Record<PropertyKey, unknown> | null,
    complete: vi.fn(),
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get(_target, key) {
                const value = state.current?.[key];
                return typeof value === "function"
                    ? value.bind(state.current)
                    : value;
            },
        },
    ),
    sqlClient: null,
}));
vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "agenda-viewer-privacy-test",
        APP_URL: "http://localhost:3000",
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
    },
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: state.actor } }),
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org",
    isOrgAccount: async (id: string) => id === "org",
    isOrgScopeVisible: () => true,
    isOrgScopeEnabled: () => true,
    assertOrgScopeWritable: () => undefined,
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async (id: string) =>
        id === "curator" || id === "org",
    actsForOrganization: async () => false,
}));
vi.mock("@/lib/meetings/suggestions-provider", () => ({
    agendaSuggestionsProvider: async (userId: string, id: string) => {
        const access = await requireMeetingAccess(userId, id, "edit");
        return {
            access,
            folders: await meetingFolders(db, "meeting", "owner"),
            pin: null,
            outputLanguage: "en",
        };
    },
    agendaSuggestionsAvailability: async () => ({
        available: false,
        reason: null,
    }),
}));
vi.mock("@/lib/summary/summary-model", () => ({
    summaryModelFor: async () => ({
        payerUserId: "org",
        credentials: { id: "test", provider: "test" },
        model: "test-model",
        reserveCall: async () => undefined,
        openai: { chat: { completions: { create: state.complete } } },
    }),
}));
vi.mock("@/lib/ai/usage-attempt", () => ({
    chatCompletionWithUsage: async (
        _context: unknown,
        call: () => Promise<unknown>,
    ) => call(),
}));
vi.mock("@/lib/meetings/calendar-snapshot", () => ({
    readMeetingCalendarSnapshot: async () => null,
}));
vi.mock("@/lib/learn/summary-refresh", () => ({
    isSummaryStale: async () => false,
}));
vi.mock("@/lib/pipeline/trigger", () => ({
    requestAdvanceInTx: async () => undefined,
}));
vi.mock("@/lib/profiles/placement-binding", () => ({
    bindPlacementProfileInTx: async () => undefined,
}));
vi.mock("@/lib/knowledge/share-knowledge", () => ({
    publishKnowledgeInTx: async () => ({ scopes: new Set() }),
    withdrawKnowledgeInTx: async () => new Set(),
}));
vi.mock("@/lib/knowledge/embeddings", () => ({ embeddingClient: () => null }));
vi.mock("@/lib/mail/redact", () => ({
    secretAddressMasker: async () => (text: string) => text,
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: async () => undefined,
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));

import { GET as getRoute } from "@/app/api/meetings/[id]/route";
import { GET as listRoute } from "@/app/api/meetings/route";
import { db } from "@/db";
import { loadAgendaSourceVisibility } from "@/db/queries/agenda-source-visibility";
import { agendaSuggestionInputs } from "@/db/queries/agenda-suggestions";
import { meetingFolders } from "@/db/queries/meetings";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import type { McpCaller } from "@/lib/mcp/caller";
import { MEETING_TOOLS } from "@/lib/mcp/tools/meetings";
import { requireMeetingAccess } from "@/lib/meetings/access";
import {
    getMeeting,
    listMeetings,
    meetingFolderPaths,
} from "@/lib/meetings/service";
import { agendaSuggestionsJobHandler } from "@/lib/meetings/suggestions-job";
import { taskViewerById } from "@/lib/tasks/access";

const url = getTestDatabaseUrl();
const viewers = ["owner", "receiver", "curator", "org"] as const;

describe.skipIf(!url)("#324 shared agenda viewer privacy (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "agenda_viewer_privacy",
        );
        state.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120000);
    afterAll(async () => {
        state.current = null;
        await database?.dispose();
    }, 120000);
    beforeEach(async () => {
        state.complete.mockReset();
        await db.delete(users);
        await db.insert(users).values(
            viewers.map((id) => ({
                id,
                email: `${id}@example.com`,
                role: id === "org" ? ("org" as const) : ("user" as const),
            })),
        );
        for (const id of ["owner", "receiver", "org"]) {
            await db.insert(recordingFolders).values({
                id: `${id}-root`,
                userId: id,
                kind: id === "org" ? "public" : "private",
                name: encryptText(`${id} root`),
                nameHash: "root",
            });
        }
        for (const [id, userId, name] of [
            ["private-folder", "owner", "Confidential planning"],
            ["person-folder", "owner", "Original shared name"],
            ["org-folder", "org", "Team planning"],
        ]) {
            await db.insert(recordingFolders).values({
                id,
                userId,
                name: encryptText(name),
                nameHash: id,
                parentId: `${userId}-root`,
                kind: "custom",
            });
        }
        await db.insert(folderShares).values({
            id: "person-share",
            userId: "owner",
            folderId: "person-folder",
            receiverUserId: "receiver",
            state: "accepted",
        });
        await db.insert(receivedFolderAttachments).values({
            id: "received-folder",
            userId: "receiver",
            shareId: "person-share",
            parentId: "receiver-root",
            name: encryptText("My received planning"),
        });
        await db.insert(chatterItems).values({
            id: "meeting",
            userId: "owner",
            kind: "meeting",
            title: encryptText("Planning"),
            occurredAt: new Date(),
        });
        await db.insert(meetingAgendas).values({
            id: "agenda",
            userId: "owner",
            meetingItemId: "meeting",
        });
        await db.insert(recordingFolderAssignments).values(
            ["private-folder", "person-folder", "org-folder"].map(
                (folderId) => ({
                    itemId: "meeting",
                    userId: "owner",
                    folderId,
                }),
            ),
        );
        for (const scope of ["private", "person", "org"]) {
            const itemId = `${scope}-recording`;
            await insertRecordings(database.db, {
                id: itemId,
                userId: "owner",
                filename: encryptText(itemId),
                startTime: new Date("2026-01-01T10:00:00Z"),
                endTime: new Date("2026-01-01T11:00:00Z"),
                duration: 3600000,
                filesize: 1,
                fileMd5: "a".repeat(32),
                storageType: "local",
                storagePath: `${itemId}.ogg`,
                deviceSn: "test",
                plaudFileId: itemId,
                plaudVersion: "1",
            });
            await db.insert(chatterItems).values({
                id: `${scope}-mail`,
                userId: "owner",
                kind: "mail",
                title: encryptText(`${scope} mail`),
                occurredAt: new Date(),
            });
            for (const id of [itemId, `${scope}-mail`]) {
                await db.insert(recordingFolderAssignments).values({
                    itemId: id,
                    userId: "owner",
                    folderId: `${scope}-folder`,
                });
                await db.insert(aiEnhancements).values({
                    itemId: id,
                    userId: "owner",
                    source: "riffado",
                    provider: "test",
                    model: "test",
                    summary: encryptText(`${scope} summary`),
                });
            }
            await db.insert(recordingTasks).values({
                id: `${scope}-task`,
                itemId,
                userId: "owner",
                source: "manual",
                status: "open",
                text: encryptText(`${scope} task`),
            });
            await db.insert(agendaTasks).values({
                agendaId: "agenda",
                userId: "owner",
                taskId: `${scope}-task`,
                origin: "older",
            });
            for (const kind of ["recording", "mail", "task"]) {
                await db.insert(agendaSuggestions).values({
                    id: `${scope}-${kind}-suggestion`,
                    agendaId: "agenda",
                    userId: "owner",
                    kind: "ai",
                    text: encryptText(`${scope} ${kind} derived text`),
                    sources: {
                        itemIds: kind === "task" ? [] : [`${scope}-${kind}`],
                        taskIds: kind === "task" ? [`${scope}-task`] : [],
                    },
                });
            }
        }
        await db.insert(agendaSuggestions).values({
            id: "mixed-suggestion",
            agendaId: "agenda",
            userId: "owner",
            kind: "carry_over",
            text: encryptText("Mixed confidential derived text"),
            sources: {
                itemIds: ["org-recording", "private-mail"],
                taskIds: ["org-task", "private-task"],
            },
        });
        await db
            .update(meetingAgendas)
            .set({
                taskSourceItemId: "private-recording",
                snapshotSourceItemId: "private-recording",
            })
            .where(eq(meetingAgendas.id, "agenda"));
    });

    function scopes(viewer: string) {
        return viewer === "owner"
            ? ["private", "person", "org"]
            : viewer === "receiver"
              ? ["person", "org"]
              : ["org"];
    }
    async function sourcedPoints() {
        await db.insert(agendaPoints).values({
            id: "manual-point",
            agendaId: "agenda",
            userId: "owner",
            text: encryptText("Manual plan"),
            origin: "manual",
        });
        for (const scope of ["private", "person", "org"])
            for (const kind of ["recording", "mail", "task"])
                await db.insert(agendaPoints).values({
                    id: `${scope}-${kind}-point`,
                    agendaId: "agenda",
                    userId: "owner",
                    text: encryptText(`${scope} ${kind} accepted point`),
                    origin: "ai",
                    sources: {
                        itemIds: kind === "task" ? [] : [`${scope}-${kind}`],
                        taskIds: kind === "task" ? [`${scope}-task`] : [],
                    },
                });
    }
    async function generationInput(userId: string) {
        const [agenda] = await db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, "agenda"));
        return agendaSuggestionInputs({
            agenda,
            folderId: ["private-folder", "person-folder", "org-folder"],
            userId,
            orgUserId: "org",
            viewer: {
                ...(await taskViewerById(userId)),
                includeReceived: true,
            },
        });
    }
    async function regenerate(userId: string) {
        return agendaSuggestionsJobHandler.run({
            userId,
            payload: { agendaId: "agenda" },
            jobId: "test",
            attempt: 1,
            maxAttempts: 3,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
    }

    it.each([
        "receiver",
        "curator",
        "org",
    ])("keeps hidden derived text out of %s regeneration and its stored result", async (viewer) => {
        await sourcedPoints();
        await db
            .update(agendaSuggestions)
            .set({ state: "dismissed" })
            .where(eq(agendaSuggestions.id, "private-recording-suggestion"));
        await db
            .update(agendaSuggestions)
            .set({ state: "added" })
            .where(eq(agendaSuggestions.id, "private-mail-suggestion"));
        state.complete.mockImplementation(async (params) => ({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            suggestions: [
                                {
                                    text: /private |Mixed confidential/u.test(
                                        JSON.stringify(params.messages),
                                    )
                                        ? "Leaked private agenda context"
                                        : "Review team progress",
                                    sources: {
                                        itemIds: ["org-recording"],
                                        taskIds: ["org-task"],
                                    },
                                },
                            ],
                        }),
                    },
                },
            ],
        }));
        expect(await regenerate(viewer)).toEqual({ count: 1 });
        expect(state.complete).toHaveBeenCalledTimes(1);
        const prompt = JSON.parse(
            state.complete.mock.calls[0][0].messages[1].content,
        );
        expect(JSON.stringify(prompt)).not.toMatch(
            /private |Mixed confidential/u,
        );
        const visibleScopes = scopes(viewer);
        expect(
            prompt.previousSuggestions
                .map((row: { text: string }) => row.text)
                .sort(),
        ).toEqual(
            visibleScopes
                .flatMap((scope) =>
                    ["recording", "mail", "task"].map(
                        (kind) => `${scope} ${kind} derived text`,
                    ),
                )
                .sort(),
        );
        expect(
            prompt.currentPoints.map((row: { id: string }) => row.id).sort(),
        ).toEqual(
            [
                "manual-point",
                ...visibleScopes.flatMap((scope) =>
                    ["recording", "mail", "task"].map(
                        (kind) => `${scope}-${kind}-point`,
                    ),
                ),
            ].sort(),
        );
        expect(
            prompt.openTasks.map((row: { id: string }) => row.id).sort(),
        ).toEqual(visibleScopes.map((scope) => `${scope}-task`).sort());
        expect(
            prompt.summaries
                .map((row: { itemId: string }) => row.itemId)
                .sort(),
        ).toEqual(
            visibleScopes
                .flatMap((scope) => [`${scope}-recording`, `${scope}-mail`])
                .sort(),
        );
        const [stored] = await db
            .select()
            .from(agendaSuggestions)
            .where(eq(agendaSuggestions.createdByUserId, viewer));
        expect(decryptText(stored.text)).toBe("Review team progress");
        expect(stored.sources).toEqual({
            itemIds: ["org-recording"],
            taskIds: ["org-task"],
        });
        expect((await detail(viewer)).suggestions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: stored.id,
                    text: "Review team progress",
                    sources: stored.sources,
                }),
            ]),
        );
    });

    it("keeps owner generation context and provenance, including accepted and carry-over sources", async () => {
        await sourcedPoints();
        const input = await generationInput("owner");
        expect(input.suggestions).toHaveLength(10);
        expect(input.points).toHaveLength(10);
        expect(
            input.suggestions.find((row) =>
                decryptText(row.text).startsWith("Mixed"),
            )?.sources,
        ).toEqual({
            itemIds: ["org-recording", "private-mail"],
            taskIds: ["org-task", "private-task"],
        });
        expect(
            input.points.find((row) => row.id === "private-mail-point")
                ?.sources,
        ).toEqual({
            itemIds: ["private-mail"],
            taskIds: [],
        });
        state.complete.mockResolvedValue({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            suggestions: [
                                {
                                    text: "Review private follow-up",
                                    sources: {
                                        itemIds: ["private-mail"],
                                        taskIds: ["private-task"],
                                    },
                                },
                            ],
                        }),
                    },
                },
            ],
        });
        expect(await regenerate("owner")).toEqual({ count: 1 });
        const [stored] = await db
            .select()
            .from(agendaSuggestions)
            .where(eq(agendaSuggestions.createdByUserId, "owner"));
        expect(stored.sources).toEqual({
            itemIds: ["private-mail"],
            taskIds: ["private-task"],
        });
        expect(
            (await detail("owner")).suggestions.some(
                (row) => row.id === stored.id,
            ),
        ).toBe(true);
        for (const viewer of ["receiver", "curator", "org"])
            expect(
                (await detail(viewer)).suggestions.some(
                    (row) => row.id === stored.id,
                ),
            ).toBe(false);
    });

    it("checks all context sources in one SQL statement, matching read visibility", async () => {
        const viewer = {
            ...(await taskViewerById("curator")),
            includeReceived: true,
        };
        const query = vi.spyOn(database.sql, "unsafe");
        try {
            const visible = await loadAgendaSourceVisibility(
                viewer,
                Array.from({ length: 50 }, () => ({
                    itemIds: [
                        "org-recording",
                        "org-mail",
                        "private-recording",
                        "missing-item",
                    ],
                    taskIds: ["org-task", "private-task", "missing-task"],
                })),
            );
            expect(query).toHaveBeenCalledTimes(1);
            expect(
                visible({ itemIds: ["org-mail"], taskIds: ["org-task"] }),
            ).toBe(true);
            expect(
                visible({
                    itemIds: ["org-mail", "private-recording"],
                    taskIds: [],
                }),
            ).toBe(false);
            expect(visible({ itemIds: [], taskIds: ["private-task"] })).toBe(
                false,
            );
            expect(visible({ itemIds: ["missing-item"], taskIds: [] })).toBe(
                false,
            );
            expect(visible({ itemIds: [], taskIds: ["missing-task"] })).toBe(
                false,
            );
            expect(visible(null)).toBe(true);
        } finally {
            query.mockRestore();
        }
    });

    it("rechecks withdrawn, deleted and missing sources before generation, including open tasks", async () => {
        await sourcedPoints();
        await db
            .delete(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, "org-mail"));
        await db
            .update(chatterItems)
            .set({ deletedAt: new Date() })
            .where(eq(chatterItems.id, "org-recording"));
        await db.insert(agendaSuggestions).values({
            userId: "owner",
            agendaId: "agenda",
            kind: "ai",
            text: encryptText("Missing source text"),
            sources: { itemIds: ["missing-item"], taskIds: [] },
        });
        await db.insert(recordingTasks).values({
            id: "meeting-task",
            userId: "owner",
            itemId: "meeting",
            source: "manual",
            status: "open",
            text: encryptText("Non-content task text"),
        });
        for (const viewer of ["curator", "org"]) {
            const input = await generationInput(viewer);
            expect(input.suggestions).toEqual([]);
            expect(input.points.map((point) => point.id)).toEqual([
                "manual-point",
            ]);
            expect(input.tasks).toEqual([]);
            expect(input.summaries).toEqual([]);
        }
    });
    async function detail(viewer: string) {
        const result = await getMeeting(viewer, "agenda", undefined, true);
        if (result.unchanged) throw new Error("Expected full meeting");
        return result;
    }
    async function web(viewer: string, folderId?: string) {
        state.actor = viewer;
        const response = await listRoute(
            new Request(
                `http://localhost/api/meetings${folderId ? `?folderId=${folderId}` : ""}`,
            ),
            { params: Promise.resolve({}) },
        );
        expect(response.status).toBe(200);
        return response.json();
    }
    async function mcp(
        viewer: string,
        name: string,
        args: Record<string, unknown>,
    ) {
        const caller: McpCaller = {
            kind: "user",
            userId: viewer,
            email: `${viewer}@example.com`,
            orgUserId: "org",
            subject: viewer,
            clientId: "test",
            roles: new Set(["tasks:read", "mail:read"]),
        };
        const tool = MEETING_TOOLS.find((tool) => tool.name === name);
        if (!tool) throw new Error("Missing tool");
        return tool.run({ caller, touched: [] }, args);
    }

    it("returns suggestions only when every source is visible to every viewer", async () => {
        const [agenda] = await db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, "agenda"));
        const input = await agendaSuggestionInputs({
            agenda,
            folderId: ["org-folder", "private-folder"],
            userId: "owner",
            orgUserId: "org",
            viewer: await taskViewerById("owner"),
        });
        expect(input.summaries.map((row) => row.itemId).sort()).toEqual([
            "org-mail",
            "org-recording",
            "private-mail",
            "private-recording",
        ]);
        expect(input.tasks.map((row) => row.id).sort()).toEqual([
            "org-task",
            "private-task",
        ]);

        for (const viewer of viewers) {
            const result = await detail(viewer);
            const expected = scopes(viewer).flatMap((scope) =>
                ["recording", "mail", "task"].map(
                    (kind) => `${scope}-${kind}-suggestion`,
                ),
            );
            if (viewer === "owner") expected.push("mixed-suggestion");
            expect(result.suggestions.map((row) => row.id).sort()).toEqual(
                expected.sort(),
            );
            expect(
                (result.suggestionTasks ?? []).map((row) => row.id).sort(),
            ).toEqual(
                scopes(viewer)
                    .map((scope) => `${scope}-task`)
                    .sort(),
            );
            expect(
                await mcp(viewer, "get_meeting", { meetingId: "agenda" }),
            ).toMatchObject({ meeting: { suggestions: result.suggestions } });
            state.actor = viewer;
            const response = await getRoute(
                new Request("http://localhost/api/meetings/agenda"),
                { params: Promise.resolve({ id: "agenda" }) },
            );
            expect(response.status).toBe(200);
            expect((await response.json()).suggestions).toEqual(
                JSON.parse(JSON.stringify(result.suggestions)),
            );
        }
    });

    it("rechecks withdrawn recording, mail and task sources for every viewer", async () => {
        for (const viewer of viewers) {
            await db
                .delete(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.folderId, "org-folder"));
            await db.insert(recordingFolderAssignments).values({
                itemId: "meeting",
                userId: "owner",
                folderId: "org-folder",
            });
            const expected = scopes(viewer)
                .filter((scope) => scope !== "org")
                .flatMap((scope) =>
                    ["recording", "mail", "task"].map(
                        (kind) => `${scope}-${kind}-suggestion`,
                    ),
                );
            if (viewer === "owner")
                expected.push(
                    "org-recording-suggestion",
                    "org-mail-suggestion",
                    "org-task-suggestion",
                    "mixed-suggestion",
                );
            expect(
                (await detail(viewer)).suggestions.map((row) => row.id).sort(),
            ).toEqual(expected.sort());
        }
    });

    it("projects detail, lists, filters and reminder paths for every viewer", async () => {
        for (const viewer of viewers) {
            const result = await detail(viewer);
            const expected =
                viewer === "owner"
                    ? ["private-folder", "person-folder", "org-folder"]
                    : viewer === "receiver"
                      ? ["received-folder", "org-folder"]
                      : ["org-folder"];
            expect(result.folders.map((row) => row.id).sort()).toEqual(
                expected.sort(),
            );
            const listed = await listMeetings(viewer);
            expect(listed[0].folders).toEqual(
                [...result.folders].sort((a, b) => a.id.localeCompare(b.id)),
            );
            expect(await web(viewer)).toMatchObject({
                meetings: [
                    expect.objectContaining({ folders: listed[0].folders }),
                ],
            });
            expect(await mcp(viewer, "list_meetings", {})).toMatchObject({
                meetings: listed,
            });
            for (const folderId of [
                "private-folder",
                "person-folder",
                "received-folder",
                "org-folder",
                "missing-folder",
            ]) {
                const allowed =
                    expected.includes(folderId) ||
                    (viewer === "receiver" && folderId === "person-folder");
                expect(await listMeetings(viewer, { folderId })).toHaveLength(
                    allowed ? 1 : 0,
                );
                expect((await web(viewer, folderId)).meetings).toHaveLength(
                    allowed ? 1 : 0,
                );
            }
            const path = await meetingFolderPaths(viewer);
            expect(
                path([
                    {
                        id: "private-folder",
                        name: "Confidential planning",
                        parentId: "owner-root",
                    },
                ]),
            ).toBe(
                viewer === "owner" ? "owner root / Confidential planning" : "",
            );
            expect(
                path([
                    {
                        id: "person-folder",
                        name: "Original shared name",
                        parentId: "owner-root",
                    },
                ]),
            ).toBe(
                viewer === "owner"
                    ? "owner root / Original shared name"
                    : viewer === "receiver"
                      ? "receiver root / My received planning"
                      : "",
            );
            expect(
                path([
                    {
                        id: "missing-folder",
                        name: "Hidden fallback",
                        parentId: null,
                    },
                ]),
            ).toBe("");
            expect(
                path([
                    { id: "aaa-hidden", name: "Hidden", parentId: null },
                    {
                        id: "org-folder",
                        name: "Team planning",
                        parentId: "org-root",
                    },
                ]),
            ).toBe("org root / Team planning");
            if (viewer === "receiver")
                expect(
                    result.folders.find((row) => row.id === "received-folder"),
                ).toMatchObject({
                    name: "My received planning",
                    parentId: "receiver-root",
                });
        }
    });

    it("checks each task source pointer independently for every viewer", async () => {
        for (const viewer of viewers) {
            for (const [taskSourceItemId, snapshotSourceItemId] of [
                ["private-recording", "org-recording"],
                ["org-recording", "private-recording"],
            ]) {
                await db
                    .update(meetingAgendas)
                    .set({ taskSourceItemId, snapshotSourceItemId })
                    .where(eq(meetingAgendas.id, "agenda"));
                const result = await detail(viewer);
                expect(result.taskSourceItemId).toBe(
                    viewer === "owner" || taskSourceItemId === "org-recording"
                        ? taskSourceItemId
                        : null,
                );
                expect(result.snapshotSourceItemId).toBe(
                    viewer === "owner" ||
                        snapshotSourceItemId === "org-recording"
                        ? snapshotSourceItemId
                        : null,
                );
                expect(result.taskSource?.id ?? null).toBe(
                    result.snapshotSourceItemId,
                );
            }
        }
    });

    it("counts only the tasks visible to every viewer", async () => {
        for (const viewer of viewers) {
            const result = await detail(viewer);
            expect(result.tasks).toHaveLength(scopes(viewer).length);
            expect((await listMeetings(viewer))[0].counts.tasks).toBe(
                result.tasks.length,
            );
            expect((await web(viewer)).meetings[0].counts.tasks).toBe(
                result.tasks.length,
            );
        }
    });
    it("keeps a person-shared agenda in the receiver's filing and rechecks its invitation", async () => {
        await db.insert(chatterItems).values({
            id: "person-meeting",
            userId: "owner",
            kind: "meeting",
            title: encryptText("Person planning"),
            occurredAt: new Date(),
        });
        await db.insert(meetingAgendas).values({
            id: "person-agenda",
            userId: "owner",
            meetingItemId: "person-meeting",
            taskSourceItemId: "private-recording",
            snapshotSourceItemId: "private-recording",
        });
        await db.insert(recordingFolderAssignments).values(
            ["person-folder", "private-folder"].map((folderId) => ({
                itemId: "person-meeting",
                userId: "owner",
                folderId,
            })),
        );
        for (const scope of ["private", "person"]) {
            await db.insert(agendaTasks).values({
                agendaId: "person-agenda",
                userId: "owner",
                taskId: `${scope}-task`,
                origin: "older",
            });
            await db.insert(agendaSuggestions).values({
                id: `person-agenda-${scope}-suggestion`,
                agendaId: "person-agenda",
                userId: "owner",
                kind: "ai",
                text: encryptText(`${scope} derived text`),
                sources: {
                    itemIds: [`${scope}-recording`],
                    taskIds: [`${scope}-task`],
                },
            });
        }
        for (const viewer of viewers) {
            if (viewer === "curator" || viewer === "org") {
                await expect(
                    getMeeting(viewer, "person-agenda"),
                ).rejects.toMatchObject({ statusCode: 404 });
                continue;
            }
            const result = await getMeeting(viewer, "person-agenda");
            if (result.unchanged) throw new Error("Expected detail");
            expect(result.folders.map((row) => row.id).sort()).toEqual(
                viewer === "owner"
                    ? ["person-folder", "private-folder"]
                    : ["received-folder"],
            );
            expect(result.suggestions.map((row) => row.id).sort()).toEqual(
                viewer === "owner"
                    ? [
                          "person-agenda-person-suggestion",
                          "person-agenda-private-suggestion",
                      ]
                    : ["person-agenda-person-suggestion"],
            );
            expect(result.tasks).toHaveLength(viewer === "owner" ? 2 : 1);
            expect(result.taskSourceItemId).toBe(
                viewer === "owner" ? "private-recording" : null,
            );
            expect(result.snapshotSourceItemId).toBe(
                viewer === "owner" ? "private-recording" : null,
            );
            const listed = await listMeetings(viewer, {
                folderId:
                    viewer === "owner" ? "person-folder" : "received-folder",
            });
            expect(
                listed.find((row) => row.id === "person-agenda")?.counts.tasks,
            ).toBe(result.tasks.length);
        }
        await db
            .delete(folderShares)
            .where(eq(folderShares.id, "person-share"));
        await expect(
            getMeeting("receiver", "person-agenda"),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect((await detail("receiver")).folders.map((row) => row.id)).toEqual(
            ["org-folder"],
        );
        expect(
            (await detail("receiver")).suggestions.map((row) => row.id).sort(),
        ).toEqual([
            "org-mail-suggestion",
            "org-recording-suggestion",
            "org-task-suggestion",
        ]);
        expect(
            await listMeetings("receiver", { folderId: "received-folder" }),
        ).toEqual([]);
        const path = await meetingFolderPaths("receiver");
        expect(
            path([
                {
                    id: "person-folder",
                    name: "Original shared name",
                    parentId: "owner-root",
                },
            ]),
        ).toBe("");
    });
});
