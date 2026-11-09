import { vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        DATABASE_URL: "postgres://unused",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));

import { describe, expect, it } from "vitest";
import { replaceAgendaDescription } from "@/lib/integrations/google/calendar-events";
import {
    groupAgendaTasks,
    meetingOverlap,
    patchMeetingInput,
    validatePointTree,
} from "@/lib/meetings/model";

describe("meeting outline", () => {
    const points = [
        { id: "a", parentId: null, position: 0 },
        { id: "b", parentId: "a", position: 0 },
        { id: "c", parentId: "b", position: 0 },
    ];
    it("allows three levels", () =>
        expect(() => validatePointTree(points)).not.toThrow());
    it("refuses a fourth level", () =>
        expect(() =>
            validatePointTree([
                ...points,
                { id: "d", parentId: "c", position: 0 },
            ]),
        ).toThrow());
    it("refuses cycles including moved subtrees", () =>
        expect(() =>
            validatePointTree(
                points.map((point) =>
                    point.id === "a" ? { ...point, parentId: "c" } : point,
                ),
            ),
        ).toThrow());
    it("refuses a parent from a different agenda", () =>
        expect(() =>
            validatePointTree([{ id: "a", parentId: "foreign", position: 0 }]),
        ).toThrow());
});

describe("meeting window", () => {
    const time = (hour: number) => new Date(Date.UTC(2026, 10, 3, hour));
    it("uses half of either window", () =>
        expect(meetingOverlap(time(10), time(14), time(10), time(11))).toBe(
            3600000,
        ));
    it("accepts exactly half", () =>
        expect(meetingOverlap(time(10), time(12), time(11), time(13))).toBe(
            3600000,
        ));
    it("refuses shorter overlaps", () =>
        expect(meetingOverlap(time(10), time(13), time(12), time(15))).toBe(0));
    it("refuses touching or invalid intervals", () => {
        expect(meetingOverlap(time(10), time(11), time(11), time(12))).toBe(0);
        expect(meetingOverlap(time(10), time(10), time(10), time(11))).toBe(0);
    });
});

describe("task groups", () => {
    it("keeps invitee order, invitees without tasks, other assignees, and unassigned last", () => {
        const tasks = [
            { assignee: null, assigneeHint: null },
            { assignee: null, assigneeHint: null },
            { assignee: { name: "Marek Dvořák" }, assigneeHint: null },
            { assignee: { name: "Jitka Dvořáková" }, assigneeHint: null },
        ];
        const groups = groupAgendaTasks(tasks, [
            { name: "Jitka Dvořáková" },
            { name: "Acme" },
        ]);
        expect(
            groups.map((group) => [
                group.name,
                group.invited,
                group.tasks.length,
            ]),
        ).toEqual([
            ["Jitka Dvořáková", true, 1],
            ["Acme", true, 0],
            ["Marek Dvořák", false, 1],
            [null, false, 2],
        ]);
    });
});

describe("Calendar agenda block", () => {
    it("preserves the organizer's description", () =>
        expect(replaceAgendaDescription("Organizer text", "New agenda")).toBe(
            "Organizer text\n\n--- Agenda from Chatterbox ---\nNew agenda\n--- end of agenda ---",
        ));
    it("replaces English and Czech blocks on repeated export", () => {
        const original =
            "Before\n--- Agenda z Klepny ---\nOld\n--- konec agendy ---\nAfter";
        const first = replaceAgendaDescription(original, "New agenda");
        expect(first).toBe(
            "Before\n--- Agenda from Chatterbox ---\nNew agenda\n--- end of agenda ---\nAfter",
        );
        expect(replaceAgendaDescription(first, "Updated", "cs-CZ")).toBe(
            "Before\n--- Agenda z Klepny ---\nUpdated\n--- konec agendy ---\nAfter",
        );
    });
    it("replaces a block written under another deployment's product name", () =>
        expect(
            replaceAgendaDescription(
                "Before\n--- Agenda from Riffado ---\nOld\n--- end of agenda ---\nAfter",
                "New agenda",
            ),
        ).toBe(
            "Before\n--- Agenda from Chatterbox ---\nNew agenda\n--- end of agenda ---\nAfter",
        ));
});

describe("task source previous values", () => {
    it.each([
        [
            { taskSourceItemId: null },
            { taskSourceItemId: null },
            "noTaskSource",
        ],
        [{ noTaskSource: true }, { taskSourceItemId: null }, "noTaskSource"],
        [
            { taskSourceItemId: null },
            { noTaskSource: false },
            "taskSourceItemId",
        ],
        [{ noTaskSource: true }, { noTaskSource: false }, "taskSourceItemId"],
    ] as const)("requires both previous source values for %j with %j", (patch, previous, missing) => {
        const result = patchMeetingInput.safeParse({ ...patch, previous });
        expect(result.success).toBe(false);
        if (!result.success)
            expect(result.error.issues).toContainEqual(
                expect.objectContaining({
                    path: ["previous", missing],
                    message: "Previous value is required",
                }),
            );
    });

    it.each([
        { taskSourceItemId: null },
        { noTaskSource: true },
    ])("accepts a partial source patch %j with both previous values, including a null source", (patch) => {
        const input = {
            ...patch,
            previous: { taskSourceItemId: null, noTaskSource: false },
        };
        expect(patchMeetingInput.parse(input)).toEqual(input);
    });
});
