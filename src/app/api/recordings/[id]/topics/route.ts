import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { getActiveJob } from "@/db/queries/async-jobs";
import { transcriptions } from "@/db/schema";
import { requireApiSession, requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { appErrorFromJobFailure } from "@/lib/jobs/retryable";
import { watchJob } from "@/lib/jobs/watch";
import { pipelineMayQueue } from "@/lib/pipeline/pending";
import { PIPELINE_ADVANCE_JOB_KIND } from "@/lib/pipeline/trigger";
import {
    recordingJobSubject,
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { getJobVisibleTo } from "@/lib/sharing/jobs";
import { assertMayChange } from "@/lib/sharing/writer";
import type { TopicSource } from "@/lib/topics/generate-topics";
import { readTranscriptTopics } from "@/lib/topics/stored-topics";
import { enqueueTopicsJob, TOPICS_JOB_KIND } from "@/lib/topics/topics-job";

type IdContext = { params: Promise<{ id: string }> };

/**
 * How long a request follows its job. Well short of the job's own ceiling:
 * past it the client gets the job id and follows `/api/jobs/{id}` itself,
 * which costs it nothing and keeps a request from hanging for minutes.
 */
const WATCH_TIMEOUT_MS = 120_000;

function requestedTopicSource(request: Request): TopicSource {
    return new URL(request.url).searchParams.get("source") === "plaud"
        ? "plaud"
        : "riffado";
}

async function readTopics(
    userId: string,
    recordingId: string,
    source: TopicSource,
) {
    const [row] = await db
        .select({ topics: transcriptions.topics })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
                eq(transcriptions.source, source),
            ),
        )
        .limit(1);
    return readTranscriptTopics(row);
}

/**
 * The stored topics of one transcript, and the job detecting them in this
 * view, if any. Topics sit on the owner's transcript row, which both views
 * read.
 */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const view = requestedRecordingView(request);
    const access = await requireRecordingView(session.user.id, id, view);
    const source = requestedTopicSource(request);

    const topicsJob = await getActiveJob(
        TOPICS_JOB_KIND,
        recordingJobSubject(id, view),
    );
    const matchingTopicsJob =
        topicsJob && topicsJob.payload.source === source ? topicsJob : null;
    const pipelineDriver =
        !matchingTopicsJob && view === "private" && source === "riffado"
            ? await getActiveJob(
                  PIPELINE_ADVANCE_JOB_KIND,
                  recordingJobSubject(id, "private"),
              )
            : null;
    const pipelineJob =
        pipelineDriver &&
        (await pipelineMayQueue(access.ownerUserId, id, "topics"))
            ? pipelineDriver
            : null;
    const job =
        matchingTopicsJob ??
        (pipelineJob?.userId === access.contentUserId ? pipelineJob : null);
    return NextResponse.json({
        topics: await readTopics(access.contentUserId, id, source),
        jobId: job?.id ?? null,
        ...(job ? { jobKind: job.kind } : {}),
    });
});

/**
 * Detect the topics of one transcript, replacing any it has.
 *
 * Answers with the topics once the job finishes, or with 202 and the job id
 * when it takes longer than the request is willing to wait.
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const { session, actor } = await requireApiSessionActor(request);
    const userId = session.user.id;
    const { id } = await (context as IdContext).params;
    const view = requestedRecordingView(request);
    const access = await requireRecordingView(userId, id, view);
    // The owner on the private view; while shared, a curator (or the
    // organization account) on the Organization view, with the
    // Organization's prompt and language.
    assertMayChange(access, userId, await actsForOrganization(actor));
    const source = requestedTopicSource(request);

    const { job } = await enqueueTopicsJob({
        userId,
        recordingId: id,
        source,
        trigger: "manual",
        view,
    });
    // The queue keeps one topics job per recording; an already-running job
    // for the other transcript must not be reported as this one's.
    if (job.payload.source !== source) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "Topics are being detected on this recording's other transcript. Try again when that finishes.",
            409,
        );
    }

    const { row, reason } = await watchJob(job.id, userId, {
        timeoutMs: WATCH_TIMEOUT_MS,
        readJob: getJobVisibleTo,
    });
    if (reason === "timeout" || !row) {
        return NextResponse.json(
            { jobId: job.id, status: row?.status ?? "pending" },
            { status: 202 },
        );
    }
    if (row.status === "failed") {
        throw appErrorFromJobFailure(row.errorCode, row.lastError);
    }
    return NextResponse.json({
        topics: (await readTopics(access.contentUserId, id, source)) ?? [],
    });
});
