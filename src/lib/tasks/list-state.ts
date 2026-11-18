import type { TaskListItem, TaskView } from "@/lib/tasks/tasks";
import type { RecordingFolder } from "@/types/folder";

/** The task list query a state belongs to; a new query starts a new state. */
export type TaskListScope = { query: string; state: string };

type Retention = { group?: RecordingFolder };

type TaskListRow = TaskListItem & { retainedGroup?: RecordingFolder };

/** One optimistic change to a task, pending until its save settles. */
export type TaskListPatch = {
    fields: Partial<TaskView>;
    retain?: Retention;
};

type TaskListState = {
    scope: TaskListScope;
    confirmed: TaskListItem[] | null;
    pending: ReadonlyMap<string, TaskListPatch[]>;
    retained: ReadonlyMap<string, Retention>;
    merging: ReadonlySet<string>;
    openIds: ReadonlySet<string> | null;
    error: boolean;
};

type Action = { scope: TaskListScope } & (
    | { type: "reset" | "loading" }
    | { type: "loadFailed"; inserts: TaskListItem[] }
    | {
          type: "loaded";
          rows: TaskListItem[];
          inserts: TaskListItem[];
          openRows: TaskListItem[] | null;
      }
    | { type: "patch"; id: string; patch: TaskListPatch }
    | {
          type: "settlePatch";
          id: string;
          patch: TaskListPatch;
          saved?: TaskView;
          matchesFolder?: (row: TaskView) => boolean;
      }
    | { type: "merge" | "mergeFailed" | "mergeSaved"; id: string }
    | { type: "insert"; row: TaskListItem }
    | { type: "reconcile"; id: string; row?: TaskListItem }
);

/** An empty list state for a query: nothing loaded, nothing pending or retained. */
export function createTaskListState(scope: TaskListScope): TaskListState {
    return {
        scope,
        confirmed: null,
        pending: new Map(),
        retained: new Map(),
        merging: new Set(),
        openIds: null,
        error: false,
    };
}

function retentionFor(state: TaskListState, id: string) {
    return (
        state.retained.get(id) ??
        state.pending.get(id)?.find((patch) => patch.retain)?.retain
    );
}

function replaceConfirmed(
    state: TaskListState,
    rows: TaskListItem[],
    inserts: TaskListItem[],
    openRows: TaskListItem[] | null,
) {
    const fresh = new Map(rows.map((row) => [row.id, row]));
    const remaining = new Map(
        [...inserts, ...rows].map((row) => [row.id, fresh.get(row.id) ?? row]),
    );
    const open = new Map(openRows?.map((row) => [row.id, row]));
    const before = new Map<string, TaskListItem[]>();
    let kept: TaskListItem[] = [];
    let lastNeighbor: string | undefined;
    for (const previous of state.confirmed ?? []) {
        const id = previous.id;
        let row = remaining.get(id);
        if (
            retentionFor(state, id) ||
            state.pending.has(id) ||
            state.merging.has(id)
        ) {
            const openRow = open.get(id);
            if (openRow && (!row || openRow.version > row.version))
                row = openRow;
            kept.push(row && row.version >= previous.version ? row : previous);
            remaining.delete(id);
        } else if (row) {
            if (row.version < previous.version) remaining.set(id, previous);
            if (kept.length) before.set(id, kept);
            kept = [];
            lastNeighbor = id;
        }
    }
    const ordered = [...remaining.values()].flatMap((row) => [
        ...(before.get(row.id) ?? []),
        row,
        ...(row.id === lastNeighbor ? kept : []),
    ]);
    return lastNeighbor ? ordered : [...kept, ...ordered];
}

function matchesQuery(
    row: TaskListItem,
    scope: TaskListScope,
    matchesFolder: (row: TaskView) => boolean,
): boolean {
    if (scope.state !== "all" && row.status !== scope.state) return false;
    if (!matchesFolder(row)) return false;
    const params = new URLSearchParams(scope.query);
    const assignee = params.get("assignee");
    if (assignee === "none" && row.assignee) return false;
    if (
        assignee &&
        assignee !== "none" &&
        row.assignee?.personId !== "" &&
        row.assignee?.personId !== assignee
    )
        return false;
    const due = params.get("due");
    const today = params.get("today");
    if (due === "none") return row.dueDate === null;
    if (!today || (due !== "overdue" && due !== "week")) return true;
    if (!row.dueDate) return false;
    if (due === "overdue") return row.dueDate < today;
    const end = new Date(`${today}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 7);
    return (
        row.dueDate >= today && row.dueDate <= end.toISOString().slice(0, 10)
    );
}

/**
 * Server-confirmed rows, per-task queues of optimistic patches and the rows
 * kept after a status change, for one query; actions of another query are ignored.
 */
export function taskListReducer(
    state: TaskListState,
    action: Action,
): TaskListState {
    if (action.type === "reset") return createTaskListState(action.scope);
    if (state.scope !== action.scope) return state;
    switch (action.type) {
        case "loading":
            return state.error ? { ...state, error: false } : state;
        case "loadFailed":
            return {
                ...state,
                error: true,
                confirmed: state.confirmed ?? action.inserts,
            };
        case "loaded": {
            const { rows, inserts, openRows } = action;
            return {
                ...state,
                confirmed: replaceConfirmed(state, rows, inserts, openRows),
                error: false,
                openIds: openRows && new Set(openRows.map((row) => row.id)),
            };
        }
        case "patch": {
            const { id, patch } = action;
            return {
                ...state,
                pending: new Map(state.pending).set(id, [
                    ...(state.pending.get(id) ?? []),
                    patch,
                ]),
            };
        }
        case "settlePatch": {
            const { id, patch, saved, matchesFolder } = action;
            const queue = state.pending.get(id);
            if (!queue?.includes(patch)) return state;
            const pending = new Map(state.pending);
            const remaining = queue.filter((entry) => entry !== patch);
            if (remaining.length) pending.set(id, remaining);
            else pending.delete(id);

            const retained = new Map(state.retained);
            if (saved && patch.retain && !retained.has(id))
                retained.set(id, patch.retain);
            const openIds = state.openIds && new Set(state.openIds);
            const confirmed =
                state.confirmed?.flatMap((previous) => {
                    if (previous.id !== id) return [previous];
                    const row =
                        saved && saved.version >= previous.version
                            ? { ...previous, ...saved }
                            : previous;
                    if (openIds && patch.retain) {
                        if (row.status === "open") openIds.add(id);
                        else openIds.delete(id);
                    }
                    const retaining = remaining.some((entry) => entry.retain);
                    if (
                        !saved &&
                        !retaining &&
                        retentionFor(state, id) &&
                        matchesFolder &&
                        !matchesQuery(row, state.scope, matchesFolder)
                    ) {
                        retained.delete(id);
                        return [];
                    }
                    if (
                        saved &&
                        !retaining &&
                        !retained.has(id) &&
                        matchesFolder &&
                        !matchesFolder(row) &&
                        !remaining.some(
                            (entry) => entry.fields.folder !== undefined,
                        )
                    )
                        return [];
                    return [row];
                }) ?? null;
            return { ...state, confirmed, pending, retained, openIds };
        }
        case "merge":
            return { ...state, merging: new Set(state.merging).add(action.id) };
        case "mergeFailed":
        case "mergeSaved": {
            const { id } = action;
            const merging = new Set(state.merging);
            merging.delete(id);
            if (action.type === "mergeFailed") return { ...state, merging };
            const pending = new Map(state.pending);
            const retained = new Map(state.retained);
            const openIds = state.openIds && new Set(state.openIds);
            pending.delete(id);
            retained.delete(id);
            openIds?.delete(id);
            return {
                ...state,
                confirmed:
                    state.confirmed?.filter((row) => row.id !== id) ?? null,
                pending,
                retained,
                merging,
                openIds,
            };
        }
        case "insert":
            return {
                ...state,
                confirmed: [action.row, ...(state.confirmed ?? [])],
            };
        case "reconcile": {
            const rows = (state.confirmed ?? []).filter(
                (row) => row.id !== action.id,
            );
            const inserted = action.row;
            if (!inserted)
                return { ...state, confirmed: state.confirmed && rows };
            const existing = rows.find((row) => row.id === inserted.id);
            return {
                ...state,
                confirmed: existing
                    ? rows.map((row) =>
                          row === existing && inserted.version > row.version
                              ? inserted
                              : row,
                      )
                    : [inserted, ...rows],
            };
        }
    }
}

/** The rows to render (confirmed rows with pending patches applied) and the open count. */
export function taskListView(
    state: TaskListState,
    ownMatchesFolder: (row: TaskListItem) => boolean,
) {
    const openIds = state.openIds && new Set(state.openIds);
    for (const id of state.merging) openIds?.delete(id);
    const tasks =
        state.confirmed?.flatMap<TaskListRow>((confirmed) => {
            if (state.merging.has(confirmed.id)) return [];
            const patches = state.pending.get(confirmed.id) ?? [];
            const row = patches.length
                ? Object.assign(
                      { ...confirmed },
                      ...patches.map(({ fields }) => fields),
                  )
                : confirmed;
            const retention = retentionFor(state, row.id);
            if (
                !retention &&
                patches.some((patch) => patch.fields.folder !== undefined) &&
                !ownMatchesFolder(row)
            )
                return [];
            if (openIds && retention) {
                if (row.status === "open") openIds.add(row.id);
                else openIds.delete(row.id);
            }
            return [
                retention?.group
                    ? { ...row, retainedGroup: retention.group }
                    : row,
            ];
        }) ?? null;
    const openCount =
        state.scope.state === "open" || state.scope.state === "all"
            ? (tasks?.filter((row) => row.status === "open").length ?? null)
            : (openIds?.size ?? null);
    return { tasks, openCount };
}
