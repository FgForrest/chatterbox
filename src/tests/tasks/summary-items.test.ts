import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/deployment-brand", () => ({
    deploymentProductName: () => "Chatterbox",
}));

import { parseSummaryPayload } from "@/lib/summary/payload";
import {
    buildPlaudActionItemHints,
    buildTasksContext,
    localDay,
    recordingOffsetMinutes,
    SUMMARY_TASKS_DIRECTIVE,
} from "@/lib/tasks/directive";
import { locateQuote, normalizeTaskText } from "@/lib/tasks/quote";
import {
    isoDateOrNull,
    readTaskItems,
    readTaskUpdates,
    resolveOfferedTaskReference,
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
            candidates: null,
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

    it("keeps unique candidate references for an ambiguous commitment", () => {
        const [item] = readTaskItems([
            {
                text: "Send the contract",
                candidates: ["T2", "T1", "T2", "not-a-ref"],
            },
        ]);

        expect(item?.candidates).toEqual(["T2", "T1"]);
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

    it("keeps matches and vague deadlines separate from field changes", () => {
        expect(
            readTaskUpdates([
                {
                    ref: "T1",
                    kind: "match",
                    quote: "same commitment",
                    due: { phrase: "must not leak", date: "2026-10-20" },
                },
                { ref: "T1", kind: "match", quote: "duplicate match" },
                {
                    ref: "T1",
                    kind: "due_phrase",
                    due: { phrase: "později", date: null },
                },
                { ref: "T1", kind: "done", quote: "hotovo" },
            ]),
        ).toEqual([
            {
                ref: "T1",
                kind: "match",
                due: null,
                quote: "same commitment",
            },
            {
                ref: "T1",
                kind: "due_phrase",
                due: { phrase: "později", date: null },
                quote: null,
            },
            { ref: "T1", kind: "done", due: null, quote: "hotovo" },
        ]);
    });

    it("[A, B] reads drop and reassignment outcomes with their evidence", () => {
        expect(
            readTaskUpdates([
                {
                    ref: "T1",
                    kind: "drop",
                    quote: "we no longer need the launch deck",
                },
                {
                    ref: "T2",
                    kind: "assignee",
                    assignee: "speaker_3",
                    quote: "I handed the report to Dana",
                },
                {
                    ref: "T3",
                    kind: "assignee",
                    assignee: "Dana Nováková",
                },
            ]),
        ).toEqual([
            {
                ref: "T1",
                kind: "drop",
                due: null,
                assignee: null,
                quote: "we no longer need the launch deck",
            },
            {
                ref: "T2",
                kind: "assignee",
                due: null,
                assignee: "speaker_3",
                quote: "I handed the report to Dana",
            },
            {
                ref: "T3",
                kind: "assignee",
                due: null,
                assignee: "Dana Nováková",
                quote: null,
            },
        ]);
    });
});

describe("resolveOfferedTaskReference", () => {
    it("drops a reference that was not offered with a warning", () => {
        const warning = vi.fn();
        const refs = new Map([["T1", "task-one"]]);

        expect(resolveOfferedTaskReference("T1", refs, warning)).toBe(
            "task-one",
        );
        expect(resolveOfferedTaskReference("T9", refs, warning)).toBeNull();
        expect(warning).toHaveBeenCalledOnce();
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
                candidates: null,
            }),
        ).toBe("[Speaker 1](#speaker-1): Draft the pricing page (by Friday)");
        expect(
            taskItemLine({
                text: "Write the press release",
                speaker: null,
                assignee: "Carol",
                due: null,
                quote: null,
                candidates: null,
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
                actionItems: [
                    {
                        text: "Book the venue",
                        assignee: "Carol",
                        candidates: ["T1", "T2"],
                    },
                ],
                taskUpdates: [
                    { ref: "T1", kind: "match", quote: "the same venue" },
                    {
                        ref: "T1",
                        kind: "due_phrase",
                        due: { phrase: "later", date: null },
                    },
                    { ref: "T1", kind: "done" },
                ],
            }),
        );
        expect(payload.actionItems).toEqual(["Carol: Book the venue"]);
        expect(payload.taskItems[0]?.assignee).toBe("Carol");
        expect(payload.taskItems[0]?.candidates).toEqual(["T1", "T2"]);
        expect(payload.taskUpdates.map((update) => update.kind)).toEqual([
            "match",
            "due_phrase",
            "done",
        ]);
    });

    it("[E] removes every task outcome when the profile has Tasks off", () => {
        const payload = parseSummaryPayload(
            JSON.stringify({
                summary: "s",
                keyPoints: [],
                actionItems: [{ text: "New task" }],
                taskUpdates: [
                    { ref: "T1", kind: "drop" },
                    { ref: "T2", kind: "assignee", assignee: "Dana" },
                ],
            }),
            { tasksEnabled: false },
        );

        expect(payload.actionItems).toEqual([]);
        expect(payload.taskItems).toEqual([]);
        expect(payload.taskUpdates).toEqual([]);
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

    it("keeps English and Czech candidate text as data under the new outcome directive", () => {
        const text = buildTasksContext({
            recordedAt: new Date("2026-10-06T10:00:00Z"),
            offsetMinutes: 0,
            decided: [],
            open: [
                {
                    ref: "T1",
                    text: "Send the signed contract",
                    speaker: null,
                    dueDate: null,
                },
                {
                    ref: "T2",
                    text: "Poslat podepsanou smlouvu",
                    speaker: null,
                    dueDate: null,
                },
            ],
        });

        expect(text).toContain("- T1: Send the signed contract");
        expect(text).toContain("- T2: Poslat podepsanou smlouvu");
        expect(text).toContain('"kind": "match"');
        expect(text).toContain('"kind": "due_phrase"');
        expect(text).toContain('"kind": "drop"');
        expect(text).toContain('"kind": "assignee"');
        expect(text).not.toContain("reopen");
        expect(SUMMARY_TASKS_DIRECTIVE).toContain('"candidates"');
    });

    it("adds the approved Czech drop and mail-assignee outcomes without changing candidate data", () => {
        const text = buildTasksContext({
            noun: "mail",
            language: "cs-CZ",
            recordedAt: new Date("2026-10-06T10:00:00Z"),
            offsetMinutes: 0,
            decided: [],
            open: [
                {
                    ref: "T1",
                    text: "Poslat podepsanou smlouvu",
                    speaker: null,
                    assigneeName: "Eva",
                    dueDate: null,
                },
            ],
        });

        expect(text).toContain(
            "Pokud je úkol výslovně zrušený, už není potřeba nebo ho nahradil jiný úkol",
        );
        expect(text).toContain('"kind": "assignee", "assignee": "pN" | string');
        expect(text).toContain(
            "Pokud je tato osoba účastníkem e-mailu, použijte její označení účastníka",
        );
        expect(text).toContain(
            "- T1 (assigned to Eva): Poslat podepsanou smlouvu",
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

describe("buildPlaudActionItemHints", () => {
    it("truncates on Unicode code points", () => {
        const hint = buildPlaudActionItemHints([`${"a".repeat(499)}😀x`]);

        expect(hint.split("\n").at(-1)).toBe(`- ${"a".repeat(499)}😀`);
        expect(hint).not.toContain("�");
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

    it("places Czech inflections and folded diacritics", () => {
        const czechTurns = [
            {
                startMs: 4_000,
                text: "Připravila jsem podklady pro nový projekt a pošlu je zítra.",
            },
            {
                startMs: 11_000,
                text: "Rozpočet pro kancelář projednáme až příští měsíc.",
            },
        ];

        expect(
            locateQuote(
                czechTurns,
                "Připravím podklady k novému projektu a pošlu je zítra",
            ),
        ).toBe(4_000);
        expect(
            locateQuote(
                czechTurns,
                "Pripravim podklady k novemu projektu a poslu je zitra",
            ),
        ).toBe(4_000);
        expect(
            locateQuote(czechTurns, "Objednáme občerstvení do zasedačky"),
        ).toBeNull();
    });
});

describe("normalizeTaskText", () => {
    it("folds case, punctuation and speaker links", () => {
        expect(
            normalizeTaskText("[Speaker 1](#speaker-1): Draft the page!"),
        ).toBe(normalizeTaskText("speaker 1 draft THE page"));
    });
});
