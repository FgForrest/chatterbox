/**
 * Run a transaction again, once, when PostgreSQL broke a deadlock by
 * aborting it. Anything else, a refusal included, is thrown as it is.
 *
 * Dependency-free, so any writer can use it without loading more of the
 * app.
 */
export async function retryOnDeadlock<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if (!isDeadlock(error)) throw error;
        return run();
    }
}

/** Whether `error`, or an error it wraps (Drizzle's `cause`), is 40P01. */
export function isDeadlock(error: unknown): boolean {
    for (
        let current: unknown = error;
        current && typeof current === "object";
        current = (current as { cause?: unknown }).cause
    ) {
        if ((current as { code?: unknown }).code === "40P01") return true;
    }
    return false;
}
