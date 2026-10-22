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
    learnReviewItems,
    learnRuns,
    people,
    recordingFolders,
    transcriptCorrectionPasses,
    transcriptions,
    transcriptSpeakerRejections,
    transcriptSpeakers,
    userSettings,
    users,
} from "@/db/schema";
import type { LearnChatMessage } from "@/lib/learn/run-fallback";
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
        db: new Proxy(
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
        env: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "organization@example.test",
            ORG_ACCOUNT_PASSWORD: "test-password",
            ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 100,
        },
        connection: vi.fn(),
        token: vi.fn().mockResolvedValue("test-token"),
        chat: vi.fn(),
        learnAccess: vi.fn(),
    };
});
vi.mock("@/db", () => ({ db: mocks.db, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/sharing/learn-access", () => ({
    requireLearnAccess: mocks.learnAccess,
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: mocks.connection,
    getGoogleAccessToken: mocks.token,
    invalidateGoogleAccessToken: vi.fn(),
}));
vi.mock("@/lib/learn/chat-clients", () => ({
    learnChatClients: vi.fn(async () => ({
        chat: { complete: mocks.chat },
        bridge: { complete: vi.fn() },
        provider: "OpenAI",
        model: "test-model",
        baseUrl: null,
        payerUserId: "owner",
    })),
}));

import { POST } from "@/app/api/recordings/[id]/learn/route";
import { encrypt } from "@/lib/encryption";
import {
    decryptJsonField,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { addRecordingToFolder } from "@/lib/folders/folders";
import type { CalendarEventCandidate } from "@/lib/integrations/google/calendar-events";
import {
    resolveMeetingRoster,
    selectMeetingEvent,
} from "@/lib/integrations/google/meeting-roster";
import {
    buildNameResolver,
    getTranscriptSpeakers,
} from "@/lib/knowledge/attribution";
import { confirmManualFact } from "@/lib/knowledge/facts";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { createPerson } from "@/lib/knowledge/people";
import { changeTranscriptSpeaker } from "@/lib/knowledge/speaker-changes";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { startAutomaticLearn } from "@/lib/learn/auto-learn";
import { correctionPassJobHandler } from "@/lib/learn/correction-pass-job";
import { startLearnRun } from "@/lib/learn/learn-job";
import { learnJobHandler } from "@/lib/learn/learn-job-handler";
import { llmRendering } from "@/lib/learn/llm-input";
import { decideReviewItem, finishReview, loadReview } from "@/lib/learn/review";
import { withSpeakerProposalContext } from "@/lib/learn/speaker-proposal-context";
import { ensureOrgAccount } from "@/lib/org/account";
import { requireRecordingView } from "@/lib/sharing/access";
import { insertRecordings } from "@/tests/integration/items";
import { seedExistingPersonalProfiles } from "@/tests/integration/profile-fixtures";

const calendarScope =
    "https://www.googleapis.com/auth/calendar.events.readonly";
const meetScope = "https://www.googleapis.com/auth/meetings.space.readonly";
const recordingDate = new Date().toISOString().slice(0, 10);
const start = new Date(`${recordingDate}T10:00:00Z`);
const end = new Date(`${recordingDate}T11:00:00Z`);
function event(id: string, from: string, to: string): CalendarEventCandidate {
    return {
        id,
        title: "Invented meeting",
        start: `${recordingDate}T${from}:00Z`,
        end: `${recordingDate}T${to}:00Z`,
        attendees: [{ name: "Nera Veln" }],
    };
}
const calendarEvent = event("meeting", "10:00", "11:00");
function googleFetch(events = [calendarEvent], fail = false) {
    return vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (fail) return new Response("failed", { status: 503 });
        if (url.pathname.endsWith("/events")) {
            return Response.json({
                items: events.map((one) => ({
                    ...one,
                    hangoutLink: "https://meet.google.com/abc-defg-hij",
                    start: { dateTime: one.start },
                    end: { dateTime: one.end },
                    attendees: one.attendees.map(({ name }) => ({
                        displayName: name,
                    })),
                })),
            });
        }
        if (url.pathname.endsWith("/events/meeting"))
            return Response.json({
                id: "meeting",
                start: { dateTime: calendarEvent.start },
                end: { dateTime: calendarEvent.end },
                hangoutLink: "https://meet.google.com/abc-defg-hij",
            });
        if (url.pathname.endsWith("/conferenceRecords"))
            return Response.json({
                conferenceRecords: [
                    {
                        name: "conferenceRecords/record",
                        startTime: start.toISOString(),
                        endTime: end.toISOString(),
                        expireTime: new Date(
                            end.getTime() + 29 * 24 * 60 * 60_000,
                        ).toISOString(),
                    },
                ],
            });
        if (url.pathname.endsWith("/participants"))
            return Response.json({
                participants: [
                    { signedinUser: { displayName: "néra veln" } },
                    { anonymousUser: { displayName: "Míra Luvin" } },
                ],
            });
        throw new Error(`Unexpected Google path: ${url.pathname}`);
    });
}

it("selects the greatest overlap, rejects close matches and honors an explicit choice", () => {
    const partial = event("partial", "09:00", "10:20");
    const close = event("close", "10:05", "11:00");
    expect(selectMeetingEvent([partial, calendarEvent], start, end)?.id).toBe(
        "meeting",
    );
    expect(selectMeetingEvent([calendarEvent, close], start, end)).toBeNull();
    expect(
        selectMeetingEvent([calendarEvent, close], start, end, "close")?.id,
    ).toBe("close");
    expect(selectMeetingEvent([partial], start, end)).toBeNull();
    expect(
        selectMeetingEvent([event("short", "10:10", "10:20")], start, end)?.id,
    ).toBe("short");
});

const url = getTestDatabaseUrl();
const databaseTests = url ? describe : describe.skip;
databaseTests("automatic Learn uses the owner's Calendar (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let transcriptId: string;
    let personId: string;
    let proposedName: string | null = null;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "calendar_speakers",
        );
        mocks.ref.current = database.db as unknown as Record<
            PropertyKey,
            unknown
        >;
    }, 120_000);
    afterAll(async () => {
        mocks.ref.current = null;
        await database?.dispose();
    }, 120_000);
    beforeEach(async () => {
        proposedName = null;
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        knowledgeStore().invalidateAll();
        await database.db.delete(users);
        await database.db.delete(asyncJobs);
        await database.db
            .insert(users)
            .values({ id: "owner", email: "owner@example.test" });
        await ensureOrgAccount();
        await database.db
            .insert(userSettings)
            .values({ userId: "owner", autoLearn: true });
        await seedExistingPersonalProfiles("owner", mocks.env);
        await seedCoreVocabulary();
        await database.db.insert(apiCredentials).values({
            userId: "owner",
            provider: "OpenAI",
            apiKey: encrypt("test-key"),
            defaultModel: "test-model",
            isDefaultEnhancement: true,
        });
        await insertRecordings(database.db, {
            id: "recording",
            userId: "owner",
            deviceSn: "invented-device",
            plaudFileId: "invented-file",
            filename: encryptText("Invented meeting"),
            duration: 3_600_000,
            startTime: start,
            endTime: end,
            filesize: 1,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: "owner/recording.mp3",
            plaudVersion: "1",
        });
        const [transcript] = await database.db
            .insert(transcriptions)
            .values({
                recordingId: "recording",
                userId: "owner",
                text: encryptText("Speaker 0: Byla jsem u návrhu."),
                turns: encryptJsonField([
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 5000,
                        text: "Byla jsem u návrhu.",
                    },
                ]),
                detectedLanguage: "cs",
                provider: "openai",
                source: "riffado",
                model: "test-model",
            })
            .returning({ id: transcriptions.id });
        transcriptId = transcript?.id ?? "";
        personId = (
            await createPerson({ userId: "owner", displayName: "Nera Veln" })
        ).id;
        mocks.connection.mockResolvedValue({
            status: "active",
            subject: "owner-google",
            scopes: [calendarScope],
        });
        mocks.token.mockResolvedValue("test-token");
        vi.stubGlobal("fetch", googleFetch());
        mocks.chat.mockImplementation(async (messages: LearnChatMessage[]) => {
            if (messages[0]?.content.includes("list the words"))
                return '{"mentions":[]}';
            return JSON.stringify({
                speakers: [
                    {
                        label: "speaker_0",
                        personId: proposedName ? null : personId,
                        ...(proposedName ? { rosterName: proposedName } : {}),
                        evidence: [],
                        reason: "Role odpovídá tématu.",
                        guess: {
                            confidence: 0.7,
                            clues: ["calendar", "almanac"],
                        },
                    },
                ],
                corrections: [],
                newRecords: [],
                facts: [],
                relationPhrases: [],
            });
        });
    });
    afterAll(() => vi.unstubAllGlobals());

    async function shareRecording() {
        const orgUserId = (await ensureOrgAccount()) ?? "";
        await database.db.insert(transcriptSpeakers).values({
            userId: "owner",
            transcriptionId: transcriptId,
            label: "speaker_0",
            personId: null,
            source: "user",
            status: "confirmed",
            markedUnknown: true,
            confirmedByUserId: "owner",
        });
        const [root] = await database.db
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "recording",
            folderId: root?.id ?? "",
        });
        return orgUserId;
    }

    it.each([
        "meeting",
        "",
    ])("rejects a curator's explicit Calendar choice at the route (%s)", async (calendarEventId) => {
        const orgUserId = await shareRecording();
        const access = await requireRecordingView(
            orgUserId,
            "recording",
            "org",
        );
        mocks.learnAccess.mockResolvedValue({
            access,
            actorUserId: orgUserId,
            curates: true,
        });
        const response = await POST(
            new Request(
                `http://localhost/api/recordings/recording/learn?view=org&calendarEventId=${calendarEventId}`,
                { method: "POST" },
            ),
            { params: Promise.resolve({ id: "recording" }) },
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            code: "INVALID_INPUT",
            error: "Calendar context is only available to the recording owner",
        });
        expect(
            await database.db
                .select()
                .from(learnRuns)
                .where(eq(learnRuns.userId, "owner")),
        ).toEqual([]);
        expect(mocks.connection).not.toHaveBeenCalled();
    });

    it("rejects automatic and non-owner private event choices at start", async () => {
        const access = await requireRecordingView(
            "owner",
            "recording",
            "private",
        );
        for (const [actorUserId, trigger] of [
            ["owner", "auto"],
            ["other", "manual"],
        ] as const) {
            await expect(
                startLearnRun({
                    access,
                    actorUserId,
                    trigger,
                    source: "riffado",
                    calendarEventId: "meeting",
                }),
            ).rejects.toMatchObject({
                code: "INVALID_INPUT",
                message:
                    "Calendar context is only available to the recording owner",
            });
        }
    });

    it.each([
        "chosen",
        "",
    ])("honors the owner's manual private event choice (%s) and bounds loaded review confidence", async (calendarEventId) => {
        const access = await requireRecordingView(
            "owner",
            "recording",
            "private",
        );
        mocks.learnAccess.mockResolvedValue({
            access,
            actorUserId: "owner",
            curates: false,
        });
        vi.stubGlobal(
            "fetch",
            googleFetch([calendarEvent, event("chosen", "10:00", "10:10")]),
        );
        const response = await POST(
            new Request(
                `http://localhost/api/recordings/recording/learn?calendarEventId=${calendarEventId}`,
                { method: "POST" },
            ),
            { params: Promise.resolve({ id: "recording" }) },
        );
        expect(response.status).toBe(202);
        const [run] = await database.db
            .select()
            .from(learnRuns)
            .where(eq(learnRuns.userId, "owner"));
        if (!run) throw new Error("Manual run missing");
        expect(run.inputs?.calendarEventId).toBe(calendarEventId);
        const [job] = await database.db
            .select()
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.id, run.jobId ?? ""),
                    eq(asyncJobs.userId, "owner"),
                ),
            );
        expect(job?.payload.calendarEventId).toBe(calendarEventId);
        await learnJobHandler.run({
            userId: "owner",
            jobId: run.jobId ?? "",
            payload: learnJobHandler.parsePayload(job?.payload ?? {}),
            attempt: 1,
            maxAttempts: 1,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        const [stored] = await database.db
            .select()
            .from(learnRuns)
            .where(
                and(eq(learnRuns.id, run.id), eq(learnRuns.userId, "owner")),
            );
        expect(stored?.inputs).toMatchObject({
            calendarEventId,
            calendarEventAutoSelected: false,
        });
        const review = await loadReview(access);
        expect(review.items).toHaveLength(1);
        expect(review.items[0]?.payload).toMatchObject({
            guess: { confidence: 0.49 },
        });
        if (calendarEventId === "")
            expect(mocks.connection).not.toHaveBeenCalled();
        else
            expect(review.items[0]?.payload).toMatchObject({
                source: "calendar",
            });
    });

    it.each([
        false,
        true,
    ])("guards the correction pass's stored event reuse (automatically selected: %s)", async (autoSelected) => {
        const orgUserId = await shareRecording();
        const [run] = await database.db
            .insert(learnRuns)
            .values({
                userId: "owner",
                scopeUserId: orgUserId,
                itemId: "recording",
                transcriptionId: transcriptId,
                actorUserId: orgUserId,
                view: "org",
                trigger: "auto",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status: "finished",
                inputs: {
                    calendarEventId: "chosen",
                    calendarEventAutoSelected: autoSelected,
                },
            })
            .returning({ id: learnRuns.id });
        const [pass] = await database.db
            .insert(transcriptCorrectionPasses)
            .values({
                userId: "owner",
                scopeUserId: orgUserId,
                recordingId: "recording",
                transcriptionId: transcriptId,
                actorUserId: orgUserId,
                view: "org",
                transcriptRevision: 0,
                learnRunId: run?.id ?? "",
            })
            .returning({ id: transcriptCorrectionPasses.id });
        vi.stubGlobal(
            "fetch",
            googleFetch([
                calendarEvent,
                {
                    ...event("chosen", "10:00", "10:10"),
                    attendees: [{ name: "Tavin Vosk" }],
                },
            ]),
        );
        mocks.chat.mockResolvedValue('{"fixes":[]}');
        await correctionPassJobHandler.run({
            userId: orgUserId,
            jobId: "correction-job",
            payload: { passId: pass?.id ?? "" },
            attempt: 1,
            maxAttempts: 1,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        const prompts = mocks.chat.mock.calls
            .flatMap(([messages]) => messages as LearnChatMessage[])
            .map((message) => message.content)
            .join("\n");
        expect(prompts).toContain(
            `MEETING ATTENDEES (JSON):\n["${autoSelected ? "Tavin Vosk" : "Nera Veln"}"]`,
        );
        expect(prompts).not.toContain(
            autoSelected ? "Nera Veln" : "Tavin Vosk",
        );
    });

    it("returns null without connection or scope, and for mail, another owner or a Google error", async () => {
        for (const connection of [null, { status: "active", scopes: [] }]) {
            mocks.connection.mockResolvedValue(connection);
            expect(
                await resolveMeetingRoster({
                    ownerUserId: "owner",
                    itemId: "recording",
                }),
            ).toBeNull();
        }
        mocks.connection.mockResolvedValue({
            status: "active",
            subject: "owner-google",
            scopes: [calendarScope],
        });
        expect(
            await resolveMeetingRoster({
                ownerUserId: "another",
                itemId: "recording",
            }),
        ).toBeNull();
        await database.db.insert(chatterItems).values({
            id: "mail",
            userId: "owner",
            kind: "mail",
            title: encryptText("Invented mail"),
            occurredAt: start,
        });
        expect(
            await resolveMeetingRoster({
                ownerUserId: "owner",
                itemId: "mail",
            }),
        ).toBeNull();
        expect(
            await resolveMeetingRoster({
                ownerUserId: "owner",
                itemId: "recording",
                fetchImpl: googleFetch([], true),
            }),
        ).toBeNull();
    });
    it("returns a single event, and merges Meet names without case or diacritic duplicates", async () => {
        expect(
            await resolveMeetingRoster({
                ownerUserId: "owner",
                itemId: "recording",
            }),
        ).toEqual({
            eventId: "meeting",
            attendees: [{ name: "Nera Veln", source: "calendar" }],
        });
        mocks.connection.mockResolvedValue({
            status: "active",
            subject: "owner-google",
            scopes: [calendarScope, meetScope],
        });
        expect(
            await resolveMeetingRoster({
                ownerUserId: "owner",
                itemId: "recording",
            }),
        ).toEqual({
            eventId: "meeting",
            attendees: [
                { name: "néra veln", source: "meet", invited: true },
                { name: "Míra Luvin", source: "meet" },
            ],
        });
    });

    it.each([
        "manual",
        "auto",
    ] as const)("ignores a non-owner's forged event choices in a %s Organization run", async (trigger) => {
        vi.stubGlobal(
            "fetch",
            googleFetch([
                calendarEvent,
                {
                    ...event("forged", "10:00", "10:10"),
                    attendees: [{ name: "Tavin Vosk" }],
                },
            ]),
        );
        const orgUserId = (await ensureOrgAccount()) ?? "";
        await database.db.insert(transcriptSpeakers).values({
            userId: "owner",
            transcriptionId: transcriptId,
            label: "speaker_0",
            personId: null,
            source: "user",
            status: "confirmed",
            markedUnknown: true,
            confirmedByUserId: "owner",
        });
        const [root] = await database.db
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "recording",
            folderId: root?.id ?? "",
        });
        await database.db
            .delete(transcriptSpeakers)
            .where(
                and(
                    eq(transcriptSpeakers.userId, "owner"),
                    eq(transcriptSpeakers.transcriptionId, transcriptId),
                ),
            );
        personId = (
            await createPerson({ userId: orgUserId, displayName: "Nera Veln" })
        ).id;
        const privatePerson = await createPerson({
            userId: "owner",
            displayName: "Private Vosk",
        });
        await confirmManualFact("owner", {
            subject: { personId: privatePerson.id },
            relationKey: "has_role",
            object: { literal: "Private invented role" },
        });
        await confirmManualFact(orgUserId, {
            subject: { personId },
            relationKey: "has_role",
            object: { literal: "Organization invented role" },
        });
        await database.db.insert(transcriptSpeakers).values({
            userId: "owner",
            transcriptionId: transcriptId,
            label: "speaker_private",
            personId: privatePerson.id,
            source: "user",
            status: "confirmed",
            confirmedByUserId: "owner",
        });
        knowledgeStore().invalidateAll();
        const [run] = await database.db
            .insert(learnRuns)
            .values({
                userId: "owner",
                scopeUserId: orgUserId,
                itemId: "recording",
                transcriptionId: transcriptId,
                view: "org",
                actorUserId: orgUserId,
                trigger,
                inputs: { calendarEventId: "forged" },
                transcriptRevision: 0,
                vocabularyVersion: 0,
            })
            .returning({ id: learnRuns.id });
        await learnJobHandler.run({
            userId: orgUserId,
            jobId: "organization-job",
            payload: { runId: run?.id ?? "", calendarEventId: "forged" },
            attempt: 1,
            maxAttempts: 1,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        const request = mocks.chat.mock.calls
            .flatMap(([messages]) => messages as LearnChatMessage[])
            .find((message) =>
                message.content.startsWith("KNOWLEDGE AND CHOICES"),
            );
        expect(request?.content).toContain("Organization invented role");
        expect(request?.content).not.toContain("Private invented role");
        expect(request?.content).not.toContain(privatePerson.id);
        expect(request?.content).not.toContain("Private Vosk");
        expect(request?.content).not.toContain("Tavin Vosk");
        expect(mocks.connection).toHaveBeenCalledWith("owner");
        expect(mocks.connection).not.toHaveBeenCalledWith(orgUserId);
        const items = await database.db
            .select()
            .from(learnReviewItems)
            .where(eq(learnReviewItems.runId, run?.id ?? ""));
        expect(items).toHaveLength(1);
        expect(decryptJsonField(items[0]?.payload ?? null)).toMatchObject({
            personId,
            source: "calendar",
        });
        const [storedRun] = await database.db
            .select()
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.id, run?.id ?? ""),
                    eq(learnRuns.userId, "owner"),
                ),
            );
        expect(storedRun?.inputs).toMatchObject({
            calendarEventId: "meeting",
            calendarEventAutoSelected: true,
        });
        await database.db
            .update(learnRuns)
            .set({ status: "queued" })
            .where(
                and(
                    eq(learnRuns.id, run?.id ?? ""),
                    eq(learnRuns.userId, "owner"),
                ),
            );
        mocks.chat.mockClear();
        vi.stubGlobal(
            "fetch",
            googleFetch([calendarEvent, { ...calendarEvent, id: "ambiguous" }]),
        );
        await learnJobHandler.run({
            userId: orgUserId,
            jobId: "organization-job",
            payload: { runId: run?.id ?? "", calendarEventId: "forged" },
            attempt: 2,
            maxAttempts: 2,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        expect(
            mocks.chat.mock.calls
                .flatMap(([messages]) => messages as LearnChatMessage[])
                .some((message) =>
                    message.content.includes(
                        '"speakerCandidates":[{"name":"Nera Veln","source":"calendar"}]',
                    ),
                ),
        ).toBe(true);
    });

    it("keeps Calendar invitees and logs a Meet error", async () => {
        mocks.connection.mockResolvedValue({
            status: "active",
            subject: "owner-google",
            scopes: [calendarScope, meetScope],
        });
        const fetchImpl = googleFetch();
        const withMeetFailure = vi.fn(async (input: RequestInfo | URL) =>
            new URL(String(input)).hostname === "meet.googleapis.com"
                ? new Response("unavailable", { status: 503 })
                : fetchImpl(input),
        );
        const logged = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
        try {
            expect(
                await resolveMeetingRoster({
                    ownerUserId: "owner",
                    itemId: "recording",
                    fetchImpl: withMeetFailure,
                }),
            ).toEqual({
                eventId: "meeting",
                attendees: [{ name: "Nera Veln", source: "calendar" }],
            });
            expect(logged).toHaveBeenCalledWith(
                "Meeting roster: Meet attendees could not be loaded",
            );
        } finally {
            logged.mockRestore();
        }
    });

    it("makes one Calendar list call and two Meet calls per automatic Learn recording", async () => {
        mocks.connection.mockResolvedValue({
            status: "active",
            subject: "owner-google",
            scopes: [calendarScope, meetScope],
        });
        const fetchImpl = googleFetch();
        vi.stubGlobal("fetch", fetchImpl);
        expect(
            await startAutomaticLearn({
                userId: "owner",
                itemId: "recording",
                source: "riffado",
                timed: true,
            }),
        ).toEqual({ status: "started" });
        expect(fetchImpl).not.toHaveBeenCalled();
        const [run] = await database.db
            .select()
            .from(learnRuns)
            .where(eq(learnRuns.userId, "owner"));
        if (!run) throw new Error("Missing run");
        await learnJobHandler.run({
            userId: "owner",
            jobId: run.jobId ?? "",
            payload: { runId: run.id },
            attempt: 1,
            maxAttempts: 1,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        expect(
            fetchImpl.mock.calls.map(
                ([input]) => new URL(String(input)).pathname,
            ),
        ).toEqual([
            "/calendar/v3/calendars/primary/events",
            "/v2/conferenceRecords",
            "/v2/conferenceRecords/record/participants",
        ]);
        const listUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]));
        expect(listUrl.searchParams.get("fields")).toContain(
            "hangoutLink,conferenceData",
        );
        expect(listUrl.searchParams.get("fields")).not.toMatch(
            /email|description/,
        );
    });

    it.each([
        false,
        true,
    ])("does not restore a rejected guess on re-learn (evidence: %s)", async (evidence) => {
        await runAutomatic();
        await changeTranscriptSpeaker({
            userId: "owner",
            transcriptionId: transcriptId,
            revision: 0,
            label: "speaker_0",
            answer: { kind: "reject", personId },
            actorUserId: "owner",
            orgUserId: await ensureOrgAccount(),
        });
        await database.db
            .update(learnRuns)
            .set({ status: "superseded" })
            .where(eq(learnRuns.userId, "owner"));
        if (evidence)
            mocks.chat.mockImplementation(
                async (messages: LearnChatMessage[]) =>
                    messages[0]?.content.includes("list the words")
                        ? '{"mentions":[]}'
                        : JSON.stringify({
                              speakers: [
                                  {
                                      label: "speaker_0",
                                      personId,
                                      evidence: ["00:00"],
                                      reason: "Jméno zaznělo.",
                                  },
                              ],
                              newRecords: [],
                              corrections: [],
                              facts: [],
                              relationPhrases: [],
                          }),
            );
        expect(
            await startAutomaticLearn({
                userId: "owner",
                itemId: "recording",
                source: "riffado",
                timed: true,
            }),
        ).toEqual({ status: "started" });
        const [run] = await database.db
            .select()
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.userId, "owner"),
                    eq(learnRuns.status, "queued"),
                ),
            );
        if (!run) throw new Error("Missing re-learn run");
        await learnJobHandler.run({
            userId: "owner",
            jobId: run.jobId ?? "",
            payload: { runId: run.id },
            attempt: 1,
            maxAttempts: 1,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        expect(
            await database.db
                .select()
                .from(learnReviewItems)
                .where(eq(learnReviewItems.runId, run.id)),
        ).toEqual([]);
        expect(
            await database.db
                .select()
                .from(transcriptSpeakers)
                .where(eq(transcriptSpeakers.transcriptionId, transcriptId)),
        ).toEqual([]);
        expect(
            await database.db
                .select()
                .from(transcriptSpeakerRejections)
                .where(
                    eq(
                        transcriptSpeakerRejections.transcriptionId,
                        transcriptId,
                    ),
                ),
        ).toMatchObject([{ label: "speaker_0", personId }]);
    });

    it.each([
        "calendar",
        "meet",
    ] as const)("keeps %s provenance when the strip confirms a roster-only new person", async (source) => {
        await database.db
            .delete(people)
            .where(and(eq(people.id, personId), eq(people.userId, "owner")));
        knowledgeStore().invalidateAll();
        proposedName = "Nera Veln";
        const items = await runAutomatic();
        if (source === "meet")
            for (const item of items)
                await database.db
                    .update(learnReviewItems)
                    .set({
                        payload: encryptJsonField({
                            ...decryptJsonField<Record<string, unknown>>(
                                item.payload,
                            ),
                            source,
                        }),
                    })
                    .where(
                        and(
                            eq(learnReviewItems.id, item.id),
                            eq(learnReviewItems.userId, "owner"),
                        ),
                    );
        await changeTranscriptSpeaker({
            userId: "owner",
            transcriptionId: transcriptId,
            revision: 0,
            label: "speaker_0",
            answer: { kind: "name", displayName: "Nera Veln" },
            actorUserId: "owner",
            orgUserId: await ensureOrgAccount(),
        });
        const rows = await database.db
            .select()
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.transcriptionId, transcriptId));
        expect(rows).toMatchObject([
            { status: "confirmed", source, confirmedByUserId: "owner" },
        ]);
    });

    async function runAutomatic() {
        expect(
            await startAutomaticLearn({
                userId: "owner",
                itemId: "recording",
                source: "riffado",
                timed: true,
            }),
        ).toEqual({ status: "started" });
        const [run] = await database.db
            .select()
            .from(learnRuns)
            .where(eq(learnRuns.userId, "owner"));
        if (!run) throw new Error("Automatic run missing");
        const [job] = await database.db
            .select()
            .from(asyncJobs)
            .where(eq(asyncJobs.id, run.jobId ?? ""));
        expect(job?.payload.calendarEventId).toBeUndefined();
        await learnJobHandler.run({
            userId: "owner",
            jobId: job?.id ?? "",
            payload: learnJobHandler.parsePayload(job?.payload ?? {}),
            attempt: 1,
            maxAttempts: 1,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        expect(
            mocks.chat.mock.calls.some(([messages]) =>
                (messages as LearnChatMessage[]).some((message) =>
                    message.content.includes(
                        '"speakerCandidates":[{"name":"Nera Veln","source":"calendar"}]',
                    ),
                ),
            ),
        ).toBe(true);
        const items = await database.db
            .select()
            .from(learnReviewItems)
            .where(eq(learnReviewItems.runId, run.id));
        const [storedRun] = await database.db
            .select({ inputs: learnRuns.inputs })
            .from(learnRuns)
            .where(eq(learnRuns.id, run.id));
        expect(storedRun?.inputs?.calendarEventId).toBe("meeting");
        expect(items).toHaveLength(proposedName ? 2 : 1);
        expect(items[0]?.preTicked).toBe(false);
        expect(decryptJsonField(items[0]?.payload ?? null)).toMatchObject({
            guess: { confidence: 0.49 },
            source: "calendar",
        });
        return items;
    }
    it("replaces a previous Learn guess while preserving a human answer and carried suggestion", async () => {
        await database.db.insert(transcriptSpeakers).values([
            {
                userId: "owner",
                transcriptionId: transcriptId,
                label: "speaker_3",
                personId,
                source: "heuristic",
                status: "suggested",
                confidence: 0.49,
            },
            {
                userId: "owner",
                transcriptionId: transcriptId,
                label: "speaker_1",
                personId,
                source: "calendar",
                status: "suggested",
                confidence: 0.49,
            },
            {
                userId: "owner",
                transcriptionId: transcriptId,
                label: "speaker_2",
                personId: null,
                source: "user",
                status: "confirmed",
                markedUnknown: true,
                confirmedByUserId: "owner",
            },
        ]);
        await runAutomatic();
        const rows = await database.db
            .select()
            .from(transcriptSpeakers)
            .where(
                and(
                    eq(transcriptSpeakers.userId, "owner"),
                    eq(transcriptSpeakers.transcriptionId, transcriptId),
                ),
            );
        expect(rows).toHaveLength(3);
        expect(rows.find((row) => row.label === "speaker_3")).toMatchObject({
            source: "heuristic",
            status: "suggested",
            personId,
        });
        expect(rows.find((row) => row.label === "speaker_0")).toMatchObject({
            personId,
            status: "suggested",
        });
        expect(rows.find((row) => row.label === "speaker_2")).toMatchObject({
            status: "confirmed",
            markedUnknown: true,
            confirmedByUserId: "owner",
        });
    });

    it.each([
        [false, false],
        [false, true],
        [true, false],
        [true, true],
    ])("leaves a guess unconfirmed unless ticked (new person: %s, tick: %s)", async (newPerson, tick) => {
        if (newPerson) {
            await database.db
                .delete(people)
                .where(
                    and(eq(people.id, personId), eq(people.userId, "owner")),
                );
            knowledgeStore().invalidateAll();
            proposedName = "Nera Veln";
        }
        const items = await runAutomatic();
        const [suggestion] = await database.db
            .select()
            .from(transcriptSpeakers)
            .where(
                and(
                    eq(transcriptSpeakers.transcriptionId, transcriptId),
                    eq(transcriptSpeakers.userId, "owner"),
                ),
            );
        if (!newPerson)
            expect(suggestion).toMatchObject({
                status: "suggested",
                source: "calendar",
                confidence: 0.49,
            });
        if (!newPerson) {
            const reviewed = items.find((item) => item.kind === "speaker");
            if (!reviewed) throw new Error("Speaker proposal missing");
            const payload = decryptJsonField<Record<string, unknown>>(
                reviewed.payload,
            );
            await database.db
                .update(learnReviewItems)
                .set({
                    payload: encryptJsonField({
                        ...payload,
                        label: "  speaker_0  ",
                    }),
                })
                .where(
                    and(
                        eq(learnReviewItems.id, reviewed.id),
                        eq(learnReviewItems.userId, "owner"),
                    ),
                );
            const rows = await getTranscriptSpeakers("owner", transcriptId);
            expect(
                (
                    await withSpeakerProposalContext(
                        "owner",
                        "owner",
                        transcriptId,
                        0,
                        rows,
                    )
                )[0]?.proposal,
            ).toMatchObject({
                source: "calendar",
                reason: "Role odpovídá tématu.",
                guess: { confidence: 0.49 },
            });
            expect(
                (
                    await withSpeakerProposalContext(
                        "owner",
                        "owner",
                        transcriptId,
                        1,
                        rows,
                    )
                )[0]?.proposal,
            ).toBeUndefined();
            expect(
                (
                    await withSpeakerProposalContext(
                        "owner",
                        "other-scope",
                        transcriptId,
                        0,
                        rows,
                    )
                )[0]?.proposal,
            ).toBeUndefined();
            await database.db
                .update(learnReviewItems)
                .set({ payload: reviewed.payload })
                .where(
                    and(
                        eq(learnReviewItems.id, reviewed.id),
                        eq(learnReviewItems.userId, "owner"),
                    ),
                );
        }
        expect(await buildNameResolver("owner", transcriptId)).toBeUndefined();
        expect((await llmRendering(transcriptId))?.text).not.toContain(
            "Nera Veln",
        );
        const access = await requireRecordingView(
            "owner",
            "recording",
            "private",
        );
        if (tick)
            for (const item of items) {
                await decideReviewItem(access, item.id, {
                    decision: "accepted",
                    version: 0,
                });
            }
        const result = await finishReview(access, "owner", {
            versions: Object.fromEntries(
                items.map((item) => [item.id, tick ? 1 : 0]),
            ),
        });
        expect(result.applied).toBe(tick ? (newPerson ? 2 : 1) : 0);
        const resolver = await buildNameResolver("owner", transcriptId);
        if (tick) {
            expect(resolver?.("speaker_0")).toBe("Nera Veln");
            const [confirmed] = await database.db
                .select()
                .from(transcriptSpeakers)
                .where(eq(transcriptSpeakers.transcriptionId, transcriptId));
            expect(confirmed).toMatchObject({
                status: "confirmed",
                source: "calendar",
                confirmedByUserId: "owner",
            });
        } else expect(resolver).toBeUndefined();
    });
});

it("ignores Focus time without invitees and prefers the closest duration on equal overlap", () => {
    const focus = { ...event("focus", "09:00", "12:00"), attendees: [] };
    expect(selectMeetingEvent([focus, calendarEvent], start, end)?.id).toBe(
        "meeting",
    );
    expect(
        selectMeetingEvent(
            [{ ...focus, attendees: [{ name: "Nera Veln" }] }, calendarEvent],
            start,
            end,
        )?.id,
    ).toBe("meeting");
    expect(
        selectMeetingEvent(
            [calendarEvent, { ...calendarEvent, id: "duplicate" }],
            start,
            end,
        ),
    ).toBeNull();
});

it("filters ineligible events before choosing the greatest overlap", () => {
    const longEnd = new Date(`${recordingDate}T14:00:00Z`);
    const ineligible = event("ineligible", "06:00", "10:40");
    const eligible = event("eligible", "12:00", "12:30");
    expect(selectMeetingEvent([ineligible, eligible], start, longEnd)?.id).toBe(
        "eligible",
    );
});

it("ignores ineligible runners-up when judging ambiguity", () => {
    const longEnd = new Date(`${recordingDate}T14:00:00Z`);
    const ineligible = event("ineligible", "06:00", "10:28");
    const eligible = event("eligible", "12:00", "12:30");
    expect(selectMeetingEvent([eligible, ineligible], start, longEnd)?.id).toBe(
        "eligible",
    );
});
