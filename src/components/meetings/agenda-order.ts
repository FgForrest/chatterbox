/** Move the value at `from` to just before (or, with `after`, just after) the value at `target`. */
export function moveBefore<T>(
    values: readonly T[],
    from: number,
    target: number,
    after = false,
): T[] {
    const next = [...values];
    const [value] = next.splice(from, 1);
    const insertAt = after ? target + 1 : target;
    next.splice(from < insertAt ? insertAt - 1 : insertAt, 0, value);
    return next;
}
