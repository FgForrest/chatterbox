import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { finishReview, requestedReviewSource } from "@/lib/learn/review";
import { refreshSummaryAfterCorrections } from "@/lib/learn/summary-refresh";
import { requireLearnAccess } from "@/lib/sharing/learn-access";

type IdContext = { params: Promise<{ id: string }> };

/**
 * Finish the review: apply what is ticked, remember what is not, in one
 * transaction. `{versions}` are the item versions shown (409 if any
 * changed). A transcript changed since the run answers `superseded`.
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access, actorUserId, curates } = await requireLearnAccess(
        request,
        id,
    );
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
