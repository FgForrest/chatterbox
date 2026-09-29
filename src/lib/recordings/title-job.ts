/**
 * The title job (Task 5.4). Titles are generated inline after a
 * transcription; automatic Learn holds the title back until its review is
 * done, and releasing the hold queues this job instead. Its webhook is
 * `recording.updated`: `transcription.completed` fired without it.
 *
 * Only the worker registration imports the handler
 * (`title-job-handler.ts`) and what generating a title needs.
 */

import { enqueueJob } from "@/db/queries/async-jobs";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError } from "@/lib/jobs/types";
import { recordingJobSubject } from "@/lib/sharing/view";

export const TITLE_JOB_KIND = "title.generate";

export interface TitleJobPayload {
    recordingId: string;
}

export function parseTitleJobPayload(
    raw: Record<string, unknown>,
): TitleJobPayload {
    if (typeof raw.recordingId !== "string" || !raw.recordingId) {
        throw new InvalidJobPayloadError(TITLE_JOB_KIND, "recordingId");
    }
    return { recordingId: raw.recordingId };
}

/** Queue a recording's title; one at a time per recording. */
export async function enqueueTitleJob(
    userId: string,
    recordingId: string,
): Promise<void> {
    const enqueued = await enqueueJob({
        userId,
        kind: TITLE_JOB_KIND,
        subjectId: recordingJobSubject(recordingId, "private"),
        priority: 0,
        maxAttempts: 3,
        payload: { recordingId },
    });
    if (enqueued.created) nudge();
}
