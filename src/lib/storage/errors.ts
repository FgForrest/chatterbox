/** An object requested from storage does not exist. */
export class StorageObjectMissingError extends Error {
    constructor(cause?: unknown) {
        super("Storage object not found", { cause });
        this.name = "StorageObjectMissingError";
    }
}

/** The requested range starts beyond the current end of the object. */
export class StorageRangeNotSatisfiableError extends Error {
    constructor(readonly totalSize: number) {
        super("Storage byte range is not satisfiable");
        this.name = "StorageRangeNotSatisfiableError";
    }
}
