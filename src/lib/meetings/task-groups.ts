/** Group tasks in invitee order, followed by other assignees and unassigned tasks. */
export function groupAgendaTasks<
    T extends {
        assignee: { name: string } | null;
        assigneeHint: string | null;
    },
>(tasks: readonly T[], invitees: readonly { name: string }[]) {
    const key = (name: string) =>
        name.normalize("NFKC").trim().toLocaleLowerCase();
    const groups: { name: string | null; invited: boolean; tasks: T[] }[] = [];
    for (const invitee of invitees)
        if (
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
    return groups;
}
