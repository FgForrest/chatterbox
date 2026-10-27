import { enqueueJob } from "@/db/queries/async-jobs";
import { AppError, ErrorCode } from "@/lib/errors";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError, type JobHandler } from "@/lib/jobs/types";
import { requireMeetingAccess } from "@/lib/meetings/access";

export const AGENDA_SUGGESTIONS_JOB_KIND = "agenda.suggestions";

/** Reserved durable job kind; the next integration run supplies the provider-backed body. */
export const agendaSuggestionsJobHandler: JobHandler<{ agendaId: string }> = {
    kind: AGENDA_SUGGESTIONS_JOB_KIND,
    concurrency: 1,
    maxAttempts: 1,
    timeoutMs: 60000,
    parsePayload(raw) {
        if (typeof raw.agendaId !== "string" || !raw.agendaId)
            throw new InvalidJobPayloadError(
                AGENDA_SUGGESTIONS_JOB_KIND,
                "agendaId is required",
            );
        return { agendaId: raw.agendaId };
    },
    async run({ userId, payload }) {
        await requireMeetingAccess(userId, payload.agendaId, "edit");
        throw new AppError(
            ErrorCode.SERVICE_UNAVAILABLE,
            "Agenda AI suggestions are not available yet",
            501,
        );
    },
    isRetryable: () => false,
};

/** Authorize and queue the reserved suggestions operation. */
export async function enqueueAgendaSuggestions(userId: string, id: string) {
    const access = await requireMeetingAccess(userId, id, "edit");
    const result = await enqueueJob({
        userId,
        kind: AGENDA_SUGGESTIONS_JOB_KIND,
        subjectId: access.agenda.id,
        maxAttempts: 1,
        payload: { agendaId: access.agenda.id },
    });
    if (result.created) nudge();
    return {
        jobId: result.job.id,
        available: false,
        reason: "Agenda AI suggestions are not available yet",
    };
}
