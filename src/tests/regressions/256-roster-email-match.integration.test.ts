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
    asyncJobs,
    chatterItems,
    learnReviewItems,
    learnRuns,
    people,
    personEmails,
    transcriptions,
    userSettings,
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
            ORG_ACCOUNT_EMAIL: "organization@example.com",
            ORG_ACCOUNT_PASSWORD: "test-password",
            ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 100,
        },
        connection: vi.fn(),
        token: vi.fn(),
        chat: vi.fn(),
    };
});
vi.mock("@/db", () => ({ db: mocks.db, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
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

import {
    decryptJsonField,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { matchRosterPeople } from "@/lib/integrations/google/match-roster-people";
import { resolveMeetingRoster } from "@/lib/integrations/google/meeting-roster";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { createPerson, findPersonByEmail } from "@/lib/knowledge/people";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { learnJobHandler } from "@/lib/learn/learn-job-handler";
import type { LearnChatMessage } from "@/lib/learn/run-fallback";
import { ensureOrgAccount } from "@/lib/org/account";
import { insertRecordings } from "@/tests/integration/items";
import { seedExistingPersonalProfiles } from "@/tests/integration/profile-fixtures";

const url = getTestDatabaseUrl();
const databaseTests = url ? describe : describe.skip;
const email = "alex@example.com";
const calendarScope =
    "https://www.googleapis.com/auth/calendar.events.readonly";
const meetScope = "https://www.googleapis.com/auth/meetings.space.readonly";
const start = new Date();
const end = new Date(start.getTime() + 3_600_000);

databaseTests("roster email matching through real hashes (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let personId: string;
    let orgUserId: string;
    let transcriptId: string;
    let fetchImpl: ReturnType<typeof vi.fn>;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(url ?? "", "roster_email");
        mocks.ref.current = database.db as unknown as Record<
            PropertyKey,
            unknown
        >;
    }, 120_000);
    afterAll(async () => {
        vi.unstubAllGlobals();
        mocks.ref.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        vi.clearAllMocks();
        knowledgeStore().invalidateAll();
        await database.db.delete(users);
        await database.db.delete(asyncJobs);
        await database.db.insert(users).values([
            { id: "owner", email: "owner@example.com" },
            { id: "other", email: "other@example.com" },
        ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        await seedExistingPersonalProfiles("owner", mocks.env);
        await seedCoreVocabulary();
        await database.db
            .insert(userSettings)
            .values({ userId: "owner", autoLearn: true });
        personId = (
            await createPerson({
                userId: "owner",
                displayName: "Alex Morgan",
                primaryEmail: email,
            })
        ).id;
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
                text: encryptText("The next step is ready."),
                turns: encryptJsonField([
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 5000,
                        text: "The next step is ready.",
                    },
                ]),
                detectedLanguage: "en",
                provider: "openai",
                source: "riffado",
                model: "test-model",
            })
            .returning({ id: transcriptions.id });
        transcriptId = transcript?.id ?? "";
        mocks.connection.mockResolvedValue({
            status: "active",
            subject: "owner-google",
            scopes: [calendarScope, meetScope],
        });
        mocks.token.mockResolvedValue("test-token");
        fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
            const request = new URL(String(input));
            if (request.pathname.endsWith("/events"))
                return Response.json({
                    items: [
                        {
                            id: "meeting",
                            start: { dateTime: start.toISOString() },
                            end: { dateTime: end.toISOString() },
                            hangoutLink: "https://meet.google.com/abc-defg-hij",
                            attendees: [
                                {
                                    displayName: "Calendar nickname",
                                    email: email.toUpperCase(),
                                },
                            ],
                        },
                    ],
                });
            if (request.pathname.endsWith("/conferenceRecords"))
                return Response.json({
                    conferenceRecords: [
                        {
                            name: "conferenceRecords/record",
                            startTime: start.toISOString(),
                            endTime: end.toISOString(),
                            expireTime: new Date(
                                end.getTime() + 86_400_000,
                            ).toISOString(),
                        },
                    ],
                });
            if (request.pathname.endsWith("/participants"))
                return Response.json({
                    participants: [
                        {
                            signedinUser: {
                                displayName: "Calendar nickname",
                                user: "users/123",
                            },
                        },
                    ],
                });
            throw new Error("Unexpected Google request");
        });
        vi.stubGlobal("fetch", fetchImpl);
        mocks.chat.mockImplementation(async (messages: LearnChatMessage[]) => {
            if (messages[0]?.content.includes("list the words"))
                return '{"mentions":[]}';
            return JSON.stringify({
                newRecords: [],
                corrections: [],
                facts: [],
                relationPhrases: [],
                speakers: [
                    {
                        label: "speaker_0",
                        personId,
                        evidence: [],
                        reason: "Matches the role.",
                        guess: { confidence: 0.8, clues: ["meet", "calendar"] },
                    },
                ],
            });
        });
    });
    async function match(
        address: string,
        scopeUserId = "owner",
        rosterName = "Calendar nickname",
    ) {
        const rows = await database.db
            .select({ id: people.id, name: people.displayName })
            .from(people)
            .where(eq(people.userId, scopeUserId));
        return matchRosterPeople({
            ownerUserId: "owner",
            scopeUserId,
            people: new Map(
                rows.map((row) => [
                    row.id,
                    {
                        name:
                            row.id === personId ? "Alex Morgan" : "Priya Raman",
                    },
                ]),
            ),
            attendees: [
                { name: rosterName, source: "calendar", emails: [address] },
            ],
        });
    }
    async function addExtra(id: string, address: string, owner = "owner") {
        await database.db.insert(personEmails).values({
            userId: owner,
            personId: id,
            email: encryptText(address),
            emailHash: lookupHash(address),
        });
    }
    it("matches primary addresses case-insensitively", async () => {
        expect(
            (await match("  ALEX@EXAMPLE.COM  ")).attendees[0],
        ).toMatchObject({
            personId,
            name: "Alex Morgan",
            matchedByEmail: true,
        });
    });
    it("matches extra email hashes case-insensitively", async () => {
        await addExtra(personId, "alex.extra@example.com");
        expect(
            (await match("ALEX.EXTRA@EXAMPLE.COM")).attendees[0]?.personId,
        ).toBe(personId);
    });
    it("counts a primary and extra hash on the same person as one match", async () => {
        await addExtra(personId, email);
        expect((await match(email)).attendees[0]?.personId).toBe(personId);
    });
    it("falls back on a primary/extra duplicate in scope", async () => {
        const duplicate = await createPerson({
            userId: "owner",
            displayName: "Priya Raman",
        });
        await addExtra(duplicate.id, email);
        expect(await match(email)).toEqual({
            attendees: [{ name: "Calendar nickname", source: "calendar" }],
            dropped: { ambiguousName: 1 },
        });
    });
    it("falls back when the hash conflicts with a known name", async () => {
        await createPerson({ userId: "owner", displayName: "Priya Raman" });
        expect((await match(email, "owner", "Priya Raman")).dropped).toEqual({
            conflicting: 1,
        });
    });
    it("isolates private, Organization and other-user hashes", async () => {
        const organizationPerson = await createPerson({
            userId: orgUserId,
            displayName: "Priya Raman",
            primaryEmail: email,
        });
        await createPerson({
            userId: "other",
            displayName: "Lena Fischer",
            primaryEmail: email,
        });
        expect((await match(email)).attendees[0]?.personId).toBe(personId);
        expect((await match(email, orgUserId)).attendees[0]?.personId).toBe(
            organizationPerson.id,
        );
        expect(
            (await match(email, "other")).attendees[0]?.personId,
        ).toBeUndefined();
        const foreign = await createPerson({
            userId: "other",
            displayName: "Sam Okafor",
            primaryEmail: "foreign@example.com",
        });
        expect(
            await findPersonByEmail("owner", "foreign@example.com", {
                scopeUserId: "other",
                personIds: [foreign.id],
                onAmbiguous: vi.fn(),
            }),
        ).toBeNull();
    });
    it("keeps name matching when an address has no match", async () => {
        expect(
            (await match("missing@example.com", "owner", "Alex Morgan"))
                .attendees,
        ).toEqual([{ name: "Alex Morgan", source: "calendar" }]);
    });
    it("returns the canonical Almanac name with Meet provenance and no addresses", async () => {
        const roster = await resolveMeetingRoster({
            ownerUserId: "owner",
            itemId: "recording",
        });
        expect(roster?.attendees).toEqual([
            {
                name: "Alex Morgan",
                personId,
                source: "meet",
                invited: true,
                matchedByEmail: true,
            },
        ]);
        expect(JSON.stringify(roster).toLowerCase()).not.toContain(email);
    });
    it("keeps the attendee address out of model prompts, stored inputs and review payloads", async () => {
        const [run] = await database.db
            .insert(learnRuns)
            .values({
                userId: "owner",
                scopeUserId: "owner",
                itemId: "recording",
                transcriptionId: transcriptId,
                view: "private",
                actorUserId: "owner",
                trigger: "auto",
                transcriptRevision: 0,
                vocabularyVersion: 0,
            })
            .returning({ id: learnRuns.id });
        await learnJobHandler.run({
            userId: "owner",
            jobId: "test-job",
            payload: { runId: run?.id ?? "" },
            attempt: 1,
            maxAttempts: 1,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        const prompts = JSON.stringify(mocks.chat.mock.calls);
        expect(prompts).toContain("Alex Morgan");
        expect(prompts.toLowerCase()).not.toContain(email);
        expect(prompts).not.toContain("Calendar nickname");
        const review = await database.db
            .select()
            .from(learnReviewItems)
            .where(eq(learnReviewItems.runId, run?.id ?? ""));
        const payloads = review.map((row) => decryptJsonField(row.payload));
        expect(payloads).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    personId,
                    source: "meet",
                    guess: expect.objectContaining({
                        matchedByEmail: true,
                        confidence: 0.49,
                    }),
                }),
            ]),
        );
        expect(review.every((row) => !row.preTicked)).toBe(true);
        const stored = await database.db
            .select()
            .from(learnRuns)
            .where(eq(learnRuns.id, run?.id ?? ""));
        expect(JSON.stringify([payloads, stored]).toLowerCase()).not.toContain(
            email,
        );
    });
    it("never consults Calendar or Meet for a mail item", async () => {
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
        expect(mocks.connection).not.toHaveBeenCalled();
        expect(mocks.token).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
