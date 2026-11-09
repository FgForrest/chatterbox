import type { TreePoint } from "./model";

/** Deterministic sibling order, including agendas with legacy equal positions. */
export function pointSiblings<T extends TreePoint>(
    points: readonly T[],
    parentId: string | null,
): T[] {
    return points
        .filter((point) => point.parentId === parentId)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/** Move a subtree root to an index in the destination siblings, renumbering both sibling lists. */
export function moveAgendaPoint<T extends TreePoint>(
    points: readonly T[],
    id: string,
    parentId: string | null,
    siblingIndex: number,
): T[] | null {
    const point = points.find((point) => point.id === id);
    if (!point) return null;
    const remaining = points.filter((point) => point.id !== id);
    const destination = pointSiblings(remaining, parentId);
    if (
        !Number.isInteger(siblingIndex) ||
        siblingIndex < 0 ||
        siblingIndex > destination.length ||
        destination.length > 100000
    )
        return null;
    destination.splice(siblingIndex, 0, { ...point, parentId });
    const positions = new Map(
        destination.map((point, position) => [point.id, position]),
    );
    if (parentId !== point.parentId)
        for (const [position, sibling] of pointSiblings(
            remaining,
            point.parentId,
        ).entries())
            positions.set(sibling.id, position);
    return points.map((entry) =>
        positions.has(entry.id)
            ? {
                  ...entry,
                  position: positions.get(entry.id) ?? entry.position,
                  ...(entry.id === id ? { parentId } : {}),
              }
            : entry,
    );
}
