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
    knowledgeAliases,
    knowledgeEntities,
    learnReviewItems,
    learnRuns,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { teachHeardAsInTx } from "@/lib/knowledge/aliases";
import { listCorrections } from "@/lib/knowledge/corrections";
import {
    knowledgeStore,
    knowledgeView,
} from "@/lib/knowledge/knowledge-loader";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { correctionPassJobHandler } from "@/lib/learn/correction-pass-job";
import { LEARN_CORRECT_JOB_KIND } from "@/lib/learn/correction-pass-queue";
import { decideReviewItem, finishReview } from "@/lib/learn/review";
import type { LearnChat } from "@/lib/learn/run-fallback";
import { ensureOrgAccount } from "@/lib/org/account";
import { requireRecordingView } from "@/lib/sharing/access";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, complete } = vi.hoisted(() => {
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
                        throw new Error("Test database not initialized");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        complete: vi.fn<LearnChat["complete"]>(),
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ORG_ACCOUNT_PASSWORD: "organization-password",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
        DATABASE_URL: "postgres://unused",
        KNOWLEDGE_MEMORY_MB: 64,
    },
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/learn/summary-refresh", () => ({
    refreshSummaryAfterCorrections: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/learn/chat-clients", () => ({
    learnChatClients: async () => ({
        chat: { complete },
        bridge: { complete: vi.fn() },
        provider: "fixture",
        baseUrl: null,
        model: "fixture",
        payerUserId: "recall-owner",
    }),
}));

const OWNER = "recall-owner";
const REC = "recall-recording";
const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 5000,
        text: "Klient CHVEX používá Veloru. Složku nazvi CHVEX.",
    },
    {
        speaker: "speaker_0",
        startMs: 5000,
        endMs: 10000,
        text: "S CHVEXem to projde Jitka Dvořáková.",
    },
];
const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("Learn renamed new records (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let transcriptionId = "";

    function db() {
        if (!database) throw new Error("Test database not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "learn_recall_rename",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        complete.mockReset();
        knowledgeStore().invalidateAll();
        await db().delete(asyncJobs);
        await db().delete(users);
        await db()
            .insert(users)
            .values({ id: OWNER, email: "owner@example.test" });
        await ensureOrgAccount();
        await seedCoreVocabulary();
        await insertRecordings(db(), {
            id: REC,
            userId: OWNER,
            deviceSn: "fixture-sn",
            plaudFileId: "fixture-file",
            filename: encryptText("Klient"),
            duration: 10000,
            startTime: new Date("2026-10-01T10:00:00Z"),
            endTime: new Date("2026-10-01T10:00:10Z"),
            filesize: 1,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/rec.mp3`,
            plaudVersion: "1",
        });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                userId: OWNER,
                recordingId: REC,
                source: "riffado",
                provider: "fixture-stt",
                model: "fixture-stt-model",
                detectedLanguage: "ces",
                text: encryptText(TURNS.map((t) => t.text).join("\n")),
                turns: encryptJsonField(TURNS),
            })
            .returning({ id: transcriptions.id });
        transcriptionId = transcript?.id ?? "";
        await db().insert(transcriptSpeakers).values({
            userId: OWNER,
            transcriptionId,
            label: "speaker_0",
            source: "user",
            status: "confirmed",
            markedUnknown: true,
            confirmedByUserId: OWNER,
        });
    });

    async function proposal(name = "CHVEX") {
        const [run] = await db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: OWNER,
                actorUserId: OWNER,
                itemId: REC,
                transcriptionId,
                transcriptRevision: 0,
                vocabularyVersion: 0,
                view: "private",
                trigger: "manual",
                status: "ready",
            })
            .returning({ id: learnRuns.id });
        const [item] = await db()
            .insert(learnReviewItems)
            .values({
                runId: run?.id ?? "",
                userId: OWNER,
                kind: "new_record",
                preTicked: false,
                fingerprintHmac: "fixture-fingerprint",
                payload: encryptJsonField({
                    ref: "n1",
                    kind: "entity",
                    typeKey: "organization",
                    name,
                    evidenceMs: [0],
                    reason: "Klient.",
                }),
            })
            .returning({ id: learnReviewItems.id });
        return item?.id ?? "";
    }

    async function accept(name: string) {
        const itemId = await proposal();
        const access = await requireRecordingView(OWNER, REC, "private");
        const draft = await decideReviewItem(access, itemId, {
            version: 0,
            decision: "accepted",
            choice: { name, typeKey: "organization" },
        });
        const finished = await finishReview(access, OWNER, {
            versions: { [itemId]: draft.version },
        });
        return finished;
    }

    it("teaches the original spelling before the queued correction pass reads the Almanac", async () => {
        expect(await accept("ČVEX")).toMatchObject({
            applied: 1,
            skipped: [],
            correcting: true,
        });
        const [entity] = await db()
            .select()
            .from(knowledgeEntities)
            .where(eq(knowledgeEntities.userId, OWNER));
        expect(entity).toBeDefined();
        expect(decryptText(entity?.name ?? "")).toBe("ČVEX");
        expect(entity?.name).not.toBe("ČVEX");
        const [alias] = await db()
            .select()
            .from(knowledgeAliases)
            .where(eq(knowledgeAliases.userId, OWNER));
        expect(alias).toMatchObject({
            kind: "heard_as",
            entityId: entity?.id,
            language: "ces",
            provider: "fixture-stt",
            correctionId: expect.any(String),
            createdByUserId: OWNER,
        });
        expect(decryptText(alias?.text ?? "")).toBe("CHVEX");
        expect(alias?.text).not.toBe("CHVEX");
        const view = await knowledgeView({
            kind: "recording",
            ownerUserId: OWNER,
            shared: false,
        });
        expect(
            view.items.find((item) => item.id === entity?.id)?.names,
        ).toContainEqual(
            expect.objectContaining({ kind: "heard_as", text: "CHVEX" }),
        );
        expect(await listCorrections(OWNER, transcriptionId)).toHaveLength(3);
        const [job] = await db()
            .select()
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.userId, OWNER),
                    eq(asyncJobs.kind, LEARN_CORRECT_JOB_KIND),
                ),
            );
        complete.mockImplementationOnce(async (messages) => {
            const prompt = messages
                .map((message) => message.content)
                .join("\n");
            expect(prompt).toContain('"heardAs":["CHVEX"]');
            expect(prompt).toContain('"name":"ČVEX"');
            return JSON.stringify({
                fixes: [
                    {
                        turn: 0,
                        heard: "CHVEX",
                        replacement: "ČVEX",
                        context: "",
                        target: { entityId: entity?.id },
                    },
                    {
                        turn: 1,
                        heard: "CHVEXem",
                        replacement: "ČVEXem",
                        context: "",
                        target: { entityId: entity?.id },
                    },
                ],
            });
        });
        const result = await correctionPassJobHandler.run({
            payload: { passId: (job?.payload as { passId: string }).passId },
            userId: OWNER,
            jobId: job?.id ?? "",
            attempt: 1,
            maxAttempts: 2,
            signal: new AbortController().signal,
            reportProgress: () => {},
        });
        expect(result).toMatchObject({ status: "finished", written: 0 });
        const corrections = await listCorrections(OWNER, transcriptionId);
        expect(
            corrections.map((c) => [c.heard, c.replacement, c.targetEntityId]),
        ).toEqual([
            ["CHVEX", "ČVEX", entity?.id],
            ["CHVEX", "ČVEX", entity?.id],
            ["CHVEXem", "ČVEXem", entity?.id],
        ]);
        expect(
            await db()
                .select()
                .from(knowledgeAliases)
                .where(eq(knowledgeAliases.userId, OWNER)),
        ).toHaveLength(1);
    });

    it("does not save an inflection already covered by the heard-as stem, while preserving provider boundaries", async () => {
        await accept("ČVEX");
        const [entity] = await db()
            .select()
            .from(knowledgeEntities)
            .where(eq(knowledgeEntities.userId, OWNER));
        const teach = (heard: string, provider: string) =>
            db().transaction(async (tx) =>
                teachHeardAsInTx(tx, {
                    scopeUserId: OWNER,
                    target: { entityId: entity?.id ?? "" },
                    heard,
                    language: "ces",
                    provider,
                    correctionId:
                        (await listCorrections(OWNER, transcriptionId))[0]
                            ?.id ?? "",
                }),
            );
        await teach("CHVEXem", "fixture-stt");
        let aliases = await db()
            .select()
            .from(knowledgeAliases)
            .where(eq(knowledgeAliases.userId, OWNER));
        expect(aliases.map((row) => decryptText(row.text))).toEqual(["CHVEX"]);
        await teach("CHVEXem", "other-stt");
        aliases = await db()
            .select()
            .from(knowledgeAliases)
            .where(eq(knowledgeAliases.userId, OWNER));
        expect(aliases).toHaveLength(2);
    });

    it("rebases an accepted model correction to the reviewer's edited name and reports it applied", async () => {
        const itemId = await proposal("ČVEX");
        const [item] = await db()
            .select()
            .from(learnReviewItems)
            .where(
                and(
                    eq(learnReviewItems.id, itemId),
                    eq(learnReviewItems.userId, OWNER),
                ),
            );
        const [correction] = await db()
            .insert(learnReviewItems)
            .values({
                runId: item?.runId ?? "",
                userId: OWNER,
                kind: "correction",
                preTicked: false,
                decision: "accepted",
                fingerprintHmac: "fixture-correction",
                payload: encryptJsonField({
                    kind: "correct",
                    heard: "CHVEX",
                    replacement: "ČVEX",
                    target: { newRef: "n1" },
                    anchors: [{ turnIndex: 0, charStart: 7, charEnd: 12 }],
                }),
            })
            .returning({ id: learnReviewItems.id });
        const access = await requireRecordingView(OWNER, REC, "private");
        await decideReviewItem(access, itemId, {
            version: 0,
            decision: "accepted",
            choice: { name: "ČVIX", typeKey: "organization" },
        });
        expect(
            await finishReview(access, OWNER, {
                versions: { [itemId]: 1, [correction?.id ?? ""]: 0 },
            }),
        ).toMatchObject({ applied: 2, skipped: [] });
        const corrections = await listCorrections(OWNER, transcriptionId);
        expect(corrections.map((row) => row.replacement)).toEqual(["ČVIX"]);
        const [alias] = await db()
            .select()
            .from(knowledgeAliases)
            .where(eq(knowledgeAliases.userId, OWNER));
        expect(decryptText(alias?.text ?? "")).toBe("CHVEX");
        const [saved] = await db()
            .select()
            .from(learnReviewItems)
            .where(
                and(
                    eq(learnReviewItems.id, correction?.id ?? ""),
                    eq(learnReviewItems.userId, OWNER),
                ),
            );
        expect(saved?.outcome).toBe("applied");
    });

    it("teaches nothing for a rejected proposal or a name accepted without a rename", async () => {
        const itemId = await proposal();
        const access = await requireRecordingView(OWNER, REC, "private");
        await finishReview(access, OWNER, { versions: { [itemId]: 0 } });
        expect(
            await db()
                .select()
                .from(knowledgeEntities)
                .where(eq(knowledgeEntities.userId, OWNER)),
        ).toEqual([]);
        expect(
            await db()
                .select()
                .from(knowledgeAliases)
                .where(eq(knowledgeAliases.userId, OWNER)),
        ).toEqual([]);
        await accept("CHVEX");
        expect(
            await db()
                .select()
                .from(knowledgeAliases)
                .where(eq(knowledgeAliases.userId, OWNER)),
        ).toEqual([]);
    });

    it.each([
        "CHVEX",
        "ČVEX",
    ])("preserves declined occurrences while renaming other occurrences of %s", async (proposedName) => {
        const itemId = await proposal(proposedName);
        const [item] = await db()
            .select()
            .from(learnReviewItems)
            .where(
                and(
                    eq(learnReviewItems.id, itemId),
                    eq(learnReviewItems.userId, OWNER),
                ),
            );
        const lastStart = TURNS[0]?.text.lastIndexOf("CHVEX") ?? -1;
        const corrections = await db()
            .insert(learnReviewItems)
            .values(
                [
                    {
                        decision: null,
                        heard: "Klient CHVEX",
                        replacement: "Klient ČVEX",
                        anchor: { turnIndex: 0, charStart: 0, charEnd: 12 },
                    },
                    {
                        decision: "rejected" as const,
                        heard: "CHVEXem",
                        replacement: "ČVEXem",
                        anchor: { turnIndex: 1, charStart: 2, charEnd: 9 },
                    },
                    {
                        decision: "accepted" as const,
                        heard: "CHVEX",
                        replacement: "ČVEX",
                        anchor: {
                            turnIndex: 0,
                            charStart: lastStart,
                            charEnd: lastStart + 5,
                        },
                    },
                ].map((correction, index) => ({
                    runId: item?.runId ?? "",
                    userId: OWNER,
                    kind: "correction" as const,
                    preTicked: correction.decision === "rejected",
                    decision: correction.decision,
                    fingerprintHmac: `fixture-declined-${index}`,
                    payload: encryptJsonField({
                        kind: "correct",
                        heard: correction.heard,
                        replacement: correction.replacement,
                        target: { newRef: "n1" },
                        anchors: [correction.anchor],
                    }),
                })),
            )
            .returning({ id: learnReviewItems.id });
        const access = await requireRecordingView(OWNER, REC, "private");
        const editedName = proposedName === "CHVEX" ? "ČVEX" : "ŠVEX";
        await decideReviewItem(access, itemId, {
            version: 0,
            decision: "accepted",
            choice: { name: editedName, typeKey: "organization" },
        });
        const finished = await finishReview(access, OWNER, {
            versions: {
                [itemId]: 1,
                ...Object.fromEntries(corrections.map((row) => [row.id, 0])),
            },
        });
        expect(finished).toMatchObject({
            status: "finished",
            applied: 2,
            dismissed: 2,
            skipped: [],
        });
        expect(await listCorrections(OWNER, transcriptionId)).toEqual([
            expect.objectContaining({
                turnIndex: 0,
                charStart: lastStart,
                charEnd: lastStart + 5,
                heard: "CHVEX",
                replacement: editedName,
            }),
        ]);
        const outcomes = await db()
            .select({
                id: learnReviewItems.id,
                outcome: learnReviewItems.outcome,
            })
            .from(learnReviewItems)
            .where(
                and(
                    eq(learnReviewItems.runId, item?.runId ?? ""),
                    eq(learnReviewItems.userId, OWNER),
                ),
            );
        expect(outcomes).toEqual(
            expect.arrayContaining([
                { id: corrections[0]?.id, outcome: "rejected" },
                { id: corrections[1]?.id, outcome: "rejected" },
                { id: corrections[2]?.id, outcome: "applied" },
            ]),
        );
    });

    it.each([
        null,
        "rejected",
    ] as const)("skips accepted corrections referring to a new record with decision %s", async (decision) => {
        const itemId = await proposal();
        const [item] = await db()
            .select()
            .from(learnReviewItems)
            .where(
                and(
                    eq(learnReviewItems.id, itemId),
                    eq(learnReviewItems.userId, OWNER),
                ),
            );
        const [correction] = await db()
            .insert(learnReviewItems)
            .values({
                runId: item?.runId ?? "",
                userId: OWNER,
                kind: "correction",
                preTicked: true,
                fingerprintHmac: "fixture-unadded-correction",
                payload: encryptJsonField({
                    kind: "correct",
                    heard: "CHVEX",
                    replacement: "ČVEX",
                    target: { newRef: "n1" },
                    anchors: [{ turnIndex: 0, charStart: 7, charEnd: 12 }],
                }),
            })
            .returning({ id: learnReviewItems.id });
        const access = await requireRecordingView(OWNER, REC, "private");
        await decideReviewItem(access, itemId, {
            version: 0,
            decision,
            choice: { name: "ČVEX", typeKey: "organization" },
        });
        expect(
            await finishReview(access, OWNER, {
                versions: { [itemId]: 1, [correction?.id ?? ""]: 0 },
            }),
        ).toMatchObject({
            status: "finished",
            applied: 0,
            dismissed: 1,
            skipped: [{ itemId: correction?.id, code: "record_not_added" }],
        });
        expect(await listCorrections(OWNER, transcriptionId)).toEqual([]);
        expect(
            await db()
                .select()
                .from(knowledgeEntities)
                .where(eq(knowledgeEntities.userId, OWNER)),
        ).toEqual([]);
        expect(
            await db()
                .select()
                .from(knowledgeAliases)
                .where(eq(knowledgeAliases.userId, OWNER)),
        ).toEqual([]);
    });

    it.each([
        "CHVEX",
        "C\u030cVEX",
    ])("finishes when the edited name equals the correction's heard spelling %s after NFC normalization", async (heard) => {
        const turns = [{ ...TURNS[0], text: `Klient ${heard}.` }];
        await db()
            .update(transcriptions)
            .set({
                text: encryptText(turns[0]?.text ?? ""),
                turns: encryptJsonField(turns),
            })
            .where(
                and(
                    eq(transcriptions.id, transcriptionId),
                    eq(transcriptions.userId, OWNER),
                ),
            );
        const itemId = await proposal("ČVIX");
        const [item] = await db()
            .select()
            .from(learnReviewItems)
            .where(
                and(
                    eq(learnReviewItems.id, itemId),
                    eq(learnReviewItems.userId, OWNER),
                ),
            );
        const [correction] = await db()
            .insert(learnReviewItems)
            .values({
                runId: item?.runId ?? "",
                userId: OWNER,
                kind: "correction",
                preTicked: true,
                fingerprintHmac: "fixture-unchanged-correction",
                payload: encryptJsonField({
                    kind: "correct",
                    heard,
                    replacement: "ČVIX",
                    target: { newRef: "n1" },
                    anchors: [
                        {
                            turnIndex: 0,
                            charStart: 7,
                            charEnd: 7 + heard.length,
                        },
                    ],
                }),
            })
            .returning({ id: learnReviewItems.id });
        const access = await requireRecordingView(OWNER, REC, "private");
        await decideReviewItem(access, itemId, {
            version: 0,
            decision: "accepted",
            choice: { name: heard.normalize("NFC"), typeKey: "organization" },
        });
        expect(
            await finishReview(access, OWNER, {
                versions: { [itemId]: 1, [correction?.id ?? ""]: 0 },
            }),
        ).toMatchObject({ status: "finished", applied: 1 });
        expect(await listCorrections(OWNER, transcriptionId)).toEqual([]);
        const [entity] = await db()
            .select()
            .from(knowledgeEntities)
            .where(eq(knowledgeEntities.userId, OWNER));
        expect(decryptText(entity?.name ?? "")).toBe(heard.normalize("NFC"));
        expect(
            await db()
                .select()
                .from(knowledgeAliases)
                .where(eq(knowledgeAliases.userId, OWNER)),
        ).toEqual([]);
    });

    it("does not teach a person's first name alone as a global mishearing", async () => {
        const itemId = await proposal("Jitka");
        await db()
            .update(learnReviewItems)
            .set({
                payload: encryptJsonField({
                    ref: "n1",
                    kind: "person",
                    typeKey: null,
                    name: "Jitka",
                    evidenceMs: [5000],
                    reason: "Mluví o ní.",
                }),
            })
            .where(
                and(
                    eq(learnReviewItems.id, itemId),
                    eq(learnReviewItems.userId, OWNER),
                ),
            );
        const access = await requireRecordingView(OWNER, REC, "private");
        await decideReviewItem(access, itemId, {
            decision: "accepted",
            version: 0,
            choice: { name: "Jitka Dvořáková", typeKey: null },
        });
        expect(
            await finishReview(access, OWNER, { versions: { [itemId]: 1 } }),
        ).toMatchObject({ applied: 1, skipped: [] });
        expect(await listCorrections(OWNER, transcriptionId)).toEqual([]);
        expect(
            await db()
                .select()
                .from(knowledgeAliases)
                .where(eq(knowledgeAliases.userId, OWNER)),
        ).toEqual([]);
    });
});
