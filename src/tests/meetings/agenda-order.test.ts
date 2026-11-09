import { describe, expect, it, vi } from "vitest";
import {
    outlineDrop,
    outlineReorder,
    outlineRows,
} from "@/components/meetings/outline";
import { hasAgendaContributors } from "@/lib/meetings/attribution";
import { validatePointTree } from "@/lib/meetings/model";
import { moveAgendaPoint } from "@/lib/meetings/point-order";
import {
    agendaTaskGroupKey,
    groupAgendaTasks,
    mergeAgendaTaskGroupOrder,
    projectAgendaTaskGroupOrder,
} from "@/lib/meetings/task-groups";
import { detail, point, task } from "./ui-fixtures";

vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

const invited = [{ name: "Jitka Dvořáková" }];
const tasks = [
    task("other", "Martin Král", { position: 8 }),
    task("unassigned", null, { position: 7 }),
    task("first", "Jitka Dvořáková", { position: 2 }),
    task("second", "Jitka Dvořáková", { position: 1 }),
];
it("uses normalized assignee names and a distinct fixed unassigned key", () => {
    expect(agendaTaskGroupKey("  Jitka Dvořáková  ")).toBe("jitka dvořáková");
    expect(agendaTaskGroupKey("ＭＡＲＴＩＮ")).toBe("martin");
    expect(agendaTaskGroupKey(null)).not.toBe(agendaTaskGroupKey("unassigned"));
});
it.each([
    undefined,
    [],
])("retains today's group order without a stored order %j", (order) => {
    expect(
        groupAgendaTasks(tasks, invited, order).map((group) => group.name),
    ).toEqual(["Jitka Dvořáková", "Martin Král", null]);
});
it("applies known stored keys before missing and new groups, ignoring unknown keys", () => {
    const groups = groupAgendaTasks(
        tasks,
        [...invited, { name: "New invitee" }],
        ["missing", agendaTaskGroupKey(null), "martin král"],
    );
    expect(groups.map((group) => group.name)).toEqual([
        null,
        "Martin Král",
        "Jitka Dvořáková",
        "New invitee",
    ]);
    expect(groups[2].tasks.map((task) => task.id)).toEqual(["second", "first"]);
});
describe("contributor attribution", () => {
    it("stays off for owner-only content and another person's status changes", () => {
        expect(
            hasAgendaContributors(
                detail({
                    points: [point("Owner", { updatedByUserId: "owner" })],
                    tasks: [
                        task("Task", null, {
                            agendaUpdatedByUserId: "owner",
                            statusChangedByUserId: "colleague",
                        }),
                    ],
                }),
            ),
        ).toBe(false);
    });
    it.each([
        "author",
        "editor",
        "subpoint",
        "task",
    ])("turns on for a colleague's %s contribution", (kind) => {
        expect(
            hasAgendaContributors(
                detail({
                    points: [
                        point("Root", {
                            authorUserId:
                                kind === "author" ? "colleague" : "owner",
                            updatedByUserId:
                                kind === "editor" ? "colleague" : "owner",
                        }),
                        ...(kind === "subpoint"
                            ? [
                                  point("Child", {
                                      parentId: "Root",
                                      authorUserId: "colleague",
                                  }),
                              ]
                            : []),
                    ],
                    tasks: [
                        task("Task", null, {
                            agendaUpdatedByUserId:
                                kind === "task" ? "colleague" : null,
                        }),
                    ],
                }),
            ),
        ).toBe(true);
    });
});
const points = [
    point("First", { position: 0 }),
    point("Child", { parentId: "First", position: 1 }),
    point("Grandchild", { parentId: "Child", position: 2 }),
    point("Second", { position: 3 }),
    point("Third", { position: 4 }),
];
function apply(
    id: string,
    move: { parentId: string | null; siblingIndex: number } | null,
) {
    if (!move) throw new Error("Expected move");
    const next = moveAgendaPoint(points, id, move.parentId, move.siblingIndex);
    if (!next) throw new Error("Expected valid move");
    validatePointTree(next);
    return outlineRows(next).map((row) => row.point.id);
}
it("moves a point down and up together with its sub-points", () => {
    expect(apply("First", outlineReorder(points, "First", 1))).toEqual([
        "Second",
        "First",
        "Child",
        "Grandchild",
        "Third",
    ]);
    expect(apply("Second", outlineReorder(points, "Second", -1))).toEqual([
        "Second",
        "First",
        "Child",
        "Grandchild",
        "Third",
    ]);
    expect(outlineReorder(points, "First", -1)).toBeNull();
});
it("drops a whole subtree and refuses fourth levels and descendant targets", () => {
    expect(
        apply("First", outlineDrop(points, "First", "Third", true, 0)),
    ).toEqual(["Second", "Third", "First", "Child", "Grandchild"]);
    expect(outlineDrop(points, "First", "Second", true, 1)).toBeNull();
    expect(outlineDrop(points, "First", "Child", true, 0)).toBeNull();
    expect(outlineDrop(points, "First", "Grandchild", false, 2)).toBeNull();
});
it("uses horizontal drop depth to select a valid parent", () => {
    expect(outlineDrop(points, "Third", "Second", true, 1)).toEqual({
        parentId: "Second",
        siblingIndex: 0,
    });
});

it.each([
    0, 99999,
])("moves exactly one sibling with positions starting at %s", (position) => {
    const tied = [
        point("A", { position }),
        point("B", { position: position === 0 ? 0 : 100000 }),
        point("C", { position: position === 0 ? 0 : 100000 }),
    ];
    const move = outlineReorder(tied, "A", 1);
    expect(move).toEqual({ parentId: null, siblingIndex: 1 });
    const next = moveAgendaPoint(tied, "A", null, 1);
    expect(outlineRows(next ?? []).map((row) => row.point.id)).toEqual([
        "B",
        "A",
        "C",
    ]);
    expect(next?.every((point) => point.position <= 100000)).toBe(true);
    expect(outlineDrop(tied, "A", "C", true, 0)).toEqual({
        parentId: null,
        siblingIndex: 2,
    });
});
it("renumbers both sibling lists while retaining descendant links", () => {
    const next = moveAgendaPoint(points, "Child", "Second", 0);
    expect(next?.find((point) => point.id === "Grandchild")?.parentId).toBe(
        "Child",
    );
    expect(next?.find((point) => point.id === "Child")).toMatchObject({
        parentId: "Second",
        position: 0,
    });
    expect(moveAgendaPoint(points, "First", null, 99)).toBeNull();
});
it("projects invitees and preserves hidden slots when visible group keys exchange places", () => {
    const stored = ["hidden-first", "a", "hidden-middle", "b", "hidden-last"];
    expect(
        projectAgendaTaskGroupOrder(stored, [{ name: "A" }, { name: "B" }]),
    ).toEqual(["a", "b"]);
    expect(
        mergeAgendaTaskGroupOrder(stored, ["b", "a", "new-invitee"]),
    ).toEqual([
        "hidden-first",
        "b",
        "hidden-middle",
        "a",
        "hidden-last",
        "new-invitee",
    ]);
});
