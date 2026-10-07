/** What a bounded scan found, and where it stopped. */
export interface ScanOutcome<Result> {
    results: Result[];
    /** How many items were visited. */
    scanned: number;
    /** Whether the data ran out before a bound was hit. */
    complete: boolean;
    /**
     * The stamp of the last item visited: pass it as `before` to continue
     * further back. Null when complete.
     */
    continueBefore: string | null;
}

/** The bounds and callbacks of {@link boundedScan}. */
export interface ScanOptions<Item, Result> {
    /** The next items older than the `before` stamp (null: from the newest). */
    batches: (before: string | null) => Promise<readonly Item[]>;
    /** The stamp an item continues from. */
    stampOf: (item: Item) => string;
    /** A result for an item, or null when it does not match. */
    visit: (item: Item) => Promise<Result | null> | Result | null;
    /** Most items visited. */
    limit: number;
    /** Wall-clock budget, from the call. */
    deadlineMs: number;
    /** Most results gathered. */
    maxResults: number;
    /** Where to start: a stamp from an earlier scan, or null. */
    before: string | null;
}

/**
 * Walk the batches (newest first) through `visit` until `limit` items were
 * visited, `deadlineMs` passed, `maxResults` were found, or the data ran
 * out. Any stop but the last is incomplete, and says where to continue.
 */
export async function boundedScan<Item, Result>(
    options: ScanOptions<Item, Result>,
): Promise<ScanOutcome<Result>> {
    const started = Date.now();
    const results: Result[] = [];
    let scanned = 0;
    let before = options.before;
    const late = () => Date.now() - started >= options.deadlineMs;
    const stopped = () =>
        scanned >= options.limit ||
        results.length >= options.maxResults ||
        late();
    for (;;) {
        if (late()) {
            return {
                results,
                scanned,
                complete: false,
                continueBefore: before,
            };
        }
        const batch = await options.batches(before);
        if (batch.length === 0) {
            return { results, scanned, complete: true, continueBefore: null };
        }
        for (const item of batch) {
            if (stopped()) {
                return {
                    results,
                    scanned,
                    complete: false,
                    continueBefore: before,
                };
            }
            const hit = await options.visit(item);
            scanned++;
            before = options.stampOf(item);
            if (hit !== null) results.push(hit);
        }
    }
}
