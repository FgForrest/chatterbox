import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import {
    invalid,
    readTaskBody,
    readVersion,
    requireTaskViewer,
} from "@/lib/tasks/route-helpers";
import { tickUpdateProposal } from "@/lib/tasks/tasks";

type UpdateContext = { params: Promise<{ id: string; updateId: string }> };

/** Tick or untick a follow-up of the review: `{ticked, version}`. */
export const PATCH = apiHandler<UpdateContext>(async (request, context) => {
    const { id, updateId } = await (context as UpdateContext).params;
    const viewer = await requireTaskViewer(request);
    const body = await readTaskBody(request);
    if (typeof body.ticked !== "boolean") {
        throw invalid("ticked is required", "ticked");
    }
    await tickUpdateProposal(
        viewer,
        id,
        updateId,
        body.ticked,
        readVersion(body.version),
    );
    return NextResponse.json({ ok: true });
});
