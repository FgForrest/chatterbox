export interface ProcessingRequestOrigin {
    transcription: "pipeline" | "person" | null;
    summary: "pipeline" | "person" | null;
    topics: "pipeline" | "person" | null;
}

/** Identify who started the latest durable request for each rerunnable job. */
export function processingStartedBy(
    jobs: Array<{ kind: string; payload: unknown; createdAt: Date }>,
    kinds: { transcription: string; summary: string; topics: string },
): ProcessingRequestOrigin {
    const result: ProcessingRequestOrigin = {
        transcription: null,
        summary: null,
        topics: null,
    };
    const latest = new Map<string, { payload: unknown; createdAt: Date }>();
    for (const job of jobs) {
        const current = latest.get(job.kind);
        if (!current || current.createdAt < job.createdAt) {
            latest.set(job.kind, job);
        }
    }
    for (const field of ["transcription", "summary", "topics"] as const) {
        const payload = latest.get(kinds[field])?.payload;
        if (!payload || typeof payload !== "object") continue;
        const trigger = (payload as { trigger?: unknown }).trigger;
        if (trigger === "manual") result[field] = "person";
        else if (trigger === "auto" || trigger === "pipeline") {
            result[field] = "pipeline";
        }
    }
    return result;
}
