import type { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import unzipper from "unzipper";
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
    apiCredentials,
    asyncJobs,
    chatterItems,
    itemProcessing,
    learnDismissals,
    learnReviewItems,
    learnRuns,
    processingProfiles,
    recordings,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { localActor } from "@/tests/helpers/session-actor";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { seedExistingPersonalProfiles } from "@/tests/integration/profile-fixtures";
import {
    insertRecording,
    shareRecording,
    userCaller,
} from "@/tests/mcp/fixtures";

const { dbRef, dbProxy, chat, generateTitle, mockEnv, actorId } = vi.hoisted(
    () => {
        const dbRef: { current: Record<PropertyKey, unknown> | null } = {
            current: null,
        };
        return {
            dbRef,
            dbProxy: new Proxy(
                {},
                {
                    get: (_target, property) => {
                        const current = dbRef.current;
                        if (!current)
                            throw new Error("test database not initialized");
                        const value = current[property];
                        return typeof value === "function"
                            ? value.bind(current)
                            : value;
                    },
                },
            ),
            chat: vi.fn(),
            generateTitle: vi.fn(),
            actorId: { value: "invented-owner" },
            mockEnv: {
                IS_HOSTED: false,
                SELF_HOST_MODE: "shared",
                AUTHZ_MODE: "local",
                ORG_ACCOUNT_EMAIL: "invented-org@example.test",
                ORG_ACCOUNT_PASSWORD: "invented-password",
                ENCRYPTION_KEY:
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                BETTER_AUTH_SECRET: "invented-test-secret-invented-test-secret",
                AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 20,
            },
        };
    },
);

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn(),
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));
vi.mock("@/lib/learn/chat-clients", () => ({
    learnChatClients: async () => ({
        chat: { complete: chat },
        provider: "OpenAI",
        model: "invented-model",
        payerUserId: "invented-owner",
    }),
}));
vi.mock("@/lib/ai/generate-title", () => ({
    generateTitleFromTranscription: generateTitle,
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSessionActor: async () => ({
        session: { user: { id: actorId.value } },
        actor: localActor(actorId.value),
    }),
    requireApiSession: async () => ({ user: { id: actorId.value } }),
}));

import { GET as exportJson } from "@/app/api/export/route";
import {
    GET as getLanguage,
    PATCH as patchLanguage,
} from "@/app/api/recordings/[id]/language/route";
import { GET as getRecording } from "@/app/api/recordings/[id]/route";
import { POST as regenerateTitle } from "@/app/api/recordings/[id]/title/route";
import { encrypt } from "@/lib/encryption";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import { getRecordingMarkdownDocument } from "@/lib/export/document-sidecars";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { releaseAutoLearnHold } from "@/lib/learn/auto-learn";
import { learnJobHandler } from "@/lib/learn/learn-job-handler";
import { decideReviewItem, finishReview, loadReview } from "@/lib/learn/review";
import * as readableTranscripts from "@/lib/mcp/data/transcripts";
import { loadReadableTranscript } from "@/lib/mcp/data/transcripts";
import { TRANSCRIPT_TOOLS } from "@/lib/mcp/tools/transcripts";
import { ensureOrgAccount } from "@/lib/org/account";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { createProfile, setDefaultProfile } from "@/lib/profiles/store";
import { requireRecordingView } from "@/lib/sharing/access";
import { notifyIfShared } from "@/lib/sharing/notify";
import type { StorageProvider } from "@/lib/storage/types";
import { upsertTranscription } from "@/lib/transcription/persist";
import { getV1RecordingDetailForUser } from "@/lib/v1/serialize";
import { emitEvent } from "@/lib/webhooks/emit";

const databaseUrl = getTestDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const OWNER = "invented-owner";
const OTHER = "invented-other";
const REC = "invented-language-recording";
const text =
    "Dobrý den, dnes společně projdeme plán nového projektu a domluvíme další postup.";
const turns = [{ speaker: "speaker_0", startMs: 0, endMs: 26_000, text }];

suite("confirmed language with PostgreSQL", () => {
    let database: TestPostgresDatabase;
    let transcriptId: string;
    let orgId: string;
    const context = { params: Promise.resolve({ id: REC }) };
    const db = () => database.db;
    const request = (
        method = "GET",
        language?: string | null,
        view = "private",
    ) =>
        new Request(
            `http://localhost/api/recordings/${REC}/language?view=${view}`,
            {
                method,
                ...(language !== undefined
                    ? {
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ language }),
                      }
                    : {}),
            },
        );

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "confirmed_language",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    });
    beforeEach(async () => {
        vi.clearAllMocks();
        chat.mockReset();
        generateTitle.mockReset();
        actorId.value = OWNER;
        knowledgeStore().invalidateAll();
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "invented-owner@example.test" },
                { id: OTHER, email: "invented-other@example.test" },
            ]);
        orgId = (await ensureOrgAccount()) ?? "";
        await db()
            .insert(userSettings)
            .values({ userId: OWNER, correctAfterLearn: false });
        await seedExistingPersonalProfiles(OWNER, mockEnv);
        await db()
            .insert(apiCredentials)
            .values({
                userId: OWNER,
                provider: "OpenAI",
                apiKey: encrypt("invented-key"),
                defaultModel: "invented-model",
                isDefaultEnhancement: true,
            });
        await insertRecording(db(), {
            id: REC,
            userId: OWNER,
            title: "Invented project plan",
        });
        const [row] = await db()
            .insert(transcriptions)
            .values({
                userId: OWNER,
                recordingId: REC,
                text: encryptText(text),
                turns: encryptJsonField(turns),
                source: "riffado",
                provider: "elevenlabs",
                model: "scribe_v2",
                detectedLanguage: "hun",
            })
            .returning({ id: transcriptions.id });
        transcriptId = row.id;
    });

    async function learn(
        code: string,
        confidence: number,
        onAnswer?: () => Promise<void>,
    ) {
        await db()
            .update(chatterItems)
            .set({ summaryDueAt: new Date(Date.now() + 60_000) })
            .where(
                and(eq(chatterItems.id, REC), eq(chatterItems.userId, OWNER)),
            );
        const [run] = await db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: OWNER,
                itemId: REC,
                transcriptionId: transcriptId,
                actorUserId: OWNER,
                view: "private",
                trigger: "auto",
                transcriptRevision: 0,
                vocabularyVersion: 0,
            })
            .returning({ id: learnRuns.id });
        chat.mockResolvedValueOnce(
            JSON.stringify({ mentions: [] }),
        ).mockImplementationOnce(async () => {
            await onAnswer?.();
            return JSON.stringify({
                language: { code, confidence },
                newRecords: [],
                speakers: [],
                corrections: [],
                facts: [],
                relationPhrases: [],
            });
        });
        return learnJobHandler.run({
            payload: { runId: run.id },
            userId: OWNER,
            jobId: "invented-job",
            attempt: 1,
            maxAttempts: 1,
            signal: new AbortController().signal,
            reportProgress: () => {},
        });
    }

    it("holds a mismatch, stores the answer and releases after review", async () => {
        expect(await learn("cs", 0.96)).toMatchObject({
            status: "ready",
            items: 1,
        });
        expect(await releaseAutoLearnHold(REC)).toBe(false);
        const access = await requireRecordingView(OWNER, REC, "private");
        const review = await loadReview(access);
        expect(review.items).toMatchObject([
            {
                kind: "language",
                preTicked: true,
                payload: { language: "cs", detectedLanguage: "hu" },
            },
        ]);
        const finished = await finishReview(access, OWNER, {
            versions: Object.fromEntries(
                review.items.map((item) => [item.id, item.version]),
            ),
        });
        expect(finished).toMatchObject({
            status: "finished",
            applied: 1,
            correcting: false,
        });
        expect(
            (await db().select().from(recordings))[0]?.confirmedLanguage,
        ).toBe("cs");
        expect(
            (await db().select().from(chatterItems))[0]?.summaryDueAt,
        ).toBeNull();
    });

    it.each([
        ["hu", 0.99],
        ["cs", 0.89],
    ])("silently finishes %s at confidence %s", async (code, confidence) => {
        expect(await learn(String(code), Number(confidence))).toMatchObject({
            status: "finished",
            items: 0,
        });
        expect(await db().select().from(learnReviewItems)).toHaveLength(0);
        expect(
            (await db().select().from(recordings))[0]?.confirmedLanguage,
        ).toBeNull();
        expect(
            (await db().select().from(chatterItems))[0]?.summaryDueAt,
        ).toBeNull();
    });

    it.each([
        "hu",
        "sk",
    ])("stores the reviewed provider or alternate choice %s", async (language) => {
        await learn("cs", 1);
        const access = await requireRecordingView(OWNER, REC, "private");
        const review = await loadReview(access);
        const item = review.items[0];
        const draft = await decideReviewItem(access, item.id, {
            decision: "accepted",
            version: item.version,
            choice: { language },
        });
        await finishReview(access, OWNER, {
            versions: { [item.id]: draft.version },
        });
        expect(
            (await db().select().from(recordings))[0]?.confirmedLanguage,
        ).toBe(language);
    });

    it.each([
        null,
        { language: "hu" },
    ])("dismisses rejection without writing a language, even with choice %j", async (choice) => {
        await learn("cs", 0.97);
        const access = await requireRecordingView(OWNER, REC, "private");
        const item = (await loadReview(access)).items[0];
        const before = (await db().select().from(recordings))[0];
        const draft = await decideReviewItem(access, item.id, {
            decision: "rejected",
            version: item.version,
            choice,
        });
        const result = await finishReview(access, OWNER, {
            versions: { [item.id]: draft.version },
        });
        expect(result).toMatchObject({ applied: 0, dismissed: 1, skipped: [] });
        expect(result.confirmedLanguageChanged).toBeUndefined();
        expect((await db().select().from(recordings))[0]).toEqual(before);
        expect((await db().select().from(learnReviewItems))[0]?.outcome).toBe(
            "rejected",
        );
        expect(await db().select().from(learnDismissals)).toHaveLength(1);
        expect(emitEvent).not.toHaveBeenCalled();
        expect(notifyIfShared).not.toHaveBeenCalled();
        expect(await learn("cs", 0.97)).toMatchObject({
            status: "finished",
            items: 0,
        });
    });

    it("does not rewrite or notify when Learn applies the existing confirmation", async () => {
        await learn("cs", 1);
        await patchLanguage(request("PATCH", "cs"), context);
        const before = (await db().select().from(recordings))[0];
        vi.mocked(emitEvent).mockClear();
        vi.mocked(notifyIfShared).mockClear();
        const access = await requireRecordingView(OWNER, REC, "private");
        const review = await loadReview(access);
        const result = await finishReview(access, OWNER, {
            versions: Object.fromEntries(
                review.items.map((item) => [item.id, item.version]),
            ),
        });
        expect(result).toMatchObject({ applied: 1, dismissed: 0 });
        expect(result.confirmedLanguageChanged).toBeUndefined();
        expect((await db().select().from(recordings))[0]).toEqual(before);
        expect(emitEvent).not.toHaveBeenCalled();
        expect(notifyIfShared).not.toHaveBeenCalled();
    });

    it("counts only published items after confirmation during Learn", async () => {
        expect(
            await learn("cs", 1, async () => {
                await patchLanguage(request("PATCH", "sk"), context);
            }),
        ).toMatchObject({ status: "finished", items: 0 });
        expect((await db().select().from(learnRuns))[0]?.stats).toMatchObject({
            items: 0,
        });
        expect(
            (await db().select().from(learnRuns))[0]?.stats,
        ).not.toHaveProperty("items_language");
        expect(await db().select().from(learnReviewItems)).toHaveLength(0);
    });

    it.each([
        null,
        "cs",
    ])("treats unchanged %s as a no-op, and can clear back to auto", async (language) => {
        if (language) await patchLanguage(request("PATCH", language), context);
        const before = (await db().select().from(recordings))[0];
        vi.mocked(emitEvent).mockClear();
        vi.mocked(notifyIfShared).mockClear();
        expect(
            (await patchLanguage(request("PATCH", language), context)).status,
        ).toBe(200);
        expect((await db().select().from(recordings))[0]).toEqual(before);
        expect(emitEvent).not.toHaveBeenCalled();
        expect(notifyIfShared).not.toHaveBeenCalled();
        if (language) {
            expect(
                await (
                    await patchLanguage(request("PATCH", null), context)
                ).json(),
            ).toMatchObject({ confirmedLanguage: null });
            expect(
                (await db().select().from(recordings))[0]?.confirmedLanguage,
            ).toBeNull();
            expect(emitEvent).toHaveBeenCalledOnce();
            expect(notifyIfShared).toHaveBeenCalledOnce();
        }
    });

    it("keeps the MCP language field as provider detection", async () => {
        await patchLanguage(request("PATCH", "cs"), context);
        const tool = TRANSCRIPT_TOOLS.find(
            (tool) => tool.name === "get_transcript",
        );
        if (!tool) throw new Error("Missing transcript tool");
        expect(
            await tool.run(
                {
                    caller: userCaller(
                        OWNER,
                        "invented-owner@example.test",
                        ["transcripts:read"],
                        orgId,
                    ),
                    touched: [],
                },
                { recording: REC },
            ),
        ).toMatchObject({
            language: "hun",
            confirmed_language: "cs",
            detected_language: "hun",
        });
    });

    it.each([
        null,
        "cs",
    ])("passes confirmed language %s through the scan without per-row metadata queries", async (language) => {
        if (language) await patchLanguage(request("PATCH", language), context);
        const caller = userCaller(
            OWNER,
            "invented-owner@example.test",
            ["transcripts:read"],
            orgId,
        );
        const search = TRANSCRIPT_TOOLS.find(
            (tool) => tool.name === "search_transcripts",
        );
        if (!search) throw new Error("Missing transcript search tool");
        const select = vi.spyOn(db(), "select");
        const load = vi.spyOn(readableTranscripts, "loadReadableTranscript");
        try {
            expect(
                await search.run({ caller, touched: [] }, { query: "dnes" }),
            ).toMatchObject({
                results: [{ recording: { id: REC } }],
                scanned: 1,
                complete: true,
            });
            expect(load).toHaveBeenCalledWith(
                caller,
                expect.objectContaining({
                    id: REC,
                    confirmedLanguage: language,
                }),
                expect.anything(),
            );
            expect(await load.mock.results[0]?.value).toMatchObject({
                confirmedLanguage: language,
                detectedLanguage: "hun",
            });
            expect(
                select.mock.calls.filter(
                    ([fields]) =>
                        fields &&
                        Object.keys(fields).length === 1 &&
                        "confirmedLanguage" in fields,
                ),
            ).toHaveLength(0);
        } finally {
            select.mockRestore();
            load.mockRestore();
        }
        const get = TRANSCRIPT_TOOLS.find(
            (tool) => tool.name === "get_transcript",
        );
        if (!get) throw new Error("Missing transcript tool");
        expect(
            await get.run({ caller, touched: [] }, { recording: REC }),
        ).toMatchObject({
            confirmed_language: language,
            detected_language: "hun",
        });
    });

    it.each([
        "summary",
        "title",
    ])("compares %s against the explicit profile output language", async (kind) => {
        const settings = defaultProfileSettings("audio");
        settings.steps.summary.outputLanguage = "en";
        const actor = localActor(OWNER);
        const profile = await createProfile({
            ownerUserId: OWNER,
            actor,
            scope: "personal",
            channel: "audio",
            name: "Invented English profile",
            settings,
        });
        await setDefaultProfile({
            ownerUserId: OWNER,
            actor,
            profileId: profile.id,
        });
        await db()
            .update(chatterItems)
            .set({
                title: encryptText(
                    "The team agreed to review the project plan and prepare the next meeting.",
                ),
                titleEditedAt: kind === "summary" ? new Date() : null,
            })
            .where(
                and(eq(chatterItems.id, REC), eq(chatterItems.userId, OWNER)),
            );
        if (kind === "summary")
            await db()
                .insert(aiEnhancements)
                .values({
                    userId: OWNER,
                    itemId: REC,
                    transcriptionId: transcriptId,
                    source: "riffado",
                    provider: "invented-provider",
                    model: "invented-model",
                    summary: encryptText(
                        "The team agreed to review the project plan and prepare the next meeting.",
                    ),
                    outputLanguage: "en",
                });
        expect(
            await (await patchLanguage(request("PATCH", "cs"), context)).json(),
        ).toMatchObject({
            confirmedLanguage: "cs",
            needsResummary: false,
            needsTitleRegeneration: false,
        });
        if (kind === "summary")
            await db()
                .update(aiEnhancements)
                .set({ outputLanguage: "hu" })
                .where(eq(aiEnhancements.userId, OWNER));
        else
            await db()
                .update(chatterItems)
                .set({ title: encryptText(text) })
                .where(
                    and(
                        eq(chatterItems.id, REC),
                        eq(chatterItems.userId, OWNER),
                    ),
                );
        expect(
            await (await getLanguage(request(), context)).json(),
        ).toMatchObject({
            needsResummary: kind === "summary",
            needsTitleRegeneration: kind === "title",
        });
        if (kind === "title") {
            await db()
                .insert(itemProcessing)
                .values({
                    itemId: REC,
                    userId: OWNER,
                    view: "private",
                    phases: {
                        summary: {
                            state: "done",
                            generation: 1,
                            at: new Date().toISOString(),
                            steps: {
                                title: {
                                    state: "done",
                                    generation: 1,
                                    contentId: transcriptId,
                                    contentRevision: 0,
                                },
                            },
                        },
                    },
                });
            const title =
                "The team agreed to review the project plan and prepare the next meeting.";
            generateTitle.mockResolvedValueOnce(title);
            const response = await regenerateTitle(
                new Request(`http://localhost/api/recordings/${REC}/title`, {
                    method: "POST",
                }),
                context,
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ filename: title });
            expect(
                await (await getLanguage(request(), context)).json(),
            ).toMatchObject({
                needsResummary: false,
                needsTitleRegeneration: false,
            });
        }
    });

    it("offers title regeneration alone after confirming a different language", async () => {
        await db()
            .update(chatterItems)
            .set({
                title: encryptText(
                    "The team agreed to review the project plan and prepare the next meeting.",
                ),
            })
            .where(
                and(eq(chatterItems.id, REC), eq(chatterItems.userId, OWNER)),
            );
        expect(
            await (await patchLanguage(request("PATCH", "cs"), context)).json(),
        ).toMatchObject({
            confirmedLanguage: "cs",
            needsResummary: false,
            needsTitleRegeneration: true,
        });
        generateTitle.mockResolvedValueOnce(text);
        expect(
            (
                await regenerateTitle(
                    new Request(
                        `http://localhost/api/recordings/${REC}/title`,
                        { method: "POST" },
                    ),
                    context,
                )
            ).status,
        ).toBe(200);
        expect(
            await (await getLanguage(request(), context)).json(),
        ).toMatchObject({
            needsResummary: false,
            needsTitleRegeneration: false,
        });
    });

    it("never flags a title the user typed in another language", async () => {
        await db()
            .update(chatterItems)
            .set({
                title: encryptText(
                    "The team agreed to review the project plan and prepare the next meeting.",
                ),
                titleEditedAt: new Date(),
            })
            .where(
                and(eq(chatterItems.id, REC), eq(chatterItems.userId, OWNER)),
            );
        expect(
            await (await patchLanguage(request("PATCH", "cs"), context)).json(),
        ).toMatchObject({
            confirmedLanguage: "cs",
            needsResummary: false,
            needsTitleRegeneration: false,
        });
    });

    it("exposes one language in private and Organization views and survives re-transcription", async () => {
        expect(
            (await patchLanguage(request("PATCH", "cs"), context)).status,
        ).toBe(200);
        await upsertTranscription({
            userId: OWNER,
            recordingId: REC,
            text,
            detectedLanguage: "hun",
            source: "riffado",
            provider: "elevenlabs",
            model: "scribe_v2",
            turns,
        });
        await shareRecording(db(), REC, orgId);
        actorId.value = orgId;
        expect(
            await (
                await getLanguage(request("GET", undefined, "org"), context)
            ).json(),
        ).toMatchObject({ confirmedLanguage: "cs", canChange: true });
        const caller = userCaller(
            OWNER,
            "invented-owner@example.test",
            ["transcripts:read"],
            orgId,
        );
        expect(
            await loadReadableTranscript(caller, {
                id: REC,
                ownerUserId: OWNER,
                view: "private",
            }),
        ).toMatchObject({
            language: "hun",
            confirmedLanguage: "cs",
            detectedLanguage: "hun",
        });
        expect(
            await loadReadableTranscript(caller, {
                id: REC,
                ownerUserId: OWNER,
                view: "org",
            }),
        ).toMatchObject({ language: "hun", confirmedLanguage: "cs" });
        expect(await getV1RecordingDetailForUser(OWNER, REC)).toMatchObject({
            confirmed_language: "cs",
        });
        actorId.value = OWNER;
        expect(
            await (
                await getRecording(
                    new Request(`http://localhost/api/recordings/${REC}`),
                    context,
                )
            ).json(),
        ).toMatchObject({ recording: { confirmedLanguage: "cs" } });
    });

    it("offers manual regeneration for an existing summary and queues no AI work", async () => {
        await db()
            .insert(aiEnhancements)
            .values({
                userId: OWNER,
                itemId: REC,
                transcriptionId: transcriptId,
                source: "riffado",
                provider: "invented-provider",
                model: "invented-model",
                summary: encryptText(
                    "The team agreed to review the project plan and prepare the next meeting.",
                ),
                outputLanguage: "en",
                inputFingerprint: "invented-original-input",
            });
        await db()
            .update(chatterItems)
            .set({ titleEditedAt: new Date() })
            .where(
                and(eq(chatterItems.id, REC), eq(chatterItems.userId, OWNER)),
            );
        const before = await db().select().from(asyncJobs);
        const changed = await patchLanguage(request("PATCH", "cs"), context);
        expect(await changed.json()).toMatchObject({
            confirmedLanguage: "cs",
            needsResummary: true,
            needsTitleRegeneration: false,
        });
        expect(await db().select().from(asyncJobs)).toHaveLength(before.length);
        expect((await db().select().from(aiEnhancements))[0]).toMatchObject({
            outputLanguage: "en",
            inputFingerprint: "invented-original-input",
        });
        await db()
            .update(aiEnhancements)
            .set({ outputLanguage: "cs" })
            .where(
                and(
                    eq(aiEnhancements.itemId, REC),
                    eq(aiEnhancements.userId, OWNER),
                ),
            );
        expect(
            await (await getLanguage(request(), context)).json(),
        ).toMatchObject({
            needsResummary: false,
            needsTitleRegeneration: false,
        });
    });

    it("keeps language controls usable while the Organization waits for a profile", async () => {
        await shareRecording(db(), REC, orgId);
        actorId.value = orgId;
        await getLanguage(request("GET", undefined, "org"), context);
        await db()
            .update(processingProfiles)
            .set({ isDefault: false })
            .where(eq(processingProfiles.ownerUserId, orgId));
        expect(
            await (
                await getLanguage(request("GET", undefined, "org"), context)
            ).json(),
        ).toMatchObject({ canChange: true, needsResummary: false });
        expect(
            await (
                await patchLanguage(request("PATCH", "cs", "org"), context)
            ).json(),
        ).toMatchObject({ confirmedLanguage: "cs", needsResummary: false });
        expect(
            await (
                await patchLanguage(request("PATCH", null, "org"), context)
            ).json(),
        ).toMatchObject({ confirmedLanguage: null, needsResummary: false });
    });

    it("refuses another tenant, unsupported languages, and mail", async () => {
        actorId.value = OTHER;
        expect(
            (await patchLanguage(request("PATCH", "cs"), context)).status,
        ).toBe(404);
        actorId.value = OWNER;
        expect(
            (await patchLanguage(request("PATCH", "auto"), context)).status,
        ).toBe(400);
        await db()
            .insert(chatterItems)
            .values({
                id: "invented-mail",
                userId: OWNER,
                kind: "mail",
                title: encryptText("Invented mail"),
                occurredAt: new Date(),
            });
        expect(
            (
                await patchLanguage(request("PATCH", "cs"), {
                    params: Promise.resolve({ id: "invented-mail" }),
                })
            ).status,
        ).toBe(404);
    });

    it("exports confirmed metadata and restores it onto a recording without changing detection", async () => {
        await patchLanguage(request("PATCH", "cs"), context);
        const before = await db().select().from(asyncJobs);
        const exported = await (
            await exportJson(
                new Request("http://localhost/api/export?format=json"),
            )
        ).json();
        expect(exported[0]).toMatchObject({
            confirmedLanguage: "cs",
            transcriptions: [{ detectedLanguage: "hun" }],
        });
        const document = await getRecordingMarkdownDocument(
            OWNER,
            REC,
            "transcript",
        );
        expect(document?.content).toContain('\nlanguage: "hun"\n');
        expect(document?.content).toContain('confirmed_language: "cs"');
        let archive = Buffer.alloc(0);
        const storage: StorageProvider = {
            uploadFile: vi.fn(),
            downloadFile: vi.fn(),
            downloadStream: vi.fn(),
            deleteFile: vi.fn(),
            getSignedUrl: vi.fn(),
            exists: async () => false,
            testConnection: async () => true,
            uploadStream: async (_key: string, stream: Readable) => {
                const chunks: Buffer[] = [];
                for await (const chunk of stream)
                    chunks.push(Buffer.from(chunk));
                archive = Buffer.concat(chunks);
                return "invented.zip";
            },
        };
        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: OWNER },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "invented.zip",
        });
        const zip = await unzipper.Open.buffer(archive);
        const manifest = JSON.parse(
            (
                await zip.files
                    .find((file) => file.path === "manifest.json")
                    ?.buffer()
            )?.toString() ?? "{}",
        );
        expect(manifest.recordings[0].confirmedLanguage).toBe("cs");
        const [original] = await db()
            .select()
            .from(recordings)
            .where(eq(recordings.id, REC));
        await insertRecordings(db(), {
            ...original,
            id: "invented-restored",
            plaudFileId: "invented-restored",
            filename: encryptText("Restored recording"),
            startTime: new Date(),
            confirmedLanguage: manifest.recordings[0].confirmedLanguage,
        });
        expect(
            (
                await db()
                    .select()
                    .from(recordings)
                    .where(eq(recordings.id, "invented-restored"))
            )[0]?.confirmedLanguage,
        ).toBe("cs");
        expect(await db().select().from(asyncJobs)).toHaveLength(before.length);
    });
});
