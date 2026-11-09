/** Stable group identity shared by the server and agenda clients. */
export function agendaTaskGroupKey(name: string | null): string {
    return name
        ? name.normalize("NFKC").trim().toLocaleLowerCase()
        : "\u0000unassigned";
}

/** Apply stored group order before the default invitee order, sorting tasks by agenda position. */
export function groupAgendaTasks<
    T extends {
        assignee: { name: string } | null;
        assigneeHint: string | null;
        position?: number;
    },
>(
    tasks: readonly T[],
    invitees: readonly { name: string }[],
    order: readonly string[] = [],
) {
    const key = agendaTaskGroupKey;
    const groups: { name: string | null; invited: boolean; tasks: T[] }[] = [];
    for (const invitee of invitees)
        if (
            invitee.name.trim() &&
            !groups.some(
                (group) => group.name && key(group.name) === key(invitee.name),
            )
        )
            groups.push({ name: invitee.name, invited: true, tasks: [] });
    for (const task of tasks) {
        const name = task.assignee?.name ?? task.assigneeHint;
        let group = groups.find((group) =>
            name
                ? group.name !== null && key(group.name) === key(name)
                : group.name === null,
        );
        if (!group) {
            group = { name: name || null, invited: false, tasks: [] };
            const unassigned = groups.findIndex((entry) => entry.name === null);
            if (name && unassigned >= 0) groups.splice(unassigned, 0, group);
            else groups.push(group);
        }
        group.tasks.push(task);
    }
    for (const group of groups)
        group.tasks.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const rank = new Map(order.map((key, index) => [key, index]));
    return groups.sort(
        (a, b) =>
            (rank.get(key(a.name)) ?? Infinity) -
            (rank.get(key(b.name)) ?? Infinity),
    );
}

/** Expose stored keys only for groups in the viewer's response, including empty invitee groups. */
export function projectAgendaTaskGroupOrder(
    order: readonly string[],
    groups: readonly { name: string | null }[],
): string[] {
    const visible = new Set(
        groups.map((group) => agendaTaskGroupKey(group.name)),
    );
    return order.filter((key) => visible.has(key));
}

/**
 * Replace visible slots from left to right, leaving hidden keys in their original slots.
 * A hidden run retains its order and the number of visible slots before and after it,
 * even when those visible slots exchange names. Newly ordered groups fill remaining
 * slots, then append after the stored sequence. Callers must supply every visible group.
 */
export function mergeAgendaTaskGroupOrder(
    stored: readonly string[],
    visibleOrder: readonly string[],
): string[] {
    const visible = new Set(visibleOrder);
    let index = 0;
    const merged = stored.map((key) =>
        visible.has(key) ? visibleOrder[index++] : key,
    );
    return [...merged, ...visibleOrder.slice(index)];
}
