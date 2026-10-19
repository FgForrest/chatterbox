/**
 * Legacy title-job payloads. New automatic titles run from the first completed
 * summary; this definition remains so jobs queued by an older deployment can
 * be parsed and drained safely.
 *
 * Only the worker registration imports the handler
 * (`title-job-handler.ts`) and what generating a title needs.
 */

import { InvalidJobPayloadError } from "@/lib/jobs/types";

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
