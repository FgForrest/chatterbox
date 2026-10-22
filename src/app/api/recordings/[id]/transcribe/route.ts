import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { getActiveJob } from "@/db/queries/async-jobs";
import { transcriptions } from "@/db/schema";
import { requireApiSession, requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { recordingLanguage } from "@/lib/recordings/language";
import {
    recordingJobSubject,
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange } from "@/lib/sharing/writer";
import {
    enqueueTranscriptionJob,
    TRANSCRIPTION_JOB_KIND,
} from "@/lib/transcription/transcription-job";

type IdContext = { params: Promise<{ id: string }> };

/**
 * Manual "Transcribe" / "Re-transcribe" endpoint. The durable job is shared
 * with upload and Plaud-sync auto-transcription, so concurrent triggers all
 * converge on the database's one-active-job constraint.
 *
 * `?view=org` transcribes a shared recording on the Organization view, for
 * the organization account only (403 for anyone else). A shared recording
 * is one recording, the Organization's to change: its owner withdraws it
 * before transcribing it again (409 RECORDING_SHARED).
 *
 * Request body (all optional):
 *   - `providerId`: use a specific configured provider instead of the
 *     user's default transcription provider. Looked up user-scoped.
 *   - `model`: override the provider's default model for this call.
 *   - `retranscribe`: replace an existing transcript when explicitly true.
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const { session, actor } = await requireApiSessionActor(request);
    const { id } = await (context as IdContext).params;
    const view = requestedRecordingView(request);
    const access = await requireRecordingView(session.user.id, id, view);
    // The run checks again when it starts, and when it writes.
    assertMayChange(access, session.user.id, await actsForOrganization(actor));

    const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
    >;
    const providerId =
        typeof body.providerId === "string" ? body.providerId : undefined;
    const model = typeof body.model === "string" ? body.model : undefined;
    const attributionSource =
        body.attributionSource === "riffado" ||
        body.attributionSource === "plaud" ||
        body.attributionSource === "mixed"
            ? body.attributionSource
            : undefined;
    const retranscribe = body.retranscribe === true;
    const language = recordingLanguage(body.language);
    if (body.language !== undefined && (!language || !retranscribe)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A language requires Re-transcribe and a supported ISO 639-1 code",
            400,
        );
    }

    const active = await getActiveJob(
        TRANSCRIPTION_JOB_KIND,
        recordingJobSubject(id, view),
    );
    if (active && (view === "org" || active.userId === session.user.id)) {
        return NextResponse.json(
            { jobId: active.id, status: active.status, created: false },
            { status: 202 },
        );
    }

    if (!retranscribe) {
        const [existingTranscript] = await db
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, id),
                    eq(transcriptions.userId, access.contentUserId),
                    eq(transcriptions.source, "riffado"),
                ),
            )
            .limit(1);
        if (existingTranscript) {
            return NextResponse.json(
                {
                    error: "A transcript already exists. Reload it or choose Re-transcribe to replace it.",
                    code: "TRANSCRIPT_ALREADY_EXISTS",
                },
                { status: 409 },
            );
        }
    }

    const { job, created } = await enqueueTranscriptionJob({
        userId: session.user.id,
        recordingId: id,
        providerId,
        model,
        attributionSource,
        force: retranscribe,
        ...(language ? { language } : {}),
        trigger: "manual",
        view,
    });

    return NextResponse.json(
        { jobId: job.id, status: job.status, created },
        { status: 202 },
    );
});

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const view = requestedRecordingView(request);
    await requireRecordingView(session.user.id, id, view);

    // On the Organization view the running job may be anyone's: whoever
    // clicked first. Everyone who can see the view can see that it runs.
    const active = await getActiveJob(
        TRANSCRIPTION_JOB_KIND,
        recordingJobSubject(id, view),
    );
    const activeJob =
        active && (view === "org" || active.userId === session.user.id)
            ? { jobId: active.id, status: active.status }
            : undefined;
    return NextResponse.json({ activeJob });
});
