/** Show agenda attribution only after another person contributes content. */
export function hasAgendaContributors(detail: {
    userId: string;
    points: readonly {
        authorUserId: string | null;
        updatedByUserId?: string | null;
    }[];
    tasks: readonly { agendaUpdatedByUserId?: string | null }[];
}): boolean {
    const other = (id: string | null | undefined) =>
        Boolean(id && id !== detail.userId);
    return (
        detail.points.some(
            (point) =>
                point.authorUserId !== detail.userId ||
                other(point.updatedByUserId),
        ) || detail.tasks.some((task) => other(task.agendaUpdatedByUserId))
    );
}
