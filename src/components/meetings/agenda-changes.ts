import type { MeetingDetail } from "./types";

/** Whether incoming rows contain a change attributed to someone other than the viewer. */
export function hasColleagueAgendaChange(
    current: MeetingDetail,
    next: MeetingDetail,
    userId?: string,
): boolean {
    if (!userId) return false;
    const isColleague = (editor: string | null | undefined) =>
        Boolean(editor && editor !== userId);
    const points = new Map(current.points.map((point) => [point.id, point]));
    if (
        next.points.some((point) => {
            const previous = points.get(point.id);
            if (!previous)
                return isColleague(point.updatedByUserId ?? point.authorUserId);
            const discussedChanged =
                Boolean(point.discussedAt) !== Boolean(previous.discussedAt);
            if (
                discussedChanged &&
                isColleague(
                    point.discussedAt
                        ? (point.discussedByUserId ?? point.updatedByUserId)
                        : point.updatedByUserId,
                )
            )
                return true;
            return (
                (point.text !== previous.text ||
                    point.note !== previous.note ||
                    point.parentId !== previous.parentId ||
                    point.position !== previous.position) &&
                isColleague(point.updatedByUserId)
            );
        })
    )
        return true;
    const tasks = new Map(current.tasks.map((task) => [task.id, task]));
    return next.tasks.some((task) => {
        if (task.removedAt) return false;
        const previous = tasks.get(task.id);
        if (!previous) return isColleague(task.agendaUpdatedByUserId);
        const agendaRowChanged =
            (task.agendaVersion ?? 0) > (previous.agendaVersion ?? 0);
        if (agendaRowChanged && isColleague(task.agendaUpdatedByUserId))
            return true;
        return (
            task.status !== previous.status &&
            isColleague(task.statusChangedByUserId)
        );
    });
}
