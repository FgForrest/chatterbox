/**
 * The statuses a Learn run is still open in: queued, running, or ready for
 * review. Dependency-free, so the share gate can count them.
 */
export const UNFINISHED_LEARN_STATUSES = [
    "queued",
    "running",
    "ready",
] as const;
