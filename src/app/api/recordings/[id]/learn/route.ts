import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { learnRuns, transcriptions } from "@/db/schema";
import { apiHandler } from "@/lib/errors";
import { localeFromAcceptLanguage } from "@/lib/i18n/config";
import { type LearnSource, startLearnRun } from "@/lib/learn/learn-job";
import { requireLearnAccess } from "@/lib/sharing/learn-access";

type IdContext = { params: Promise<{ id: string }> };

function requestedSource(request: Request): LearnSource {
    return new URL(request.url).searchParams.get("source") === "plaud"
        ? "plaud"
        : "riffado";
}

/** Start Learn on one transcript (`?source=`), or join the run already open. */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access, actorUserId, curates } = await requireLearnAccess(
        request,
        id,
    );
    const started = await startLearnRun({
        access,
        actorUserId,
        actsForOrganization: curates,
        source: requestedSource(request),
        trigger: "manual",
        requestLocale: request.headers.has("accept-language")
            ? localeFromAcceptLanguage(request.headers.get("accept-language"))
            : undefined,
        calendarEventId:
            new URL(request.url).searchParams.get("calendarEventId") ??
            undefined,
    });
    return NextResponse.json(started, { status: 202 });
});

/** The runs on the recording in this view, newest first: status and counts. */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access } = await requireLearnAccess(request, id);
    const runs = await db
        .select({
            id: learnRuns.id,
            source: transcriptions.source,
            status: learnRuns.status,
            trigger: learnRuns.trigger,
            stats: learnRuns.stats,
            createdAt: learnRuns.createdAt,
            finishedAt: learnRuns.finishedAt,
        })
        .from(learnRuns)
        // A run on a mail read no transcript.
        .leftJoin(
            transcriptions,
            eq(transcriptions.id, learnRuns.transcriptionId),
        )
        .where(
            and(
                eq(learnRuns.itemId, access.recordingId),
                eq(learnRuns.view, access.view),
            ),
        )
        .orderBy(desc(learnRuns.createdAt))
        .limit(20);
    return NextResponse.json({ runs });
});
