/** An object requested from storage does not exist. */
export class StorageObjectMissingError extends Error {
    constructor(cause?: unknown) {
        super("Storage object not found", { cause });
        this.name = "StorageObjectMissingError";
    }
}

/** The open object changed while its body was being read. */
export class StorageObjectChangedError extends Error {
    constructor() {
        super("Storage object changed during the read");
        this.name = "StorageObjectChangedError";
    }
}

/** The requested range starts beyond the current end of the object. */
export class StorageRangeNotSatisfiableError extends Error {
    constructor(readonly totalSize: number) {
        super("Storage byte range is not satisfiable");
        this.name = "StorageRangeNotSatisfiableError";
    }
}

/** Whether a failure is attributable to the cancellation of this request. */
export function isRequestAbort(error: unknown, signal: AbortSignal): boolean {
    if (!signal.aborted) return false;
    if (
        error !== null &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "AbortError"
    ) {
        return true;
    }

    const { reason } = signal;
    const seen = new Set<object>();
    let cause = error;
    while (
        cause !== null &&
        typeof cause === "object" &&
        "cause" in cause &&
        !seen.has(cause)
    ) {
        if (cause === reason) return true;
        seen.add(cause);
        cause = cause.cause;
    }
    return cause === reason;
}
