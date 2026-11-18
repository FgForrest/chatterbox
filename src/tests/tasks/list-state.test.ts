import { describe, expect, it } from "vitest";
import {
    createTaskListState,
    type TaskListPatch,
    type TaskListScope,
    taskListReducer,
    taskListView,
} from "@/lib/tasks/list-state";
import type { TaskListItem } from "@/lib/tasks/tasks";
import type { RecordingFolder } from "@/types/folder";

const task: TaskListItem = {
    id: "draft",
    text: "Send the draft",
    recordingId: null,
    evidenceItemId: null,
    evidenceItemKind: "audio",
    evidenceAudioAvailable: false,
    status: "open",
    assignee: null,
    assigneeHasEmail: false,
    assigneeHint: null,
    assigneeCheck: false,
    dueDate: null,
    duePhrase: null,
    quote: null,
    evidenceStartMs: null,
    evidenceText: null,
    evidenceProvenance: null,
    source: "personal",
    own: true,
    note: null,
    noteBy: null,
    noteUpdatedAt: null,
    following: false,
    automaticFollow: false,
    canFollow: false,
    canMerge: true,
    canEdit: true,
    canClose: true,
    canUndoMatch: false,
    ticked: true,
    version: 1,
    createdAt: "2026-10-28T10:00:00Z",
    acceptedAt: null,
    statusChangedAt: null,
    recording: null,
    evidence: null,
    visibleMentionQuotes: [],
};
const before = { ...task, id: "before" };
const after = { ...task, id: "after" };
const saved = { ...task, status: "done", version: 2 } as const;
const group: RecordingFolder = {
    id: "projects",
    parentId: null,
    name: "Projects",
    kind: "custom",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};
const done: TaskListPatch = { fields: { status: "done" }, retain: { group } };
const reopen: TaskListPatch = { fields: { status: "open" }, retain: {} };
const note: TaskListPatch = { fields: { note: "A note" } };
const moveDue: TaskListPatch = { fields: { dueDate: "2026-11-09" } };
const openScope = { query: "state=open", state: "open" };
const matchesFolder = () => true;

type WithoutScope<T> = T extends { scope: TaskListScope }
    ? Omit<T, "scope">
    : never;
type Action = WithoutScope<Parameters<typeof taskListReducer>[1]>;

function setup(scope = openScope) {
    let state = createTaskListState(scope);
    const send = (action: Action) => {
        state = taskListReducer(state, { ...action, scope });
    };
    return {
        send,
        get state() {
            return state;
        },
        load: (rows: TaskListItem[], openRows: TaskListItem[] | null = null) =>
            send({ type: "loaded", rows, openRows, inserts: [] }),
        view: () => taskListView(state, matchesFolder),
    };
}

describe("task list reducer", () => {
    it("settles only the acknowledged patch before any reload and preserves order and group", () => {
        const { load, send, view } = setup();
        load([before, task, after]);
        send({ type: "patch", id: task.id, patch: done });
        send({ type: "patch", id: task.id, patch: reopen });
        send({ type: "settlePatch", id: task.id, patch: done, saved });
        expect(view()).toEqual({
            tasks: [
                before,
                { ...saved, status: "open", retainedGroup: group },
                after,
            ],
            openCount: 3,
        });

        load([before, after, saved]);
        expect(view()).toEqual({
            tasks: [
                before,
                { ...saved, status: "open", retainedGroup: group },
                after,
            ],
            openCount: 3,
        });
        send({ type: "settlePatch", id: task.id, patch: reopen });
        expect(view()).toEqual({ tasks: [before, saved, after], openCount: 2 });
    });

    it("keeps the latest version and refreshes equal-version list metadata in the retained group", () => {
        const { load, send, view } = setup();
        load([before, task, after]);
        send({ type: "patch", id: task.id, patch: done });
        send({ type: "settlePatch", id: task.id, patch: done, saved });
        load([before, after, task]);
        expect(view().tasks).toEqual([
            before,
            { ...saved, retainedGroup: group },
            after,
        ]);

        const fresh = {
            ...saved,
            following: true,
            folder: {
                id: "new-folder",
                name: "New folder",
                path: "New folder",
            },
        };
        load([before, after, fresh]);
        expect(view().tasks).toEqual([
            before,
            { ...fresh, retainedGroup: group },
            after,
        ]);
    });

    it("accepts a higher version from the auxiliary Open response even if the main list has the row", () => {
        const { load, send, view } = setup({
            query: "state=done",
            state: "done",
        });
        load([saved], []);
        send({ type: "patch", id: task.id, patch: reopen });
        const reopened = { ...task, version: 3 };
        send({
            type: "settlePatch",
            id: task.id,
            patch: reopen,
            saved: reopened,
        });
        const fresh = { ...reopened, version: 4, following: true };
        load([saved], [fresh]);
        load([], []);
        expect(view()).toEqual({ tasks: [fresh], openCount: 0 });
    });

    it("removes an omitted row after its last non-status patch settles", () => {
        const { load, send, view } = setup({
            query: "state=open&due=week&today=2026-10-28",
            state: "open",
        });
        load([before, task, after]);
        send({ type: "patch", id: task.id, patch: moveDue });
        send({ type: "patch", id: task.id, patch: note });
        load([before, after]);
        const moved = { ...task, ...moveDue.fields, version: 2 };
        send({
            type: "settlePatch",
            id: task.id,
            patch: moveDue,
            saved: moved,
        });
        expect(view()).toEqual({
            tasks: [before, { ...moved, ...note.fields }, after],
            openCount: 3,
        });
        send({
            type: "settlePatch",
            id: task.id,
            patch: note,
            saved: { ...moved, ...note.fields, version: 3 },
        });
        expect(view()).toEqual({ tasks: [before, after], openCount: 2 });
    });

    it.each([
        false,
        true,
    ])("restores a failed merge source according to its latest membership (listed=%s)", (listed) => {
        const { load, send, view } = setup();
        load([task, after]);
        send({ type: "merge", id: task.id });
        send({ type: "patch", id: after.id, patch: note });
        load(listed ? [task, after] : [after]);
        send({ type: "mergeFailed", id: task.id });
        const edited = { ...after, ...note.fields };
        expect(view()).toEqual({
            tasks: listed ? [task, edited] : [edited],
            openCount: listed ? 2 : 1,
        });
    });

    it.each([
        false,
        true,
    ])("displays the rolled-back row through a failed reload, then follows the server (listed=%s)", (listed) => {
        const { load, send, view } = setup({
            query: "state=open&tab=followed&folder=projects&assignee=selected&due=week&today=2026-10-28",
            state: "open",
        });
        const previous = {
            ...task,
            assignee: { personId: "", name: "Jitka Dvořáková" },
            dueDate: "2026-11-04",
        };
        load([previous]);
        send({ type: "patch", id: task.id, patch: done });
        send({
            type: "settlePatch",
            id: task.id,
            patch: done,
            saved: { ...previous, status: "done", version: 2 },
        });
        send({ type: "patch", id: task.id, patch: reopen });
        const fresh = { ...previous, version: 3 };
        send({ type: "settlePatch", id: task.id, patch: reopen, saved: fresh });
        load([]);
        send({ type: "patch", id: task.id, patch: done });
        send({ type: "settlePatch", id: task.id, patch: done });
        expect(view()).toEqual({ tasks: [fresh], openCount: 1 });
        send({ type: "loadFailed" });
        expect(view()).toEqual({ tasks: [fresh], openCount: 1 });
        const edited = { ...fresh, ...note.fields, version: 4 };
        send({ type: "patch", id: task.id, patch: note });
        send({ type: "settlePatch", id: task.id, patch: note, saved: edited });
        expect(view()).toEqual({ tasks: [edited], openCount: 1 });
        load(listed ? [edited] : []);
        expect(view()).toEqual({
            tasks: listed ? [edited] : [],
            openCount: listed ? 1 : 0,
        });
    });

    it.each([
        "done",
        "dropped",
    ] as const)("counts a reopen once in %s and trusts the next Open snapshot after reassignment", (status) => {
        const { load, send, view } = setup({
            query: `state=${status}&assignee=selected`,
            state: status,
        });
        const closed = { ...saved, status };
        load([closed], [before]);
        send({ type: "patch", id: task.id, patch: reopen });
        expect(view().openCount).toBe(2);
        const reopened = { ...task, version: 3 };
        load([], [before, reopened]);
        expect(view().openCount).toBe(2);
        send({
            type: "settlePatch",
            id: task.id,
            patch: reopen,
            saved: reopened,
        });
        load([], [before, reopened]);
        expect(view().openCount).toBe(2);

        const assignee = { personId: "other", name: "Petr Bureš" };
        const reassign = { fields: { assignee } };
        const reassigned = { ...reopened, assignee, version: 4 };
        send({ type: "patch", id: task.id, patch: reassign });
        send({
            type: "settlePatch",
            id: task.id,
            patch: reassign,
            saved: reassigned,
        });
        load([], [before]);
        expect(view()).toEqual({ tasks: [reassigned], openCount: 1 });
        send({ type: "patch", id: task.id, patch: done });
        send({ type: "settlePatch", id: task.id, patch: done });
        expect(view()).toEqual({ tasks: [reassigned], openCount: 1 });
    });

    it.each([
        false,
        true,
    ])("cleans up the actual deleted row and preserves the survivor's pending edit (source survives=%s)", (sourceSurvives) => {
        const { load, send, view } = setup();
        load([before, task, after]);
        send({ type: "patch", id: task.id, patch: done });
        send({ type: "settlePatch", id: task.id, patch: done, saved });
        send({ type: "patch", id: task.id, patch: reopen });
        const recovered = { ...task, version: 3 };
        send({
            type: "settlePatch",
            id: task.id,
            patch: reopen,
            saved: recovered,
        });
        send({ type: "patch", id: task.id, patch: moveDue });
        send({ type: "patch", id: after.id, patch: note });
        const survivor = { ...after, text: "Combined draft", version: 4 };
        const id = sourceSurvives ? after.id : task.id;
        send({ type: "merge", id });
        send({ type: "mergeSaved", id, deletedId: task.id, survivor });

        const expected = {
            tasks: [before, { ...survivor, ...note.fields }],
            openCount: 2,
        };
        expect(view()).toEqual(expected);
        send({
            type: "settlePatch",
            id: task.id,
            patch: moveDue,
            saved: recovered,
        });
        load([before, { ...after, version: 2 }]);
        expect(view()).toEqual(expected);
    });

    it("reconciles an insert already loaded at a higher version once and keeps it on omission", () => {
        const { load, send, view } = setup();
        load([]);
        const temporary = { ...task, id: "temporary", version: 0 };
        send({ type: "insert", row: temporary });
        const fresh = { ...task, version: 2 };
        send({
            type: "loaded",
            rows: [fresh],
            inserts: [temporary],
            openRows: null,
        });
        send({ type: "reconcile", id: temporary.id, row: task });
        expect(view()).toEqual({ tasks: [fresh], openCount: 1 });
        send({ type: "loaded", rows: [], inserts: [task], openRows: null });
        expect(view()).toEqual({ tasks: [fresh], openCount: 1 });
    });

    it("removes a failed insert and ignores reconciliation and reload from an earlier query visit", () => {
        const list = setup();
        list.send({ type: "insert", row: task });
        list.send({ type: "reconcile", id: task.id });
        expect(list.view()).toEqual({ tasks: [], openCount: 0 });
        list.send({ type: "insert", row: task });
        const reset = taskListReducer(list.state, {
            type: "reset",
            scope: { ...openScope },
        });
        expect(
            taskListReducer(reset, {
                type: "reconcile",
                scope: openScope,
                id: task.id,
                row: saved,
            }),
        ).toBe(reset);
        expect(
            taskListReducer(reset, {
                type: "loaded",
                scope: openScope,
                rows: [task],
                openRows: null,
                inserts: [],
            }),
        ).toBe(reset);
    });

    it("rolls back to the freshest confirmed row after reapplying a pending patch", () => {
        const { load, send, view } = setup();
        load([task]);
        send({ type: "patch", id: task.id, patch: done });
        const fresh = { ...task, version: 2, note: "A confirmed note" };
        load([fresh]);
        expect(view().tasks).toEqual([
            { ...fresh, status: "done", retainedGroup: group },
        ]);
        send({ type: "settlePatch", id: task.id, patch: done });
        expect(view()).toEqual({ tasks: [fresh], openCount: 1 });
    });
});
