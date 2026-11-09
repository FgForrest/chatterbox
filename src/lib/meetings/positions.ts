/** Minimum initial position for older tasks; subsequent snapshots append after all existing tasks. */
export const OLDER_TASK_POSITION_BASE = 100000;

/** Compact before appending past one billion, leaving over a billion int4 slots for legacy ties. */
export const AGENDA_TASK_POSITION_COMPACTION_BOUND = 1000000000;

/** Reuse sorted position slots, separating legacy ties so every requested order is representable. */
export function agendaTaskOrderPositions(
    tasks: readonly { position: number }[],
): number[] {
    let previous = -Infinity;
    return tasks
        .map((task) => task.position)
        .sort((a, b) => a - b)
        .map((position) => {
            previous = Math.max(position, previous + 1);
            return previous;
        });
}
