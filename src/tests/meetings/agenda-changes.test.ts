import { describe, expect, it } from "vitest";
import { hasColleagueAgendaChange } from "@/components/meetings/agenda-changes";
import type { MeetingPoint, MeetingTask } from "@/components/meetings/types";
import { at, detail, point, task } from "./ui-fixtures";

describe("hasColleagueAgendaChange", () => {
    it.each([
        undefined,
        "",
    ])("stays silent without a viewer id (%s)", (userId) => {
        expect(
            hasColleagueAgendaChange(
                detail(),
                detail({
                    points: [point("New", { authorUserId: "colleague" })],
                }),
                userId,
            ),
        ).toBe(false);
    });

    it.each<{
        name: string;
        before?: Partial<MeetingPoint>;
        after: Partial<MeetingPoint>;
        added?: boolean;
        expected: boolean;
    }>([
        {
            name: "colleague text edit",
            after: { text: "Edited", version: 1, updatedByUserId: "colleague" },
            expected: true,
        },
        {
            name: "colleague note edit",
            after: { note: "Note", version: 1, updatedByUserId: "colleague" },
            expected: true,
        },
        {
            name: "colleague reparent",
            after: {
                parentId: "Parent",
                version: 1,
                updatedByUserId: "colleague",
            },
            expected: true,
        },
        {
            name: "colleague reorder without a point version bump",
            after: { position: 1, updatedByUserId: "colleague" },
            expected: true,
        },
        {
            name: "own edit, including another tab",
            after: { text: "Edited", version: 1, updatedByUserId: "owner" },
            expected: false,
        },
        {
            name: "system edit does not fall back to the original author",
            before: { authorUserId: "colleague" },
            after: {
                text: "Edited",
                version: 1,
                authorUserId: "colleague",
                updatedByUserId: null,
            },
            expected: false,
        },
        {
            name: "unchanged row with a colleague editor",
            after: { updatedByUserId: "colleague" },
            expected: false,
        },
        {
            name: "discussion attribution without a newer point version",
            after: { discussedAt: at, discussedByUserId: "colleague" },
            expected: true,
        },
        {
            name: "version bump alone with a colleague editor",
            after: { version: 1, updatedByUserId: "colleague" },
            expected: false,
        },
        {
            name: "older row version alone",
            before: { version: 2 },
            after: { version: 1, updatedByUserId: "colleague" },
            expected: false,
        },
        {
            name: "new colleague point uses its author",
            added: true,
            after: { authorUserId: "colleague" },
            expected: true,
        },
        {
            name: "new point prefers its last editor",
            added: true,
            after: { authorUserId: "colleague", updatedByUserId: "owner" },
            expected: false,
        },
        {
            name: "new point edited by a colleague",
            added: true,
            after: { authorUserId: "owner", updatedByUserId: "colleague" },
            expected: true,
        },
        {
            name: "new own point",
            added: true,
            after: { authorUserId: "owner" },
            expected: false,
        },
        {
            name: "new system point",
            added: true,
            after: { authorUserId: null, updatedByUserId: null },
            expected: false,
        },
        {
            name: "colleague discussed the point",
            after: {
                version: 1,
                discussedAt: at,
                discussedByUserId: "colleague",
                updatedByUserId: "owner",
            },
            expected: true,
        },
        {
            name: "own discuss toggle bundled with a colleague text edit",
            after: {
                version: 2,
                text: "Edited",
                discussedAt: at,
                discussedByUserId: "owner",
                updatedByUserId: "colleague",
            },
            expected: true,
        },
        {
            name: "viewer discussed a colleague's point",
            after: {
                version: 1,
                discussedAt: at,
                discussedByUserId: "owner",
                updatedByUserId: "colleague",
            },
            expected: false,
        },
        {
            name: "discussion falls back to its colleague editor",
            after: {
                version: 1,
                discussedAt: at,
                discussedByUserId: null,
                updatedByUserId: "colleague",
            },
            expected: true,
        },
        {
            name: "viewer undiscuss ignores old colleague discussion attribution",
            before: { discussedAt: at, discussedByUserId: "colleague" },
            after: {
                version: 1,
                discussedAt: null,
                discussedByUserId: "colleague",
                updatedByUserId: "owner",
            },
            expected: false,
        },
        {
            name: "colleague undiscussed the point with updatedByUserId set",
            before: { discussedAt: at, discussedByUserId: "owner" },
            after: {
                version: 1,
                discussedAt: null,
                discussedByUserId: null,
                updatedByUserId: "colleague",
            },
            expected: true,
        },
        {
            name: "system undiscuss without an editor",
            before: { discussedAt: at, discussedByUserId: "colleague" },
            after: { version: 1, discussedAt: null, updatedByUserId: null },
            expected: false,
        },
        {
            name: "discussion timestamp change keeps the same discussed state",
            before: { discussedAt: at },
            after: {
                version: 1,
                discussedAt: "2026-11-03T10:01:00.000Z",
                discussedByUserId: "colleague",
                updatedByUserId: "colleague",
            },
            expected: false,
        },
        {
            name: "old discussion attribution does not identify a new text edit",
            before: { discussedAt: at, discussedByUserId: "colleague" },
            after: {
                text: "Edited",
                version: 1,
                discussedAt: at,
                discussedByUserId: "colleague",
                updatedByUserId: "owner",
            },
            expected: false,
        },
    ])("point: $name", ({ before, after, added, expected }) => {
        expect(
            hasColleagueAgendaChange(
                detail({ points: added ? [] : [point("Point", before)] }),
                detail({ points: [point("Point", after)] }),
                "owner",
            ),
        ).toBe(expected);
    });

    it("ignores lifecycle-style version bumps that only clear summary outcomes with colleague editors", () => {
        const points = ["First", "Second"].map((id) =>
            point(id, {
                summaryOutcome: "covered",
                updatedByUserId: "colleague",
            }),
        );
        expect(
            hasColleagueAgendaChange(
                detail({ points }),
                detail({
                    version: 2,
                    points: points.map((entry) => ({
                        ...entry,
                        version: entry.version + 1,
                        summaryOutcome: null,
                    })),
                }),
                "owner",
            ),
        ).toBe(false);
    });

    it("detects mergeUp reparenting with stale colleague editors: accepted false notice when the viewer edits in another tab", () => {
        const children = ["First", "Second"].map((id) =>
            point(id, { parentId: "Parent", updatedByUserId: "colleague" }),
        );
        expect(
            hasColleagueAgendaChange(
                detail({ points: [point("Parent"), ...children] }),
                detail({
                    points: children.map((entry) => ({
                        ...entry,
                        parentId: null,
                        version: entry.version + 1,
                    })),
                }),
                "owner",
            ),
        ).toBe(true);
    });

    it.each<{
        name: string;
        before?: Partial<MeetingTask>;
        after: Partial<MeetingTask>;
        added?: boolean;
        expected: boolean;
    }>([
        {
            name: "colleague agenda note edit",
            after: { agendaVersion: 1, agendaUpdatedByUserId: "colleague" },
            expected: true,
        },
        {
            name: "own agenda edit",
            after: { agendaVersion: 1, agendaUpdatedByUserId: "owner" },
            expected: false,
        },
        {
            name: "system agenda edit",
            after: { agendaVersion: 1, agendaUpdatedByUserId: null },
            expected: false,
        },
        {
            name: "unchanged agenda version with an old editor",
            after: { agendaUpdatedByUserId: "colleague" },
            expected: false,
        },
        {
            name: "new colleague task",
            added: true,
            after: { agendaUpdatedByUserId: "colleague" },
            expected: true,
        },
        {
            name: "new own task",
            added: true,
            after: { agendaUpdatedByUserId: "owner" },
            expected: false,
        },
        {
            name: "new system task with an earlier status editor",
            added: true,
            after: { status: "done", statusChangedByUserId: "colleague" },
            expected: false,
        },
        {
            name: "colleague status edit without an agenda version bump",
            after: { status: "done", statusChangedByUserId: "colleague" },
            expected: true,
        },
        {
            name: "own status edit",
            after: { status: "done", statusChangedByUserId: "owner" },
            expected: false,
        },
        {
            name: "system status edit",
            after: { status: "done", statusChangedByUserId: null },
            expected: false,
        },
        {
            name: "unchanged status with an old editor",
            after: { statusChangedByUserId: "colleague" },
            expected: false,
        },
        {
            name: "own agenda edit alongside a colleague status edit",
            after: {
                agendaVersion: 1,
                agendaUpdatedByUserId: "owner",
                status: "done",
                statusChangedByUserId: "colleague",
            },
            expected: true,
        },
        {
            name: "colleague agenda edit alongside an own status edit",
            after: {
                agendaVersion: 1,
                agendaUpdatedByUserId: "colleague",
                status: "done",
                statusChangedByUserId: "owner",
            },
            expected: true,
        },
        {
            name: "removed task",
            after: {
                removedAt: at,
                agendaVersion: 1,
                agendaUpdatedByUserId: "colleague",
                status: "done",
                statusChangedByUserId: "colleague",
            },
            expected: false,
        },
        {
            name: "task version alone",
            after: { version: 1, agendaUpdatedByUserId: "colleague" },
            expected: false,
        },
        {
            name: "older agenda version",
            before: { agendaVersion: 2 },
            after: { agendaVersion: 1, agendaUpdatedByUserId: "colleague" },
            expected: false,
        },
    ])("task: $name", ({ before, after, added, expected }) => {
        expect(
            hasColleagueAgendaChange(
                detail({ tasks: added ? [] : [task("Task", null, before)] }),
                detail({ tasks: [task("Task", null, after)] }),
                "owner",
            ),
        ).toBe(expected);
    });

    it("ignores deleted rows and agenda-level changes", () => {
        expect(
            hasColleagueAgendaChange(
                detail({ tasks: [task("Task", null)] }),
                detail({
                    version: 2,
                    title: "Updated calendar title",
                    state: "live",
                    points: [],
                    tasks: [],
                }),
                "owner",
            ),
        ).toBe(false);
    });
});
