import { NextResponse } from "next/server";
import { requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { finishReview, requestedReviewSource } from "@/lib/learn/review";
import { refreshSummaryAfterCorrections } from "@/lib/learn/summary-refresh";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange } from "@/lib/sharing/writer";

type IdContext = { params: Promise<{ id: string }> };

/**
 * Finish the review: apply what is ticked, remember what is not, in one
 * transaction. `{versions}` are the item versions shown (409 if any
 * changed). A transcript changed since the run answers `superseded`.
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access, actorUserId, curates } = await authorizeLearn(request, id);
    // One version per item, and there are few.
    const read = await readBoundedJson(request, 64 * 1024);
    if (read.tooLarge) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Request too large", 413);
    }
    const body = (read.body ?? null) as {
        versions?: unknown;
    } | null;
    const versions =
        body?.versions && typeof body.versions === "object"
            ? Object.fromEntries(
                  Object.entries(
                      body.versions as Record<string, unknown>,
                  ).filter(
                      (entry): entry is [string, number] =>
                          typeof entry[1] === "number",
                  ),
              )
            : {};
    const finished = await finishReview(access, actorUserId, {
        actsForOrganization: curates,
        versions,
        source: requestedReviewSource(request),
    });
    // What it applied, and what it left out that a waiting review had
    // ticked, may change what a summary read; a correction pass queued
    // refreshes it when it ends instead.
    if (finished.status === "finished" && !finished.correcting) {
        await refreshSummaryAfterCorrections({
            ownerUserId: access.ownerUserId,
            recordingId: id,
            view: access.view,
        });
    }
    return NextResponse.json(finished);
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
