/**
 * Not now: the job is put back to start again after `delayMs`, and the
 * attempt is not counted (a rate limit that is still full, not a failure).
 */
export class JobDeferredError extends Error {
    constructor(
        readonly delayMs: number,
        message = "Job put off",
    ) {
        super(message);
        this.name = "JobDeferredError";
    }
}
