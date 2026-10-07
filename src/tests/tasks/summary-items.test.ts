import { describe, expect, it } from "vitest";
import { parseSummaryPayload } from "@/lib/summary/payload";
import {
    buildTasksContext,
    localDay,
    recordingOffsetMinutes,
} from "@/lib/tasks/directive";
import { locateQuote, normalizeTaskText } from "@/lib/tasks/quote";
import {
    isoDateOrNull,
    readTaskItems,
    readTaskUpdates,
    taskItemLine,
} from "@/lib/tasks/summary-items";

describe("readTaskItems", () => {
    it("reads the object shape the directive asks for", () => {
        const [item] = readTaskItems([
            {
                text: "Draft the pricing page",
                speaker: "speaker_1",
                assignee: null,
                due: { phrase: "by next Friday", date: "2026-10-16" },
                quote: "I'll have a draft by next Friday",
            },
        ]);
        expect(item).toEqual({
            text: "Draft the pricing page",
            speaker: "speaker_1",
            assignee: null,
            due: { phrase: "by next Friday", date: "2026-10-16" },
            quote: "I'll have a draft by next Friday",
        });
    });

    it("takes a speaker named in the assignee field, and a placeholder form", () => {
        const items = readTaskItems([
            { text: "a", assignee: "speaker_2" },
            { text: "b", speaker: "[Speaker 3](#speaker-3)" },
            { text: "c", assignee: "Carol" },
        ]);
        expect(items.map((item) => [item.speaker, item.assignee])).toEqual([
            ["speaker_2", null],
            ["speaker_3", null],
            [null, "Carol"],
        ]);
    });

    it("reads a plain string, and a leading speaker reference as its speaker", () => {
        const items = readTaskItems([
            "[Speaker 2](#speaker-2) to draft the pricing page",
            "Book the venue",
        ]);
        expect(items[0]?.speaker).toBe("speaker_2");
        expect(items[0]?.text).toBe(
            "[Speaker 2](#speaker-2) to draft the pricing page",
        );
        expect(items[1]).toMatchObject({
            text: "Book the venue",
            speaker: null,
        });
    });

    it("keeps an object without known text as its JSON, and drops nulls", () => {
        const items = readTaskItems([null, { foo: "bar" }, 42]);
        expect(items.map((item) => item.text)).toEqual(['{"foo":"bar"}', "42"]);
    });

    it("keeps a due phrase without a date, and drops an impossible date", () => {
        const [soon, impossible] = readTaskItems([
            { text: "a", due: { phrase: "soon", date: null } },
            { text: "b", due: { phrase: "the 31st", date: "2026-02-31" } },
        ]);
        expect(soon?.due).toEqual({ phrase: "soon", date: null });
        expect(impossible?.due).toEqual({ phrase: "the 31st", date: null });
    });
});

describe("readTaskUpdates", () => {
    it("keeps well-formed updates once each", () => {
        expect(
            readTaskUpdates([
                { ref: "T1", kind: "done", quote: "sent it yesterday" },
                { ref: "T1", kind: "done" },
                {
                    ref: "T2",
                    kind: "due",
                    due: { phrase: "Monday", date: "2026-10-12" },
                },
                {
                    ref: "T3",
                    kind: "due",
                    due: { phrase: "later", date: null },
                },
                { ref: "T4", kind: "cancel" },
            ]),
        ).toEqual([
            { ref: "T1", kind: "done", due: null, quote: "sent it yesterday" },
            {
                ref: "T2",
                kind: "due",
                due: { phrase: "Monday", date: "2026-10-12" },
                quote: null,
            },
        ]);
    });
});

describe("taskItemLine", () => {
    it("writes who, what and by when on one line", () => {
        expect(
            taskItemLine({
                text: "Draft the pricing page",
                speaker: "speaker_1",
                assignee: null,
                due: { phrase: "by Friday", date: null },
                quote: null,
            }),
        ).toBe("[Speaker 1](#speaker-1): Draft the pricing page (by Friday)");
        expect(
            taskItemLine({
                text: "Write the press release",
                speaker: null,
                assignee: "Carol",
                due: null,
                quote: null,
            }),
        ).toBe("Carol: Write the press release");
    });
});

describe("parseSummaryPayload", () => {
    it("keeps the one-line list and the structured items side by side", () => {
        const payload = parseSummaryPayload(
            JSON.stringify({
                summary: "s",
                keyPoints: [],
                actionItems: [{ text: "Book the venue", assignee: "Carol" }],
                taskUpdates: [{ ref: "T1", kind: "done" }],
            }),
        );
        expect(payload.actionItems).toEqual(["Carol: Book the venue"]);
        expect(payload.taskItems[0]?.assignee).toBe("Carol");
        expect(payload.taskUpdates).toHaveLength(1);
    });
});

describe("dates", () => {
    it("validates calendar days", () => {
        expect(isoDateOrNull("2026-10-16")).toBe("2026-10-16");
        expect(isoDateOrNull("2026-13-01")).toBeNull();
        expect(isoDateOrNull("next Friday")).toBeNull();
    });

    it("reads the local day from Plaud's offset", () => {
        const at = new Date("2026-10-06T23:30:00Z");
        expect(localDay(at, recordingOffsetMinutes(2, 0))).toEqual({
            date: "2026-10-07",
            weekday: "Wednesday",
            zone: "UTC+02:00",
        });
        expect(localDay(at, recordingOffsetMinutes(null, null))).toEqual({
            date: "2026-10-06",
            weekday: "Tuesday",
            zone: "UTC+00:00",
        });
        expect(recordingOffsetMinutes(-3, 30)).toBe(-210);
    });
});

describe("buildTasksContext", () => {
    it("gives the day, the decided tasks and the open ones with references", () => {
        const text = buildTasksContext({
            recordedAt: new Date("2026-10-06T10:00:00Z"),
            offsetMinutes: 120,
            decided: ["Draft the pricing page"],
            open: [
                {
                    ref: "T1",
                    text: "Send the partner email",
                    speaker: "speaker_0",
                    dueDate: "2026-10-20",
                },
            ],
        });
        expect(text).toContain("Tuesday, 2026-10-06 (UTC+02:00)");
        expect(text).toContain("- Draft the pricing page");
        expect(text).toContain(
            "- T1 (speaker_0): Send the partner email, due 2026-10-20",
        );
    });

    it("says nothing of tasks when there are none", () => {
        const text = buildTasksContext({
            recordedAt: new Date("2026-10-06T10:00:00Z"),
            offsetMinutes: null,
            decided: [],
            open: [],
        });
        expect(text).not.toContain("Already decided");
        expect(text).not.toContain("Open tasks");
    });
});

describe("locateQuote", () => {
    const turns = [
        {
            startMs: 0,
            text: "Okay, so for the Q4 launch we still need the pricing page.",
        },
        {
            startMs: 9_000,
            text: "I can take the pricing page. I'll have a draft by next Friday.",
        },
    ];

    it("finds the turn holding the quote", () => {
        expect(locateQuote(turns, "I'll have a draft by next Friday")).toBe(
            9_000,
        );
    });

    it("accepts a loose copy, and refuses an invented one", () => {
        expect(locateQuote(turns, "have the draft by Friday")).toBe(9_000);
        expect(locateQuote(turns, "book the venue downtown")).toBeNull();
        expect(locateQuote(null, "anything")).toBeNull();
    });
});

describe("normalizeTaskText", () => {
    it("folds case, punctuation and speaker links", () => {
        expect(
            normalizeTaskText("[Speaker 1](#speaker-1): Draft the page!"),
        ).toBe(normalizeTaskText("speaker 1 draft THE page"));
    });
});
