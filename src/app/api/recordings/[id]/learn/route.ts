import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { learnRuns, transcriptions } from "@/db/schema";
import { requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { apiHandler } from "@/lib/errors";
import { localeFromAcceptLanguage } from "@/lib/i18n/config";
import { type LearnSource, startLearnRun } from "@/lib/learn/learn-job";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange } from "@/lib/sharing/writer";

type IdContext = { params: Promise<{ id: string }> };

function requestedSource(request: Request): LearnSource {
    return new URL(request.url).searchParams.get("source") === "plaud"
        ? "plaud"
        : "riffado";
}

/** Start Learn on one transcript (`?source=`), or join the run already open. */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access, actorUserId, curates } = await authorizeLearn(request, id);
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
    const { access } = await authorizeLearn(request, id);
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

/**
 * The owner, or an Organization curator while shared. Learn always follows
 * the item's current scope, including requests from the owner's private view.
 */
async function authorizeLearn(request: Request, recordingId: string) {
    const { session, actor } = await requireApiSessionActor(request);
    const access = await requireRecordingView(
        session.user.id,
        recordingId,
        requestedRecordingView(request),
        { kinds: ALL_ITEM_KINDS },
    );
    const curates = access.view === "org" && (await actsForOrganization(actor));
    assertMayChange(access, session.user.id, curates);
    return {
        access: {
            ...access,
            view: access.shared ? ("org" as const) : access.view,
        },
        actorUserId: session.user.id,
        curates,
    };
}
