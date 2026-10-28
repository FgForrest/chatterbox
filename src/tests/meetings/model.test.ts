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
