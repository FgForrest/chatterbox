/**
 * Retry a transaction once after a deadlock, or up to twice when serialization
 * retries are enabled. Refusals and exhausted retries preserve the final error.
 *
 * Dependency-free, so any writer can use it without loading more of the
 * app.
 */
export async function retryOnDeadlock<T>(
    run: () => Promise<T>,
    { retrySerialization = false }: { retrySerialization?: boolean } = {},
): Promise<T> {
    const retries = retrySerialization ? 2 : 1;
    for (let attempt = 0; ; attempt++) {
        try {
            return await run();
        } catch (error) {
            if (
                attempt >= retries ||
                (!isDeadlock(error) &&
                    !(retrySerialization && isSerializationFailure(error)))
            )
                throw error;
        }
    }
}

/** Whether `error`, or an error it wraps (Drizzle's `cause`), is 40P01. */
export function isDeadlock(error: unknown): boolean {
    return hasSqlState(error, "40P01");
}

/** Whether `error`, or an error it wraps, is a PostgreSQL serialization failure. */
export function isSerializationFailure(error: unknown): boolean {
    return hasSqlState(error, "40001");
}

function hasSqlState(error: unknown, code: string): boolean {
    for (
        let current: unknown = error;
        current && typeof current === "object";
        current = (current as { cause?: unknown }).cause
    ) {
        if ((current as { code?: unknown }).code === code) return true;
    }
    return false;
}
