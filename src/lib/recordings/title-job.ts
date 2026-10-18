/**
 * Legacy title jobs. New automatic titles run from the first completed
 * summary; this definition remains so jobs queued by an older deployment can
 * be parsed and drained safely.
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

/** Queue a legacy title job; retained for stored-job compatibility. */
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
