/**
 * Which view of a recording a request is made in.
 *
 * Both read the owner's rows: a shared recording is one recording. `private`
 * is the owner's view, `org` the Organization's view of a shared recording,
 * where only the organization account changes it and its runs follow the
 * Organization's prompts and language.
 *
 * Dependency-free so client components and the light job-queueing modules
 * can import it.
 */
export type RecordingView = "private" | "org";

/** Job subject for a recording in a view; Organization jobs dedupe separately. */
export function recordingJobSubject(
    recordingId: string,
    view: RecordingView,
): string {
    return view === "org" ? `org:${recordingId}` : recordingId;
}

/** Append `view=org` to a recording API path when the view is Organization. */
export function withRecordingView(
    path: string,
    view: RecordingView | undefined,
): string {
    if (view !== "org") return path;
    return `${path}${path.includes("?") ? "&" : "?"}view=org`;
}
