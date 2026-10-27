import type { TreePoint } from "@/lib/meetings/model";

export function outlineRows<T extends TreePoint>(
    points: readonly T[],
    parentId: string | null = null,
    depth = 0,
): { point: T; depth: number }[] {
    return [...points]
        .filter((point) => point.parentId === parentId)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
        .flatMap((point) => [
            { point, depth },
            ...outlineRows(points, point.id, depth + 1),
        ]);
}
export function outlineMove<T extends TreePoint>(
    points: readonly T[],
    id: string,
    outdent: boolean,
): { parentId: string | null; position?: number } | null {
    const rows = outlineRows(points);
    const index = rows.findIndex((row) => row.point.id === id);
    const row = rows[index];
    if (!row) return null;
    if (outdent) {
        const parent = points.find((point) => point.id === row.point.parentId);
        return parent
            ? { parentId: parent.parentId, position: parent.position + 1 }
            : null;
    }
    const previous = points
        .filter(
            (point) =>
                point.parentId === row.point.parentId &&
                point.id !== id &&
                point.position < row.point.position,
        )
        .sort((a, b) => b.position - a.position)[0];
    if (!previous) return null;
    const last = rows.findIndex(
        (candidate, at) => at > index && candidate.depth <= row.depth,
    );
    const subtree = rows.slice(index, last < 0 ? undefined : last);
    if (subtree.some((candidate) => candidate.depth >= 2)) return null;
    return { parentId: previous.id };
}
