/**
 * Which view of a recording a request is made in.
 *
 * All read the owner's rows: a shared recording is one recording. `private`
 * is the owner's view, `org` the Organization's view of a shared recording,
 * where the owner and Organization writers change it. Runs on a shared
 * recording follow the Organization's prompts and language in either writable view.
 * The `received` view is read-only and never queues processing.
 *
 * Dependency-free so client components and the light job-queueing modules
 * can import it.
 */
export type RecordingView = "private" | "org" | "received";

/** Job subject for a recording in a view; Organization jobs dedupe separately. */
export function recordingJobSubject(
    recordingId: string,
    view: RecordingView,
): string {
    return view === "org" ? `org:${recordingId}` : recordingId;
}

/** Append a non-private view to a recording API path. */
export function withRecordingView(
    path: string,
    view: RecordingView | undefined,
): string {
    if (!view || view === "private") return path;
    return `${path}${path.includes("?") ? "&" : "?"}view=${view}`;
}
