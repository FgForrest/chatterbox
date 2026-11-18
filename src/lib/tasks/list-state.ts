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
    members: ReadonlySet<string>;
    pending: ReadonlyMap<string, TaskListPatch[]>;
    retained: ReadonlyMap<string, Retention>;
    merging: ReadonlySet<string>;
    openIds: ReadonlySet<string> | null;
    error: boolean;
};

type Action = { scope: TaskListScope } & (
    | { type: "reset" | "loading" }
    | { type: "loadFailed" }
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
      }
    | { type: "merge"; id: string }
    | { type: "mergeFailed"; id: string }
    | { type: "mergeSaved"; id: string; deletedId: string; survivor: TaskView }
    | { type: "insert"; row: TaskListItem }
    | { type: "reconcile"; id: string; row?: TaskListItem }
);

/** An empty list state for a query: nothing loaded, nothing pending or retained. */
export function createTaskListState(scope: TaskListScope): TaskListState {
    return {
        scope,
        confirmed: null,
        members: new Set(),
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

function carried(state: TaskListState, id: string) {
    return (
        state.retained.has(id) || state.pending.has(id) || state.merging.has(id)
    );
}

function replaceConfirmed(
    state: TaskListState,
    rows: TaskListItem[],
    inserts: TaskListItem[],
    openRows: TaskListItem[] | null,
) {
    const remaining = new Map(inserts.map((row) => [row.id, row]));
    const listed = new Set(rows.map((row) => row.id));
    const open = new Map(openRows?.map((row) => [row.id, row]));
    for (const row of rows) {
        const openRow = open.get(row.id);
        remaining.set(
            row.id,
            openRow && openRow.version > row.version ? openRow : row,
        );
    }
    const before = new Map<string, TaskListItem[]>();
    let kept: TaskListItem[] = [];
    let lastNeighbor: string | undefined;
    for (const previous of state.confirmed ?? []) {
        const id = previous.id;
        const keptInPlace = carried(state, id);
        const cached = remaining.get(id);
        if (!cached && !keptInPlace) continue;
        const fresh = listed.has(id) ? cached : open.get(id);
        const confirmed =
            fresh && fresh.version >= previous.version ? fresh : previous;
        const row =
            cached && cached.version > confirmed.version ? cached : confirmed;
        if (keptInPlace) {
            kept.push(row);
            remaining.delete(id);
        } else {
            remaining.set(id, row);
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

function setOpen(ids: Set<string>, row: TaskView) {
    if (row.status === "open") ids.add(row.id);
    else ids.delete(row.id);
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
                confirmed: state.confirmed ?? [],
            };
        case "loaded": {
            const { rows, inserts, openRows } = action;
            return {
                ...state,
                confirmed: replaceConfirmed(state, rows, inserts, openRows),
                members: new Set([...rows, ...inserts].map((row) => row.id)),
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
            const { id, patch, saved } = action;
            const queue = state.pending.get(id);
            if (!queue?.includes(patch)) return state;
            const pending = new Map(state.pending);
            const remaining = queue.filter((entry) => entry !== patch);
            if (remaining.length) pending.set(id, remaining);
            else pending.delete(id);

            const retained = new Map(state.retained);
            if (saved && patch.retain && !retained.has(id))
                retained.set(id, patch.retain);
            if (!saved) retained.delete(id);
            const next = { ...state, pending, retained };
            if (!saved && retentionFor(state, id))
                next.members = new Set(state.members).add(id);
            const keep = next.members.has(id) || carried(next, id);
            next.confirmed =
                state.confirmed?.flatMap((previous) => {
                    if (previous.id !== id) return [previous];
                    if (!keep) return [];
                    const row =
                        saved && saved.version >= previous.version
                            ? { ...previous, ...saved }
                            : previous;
                    if (saved && patch.retain && next.openIds) {
                        const adjusted = new Set(next.openIds);
                        setOpen(adjusted, row);
                        next.openIds = adjusted;
                    }
                    return [row];
                }) ?? null;
            return next;
        }
        case "merge":
            return { ...state, merging: new Set(state.merging).add(action.id) };
        case "mergeFailed":
        case "mergeSaved": {
            const { id } = action;
            const merging = new Set(state.merging);
            merging.delete(id);
            if (action.type === "mergeFailed") {
                const next = { ...state, merging };
                if (!state.members.has(id) && !carried(next, id))
                    next.confirmed =
                        state.confirmed?.filter((row) => row.id !== id) ?? null;
                return next;
            }
            const { deletedId, survivor } = action;
            const members = new Set(state.members);
            const pending = new Map(state.pending);
            const retained = new Map(state.retained);
            const openIds = state.openIds && new Set(state.openIds);
            members.delete(deletedId);
            merging.delete(deletedId);
            pending.delete(deletedId);
            retained.delete(deletedId);
            openIds?.delete(deletedId);
            return {
                ...state,
                confirmed:
                    state.confirmed?.flatMap((row) => {
                        if (row.id === deletedId) return [];
                        if (
                            row.id === survivor.id &&
                            survivor.version >= row.version
                        )
                            return [{ ...row, ...survivor }];
                        return [row];
                    }) ?? null,
                members,
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
                members: new Set(state.members).add(action.row.id),
            };
        case "reconcile": {
            const rows = (state.confirmed ?? []).filter(
                (row) => row.id !== action.id,
            );
            const members = new Set(state.members);
            members.delete(action.id);
            const inserted = action.row;
            if (!inserted)
                return {
                    ...state,
                    confirmed: state.confirmed && rows,
                    members,
                };
            const existing = rows.find((row) => row.id === inserted.id);
            return {
                ...state,
                members: members.add(inserted.id),
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
            if (openIds && patches.some((patch) => patch.retain))
                setOpen(openIds, row);
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
