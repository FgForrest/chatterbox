import type { TreePoint } from "@/lib/meetings/model";
import { pointSiblings } from "@/lib/meetings/point-order";

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
): { parentId: string | null; siblingIndex: number } | null {
    const rows = outlineRows(points);
    const index = rows.findIndex((row) => row.point.id === id);
    const row = rows[index];
    if (!row) return null;
    if (outdent) {
        const parent = points.find((point) => point.id === row.point.parentId);
        return parent
            ? {
                  parentId: parent.parentId,
                  siblingIndex:
                      pointSiblings(points, parent.parentId).findIndex(
                          (point) => point.id === parent.id,
                      ) + 1,
              }
            : null;
    }
    const siblings = pointSiblings(points, row.point.parentId);
    const previous =
        siblings[siblings.findIndex((point) => point.id === id) - 1];
    if (!previous) return null;
    const last = rows.findIndex(
        (candidate, at) => at > index && candidate.depth <= row.depth,
    );
    const subtree = rows.slice(index, last < 0 ? undefined : last);
    if (subtree.some((candidate) => candidate.depth >= 2)) return null;
    return {
        parentId: previous.id,
        siblingIndex: pointSiblings(points, previous.id).length,
    };
}

export function outlineReorder<T extends TreePoint>(
    points: readonly T[],
    id: string,
    direction: -1 | 1,
) {
    const point = points.find((point) => point.id === id);
    if (!point) return null;
    const siblings = outlineRows(points).filter(
        (row) => row.point.parentId === point.parentId,
    );
    const index = siblings.findIndex((row) => row.point.id === id);
    const target = siblings[index + direction]?.point;
    return target
        ? {
              parentId: point.parentId,
              siblingIndex: index + direction,
          }
        : null;
}

export function outlineDrop<T extends TreePoint>(
    points: readonly T[],
    id: string,
    targetId: string,
    after: boolean,
    requestedDepth: number,
) {
    const rows = outlineRows(points);
    const from = rows.findIndex((row) => row.point.id === id);
    if (from < 0 || targetId === id) return null;
    const end = rows.findIndex(
        (row, index) => index > from && row.depth <= rows[from].depth,
    );
    const subtree = rows.slice(from, end < 0 ? undefined : end);
    if (subtree.some((row) => row.point.id === targetId)) return null;
    const remaining = rows.filter((row) => !subtree.includes(row));
    const target = remaining.findIndex((row) => row.point.id === targetId);
    if (target < 0) return null;
    let at = target;
    if (after) {
        at = target + 1;
        while (
            at < remaining.length &&
            remaining[at].depth > remaining[target].depth
        )
            at++;
    }
    const previous = remaining[at - 1];
    const depth = Math.max(
        0,
        Math.min(2, requestedDepth, previous ? previous.depth + 1 : 0),
    );
    if (subtree.some((row) => row.depth - rows[from].depth + depth > 2))
        return null;
    const parentId =
        depth === 0
            ? null
            : remaining
                  .slice(0, at)
                  .reverse()
                  .find((row) => row.depth === depth - 1)?.point.id;
    if (parentId === undefined) return null;
    return {
        parentId,
        siblingIndex: remaining
            .slice(0, at)
            .filter((row) => row.point.parentId === parentId).length,
    };
}
