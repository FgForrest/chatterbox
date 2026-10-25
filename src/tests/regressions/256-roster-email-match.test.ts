import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchRosterPeople } from "@/lib/integrations/google/match-roster-people";
import { findPersonByEmail } from "@/lib/knowledge/people";
import { speakerPromptContext } from "@/lib/learn/speaker-prompt-context";
import { type LearnRunFrame, validateLearnOutput } from "@/lib/learn/validate";
import { mergeMeetingTerms } from "@/lib/transcription/meeting-terms";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));
vi.mock("@/lib/knowledge/people", () => ({ findPersonByEmail: vi.fn() }));
const lookup = vi.mocked(findPersonByEmail);
const people = new Map([
    ["alex", { name: "Alex Morgan", aliases: ["Alex"] }],
    ["priya", { name: "Priya Raman", aliases: [] }],
]);
const base = { ownerUserId: "owner", scopeUserId: "owner", people };
const attendee = {
    name: "Calendar nickname",
    source: "calendar" as const,
    emails: ["ALEX@example.com"],
};
beforeEach(() => {
    lookup.mockReset();
    lookup.mockResolvedValue(null);
});
function found(id = "alex") {
    lookup.mockResolvedValue({ id } as Awaited<
        ReturnType<typeof findPersonByEmail>
    >);
}

describe("roster email matching", () => {
    it("keeps the matched ID ahead of namesakes in the bounded prompt", () => {
        const people = new Map(
            Array.from({ length: 150 }, (_, index) => [
                `p${index}`,
                { name: "Alex Morgan" },
            ]),
        );
        const context = speakerPromptContext(
            {
                people,
                answeredLabels: new Map(),
                recorderPersonId: null,
                speakerCandidates: [
                    {
                        name: "Alex Morgan",
                        source: "calendar",
                        personId: "p149",
                        matchedByEmail: true,
                    },
                ],
            },
            [],
        );
        expect(context.knownPeople).toHaveLength(100);
        expect(context.knownPeople[0]?.personId).toBe("p149");
    });
    it("omits an unmatched address used as a display name", async () => {
        expect(
            (
                await matchRosterPeople({
                    ...base,
                    attendees: [{ ...attendee, name: "ALEX@example.com" }],
                })
            ).attendees,
        ).toEqual([]);
    });
    it("uses the canonical name when Google has only an address", async () => {
        found();
        expect(
            (
                await matchRosterPeople({
                    ...base,
                    attendees: [{ ...attendee, name: "" }],
                })
            ).attendees[0],
        ).toMatchObject({ name: "Alex Morgan", personId: "alex" });
    });
    it("uses the scoped hash lookup and replaces the calendar spelling", async () => {
        found();
        const result = await matchRosterPeople({
            ...base,
            attendees: [attendee],
        });
        expect(lookup).toHaveBeenCalledWith("owner", "ALEX@example.com", {
            scopeUserId: "owner",
            personIds: ["alex", "priya"],
            onAmbiguous: expect.any(Function),
        });
        expect(result).toEqual({
            attendees: [
                {
                    name: "Alex Morgan",
                    personId: "alex",
                    source: "calendar",
                    matchedByEmail: true,
                },
            ],
            dropped: {},
        });
        expect(mergeMeetingTerms([], result.attendees, null)).toEqual([
            { text: "Alex Morgan", soundsLike: [] },
        ]);
        expect(JSON.stringify(result)).not.toContain("example.com");
    });
    it("preserves Meet and invitation provenance", async () => {
        found();
        const result = await matchRosterPeople({
            ...base,
            attendees: [{ ...attendee, source: "meet", invited: true }],
        });
        expect(result.attendees[0]).toMatchObject({
            source: "meet",
            invited: true,
            matchedByEmail: true,
        });
    });
    it("falls back to the original name on a duplicate address", async () => {
        lookup.mockImplementation(async (_user, _email, options) => {
            options?.onAmbiguous();
            return null;
        });
        expect(
            await matchRosterPeople({
                ...base,
                attendees: [{ ...attendee, name: "Alex" }],
            }),
        ).toEqual({
            attendees: [{ name: "Alex", source: "calendar" }],
            dropped: { ambiguousName: 1 },
        });
    });
    it("falls back on a conflict with a name or alias", async () => {
        found("priya");
        expect(
            await matchRosterPeople({
                ...base,
                attendees: [{ ...attendee, name: "Alex" }],
            }),
        ).toEqual({
            attendees: [{ name: "Alex", source: "calendar" }],
            dropped: { conflicting: 1 },
        });
    });
    it("does not choose between addresses attached to different people with the same roster name", async () => {
        lookup.mockResolvedValueOnce({ id: "alex" } as Awaited<
            ReturnType<typeof findPersonByEmail>
        >);
        lookup.mockResolvedValueOnce({ id: "priya" } as Awaited<
            ReturnType<typeof findPersonByEmail>
        >);
        expect(
            (
                await matchRosterPeople({
                    ...base,
                    attendees: [
                        {
                            ...attendee,
                            emails: ["alex@example.com", "priya@example.com"],
                        },
                    ],
                })
            ).dropped,
        ).toEqual({ ambiguousName: 1 });
    });
    it("keeps name matching when an address is absent or unmatched", async () => {
        const result = await matchRosterPeople({
            ...base,
            attendees: [
                { ...attendee, name: "Alex" },
                { name: "Priya Raman", source: "meet" },
            ],
        });
        expect(result.attendees).toEqual([
            { name: "Alex", source: "calendar" },
            { name: "Priya Raman", source: "meet" },
        ]);
        expect(lookup).toHaveBeenCalledTimes(1);
    });
    it("ignores a lookup result outside the frozen run people", async () => {
        found("foreign");
        expect(
            (await matchRosterPeople({ ...base, attendees: [attendee] }))
                .attendees[0],
        ).toEqual({ name: "Calendar nickname", source: "calendar" });
    });
    it("resolves a candidate to the email-matched ID even with a namesake", async () => {
        found();
        const result = await matchRosterPeople({
            ...base,
            attendees: [attendee],
        });
        const frame: LearnRunFrame = {
            revision: 0,
            currentRevision: 0,
            language: "en",
            provider: null,
            turns: [
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 5000,
                    text: "The next step is ready.",
                },
            ],
            people: new Map([
                ...people,
                ["namesake", { name: "Alex Morgan", aliases: [] }],
            ]),
            entities: new Map(),
            relations: new Map(),
            answeredLabels: new Map(),
            confirmedHeardAs: new Set(),
            knownFacts: new Map(),
            dismissed: new Set(),
            speakerCandidates: result.attendees,
        };
        const validated = validateLearnOutput(
            {
                newRecords: [],
                corrections: [],
                facts: [],
                relationPhrases: [],
                speakers: [
                    {
                        label: "speaker_0",
                        personId: null,
                        rosterName: "Alex Morgan",
                        evidence: [],
                        reason: "Matches the role.",
                        guess: { confidence: 0.8, clues: ["calendar"] },
                    },
                ],
            },
            frame,
        );
        expect(validated.items).toMatchObject([
            {
                kind: "speaker",
                preTicked: false,
                payload: {
                    personId: "alex",
                    source: "calendar",
                    guess: { matchedByEmail: true, confidence: 0.49 },
                },
            },
        ]);
        expect(JSON.stringify(validated)).not.toContain("example.com");
    });
});
