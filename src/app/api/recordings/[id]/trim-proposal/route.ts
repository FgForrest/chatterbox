import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import {
    readTrimSnapshot,
    trimSnapshotMatches,
} from "@/db/queries/trim-proposal";
import { resolveTrimInTx } from "@/db/queries/trim-state";
import { requireApiSession } from "@/lib/auth-server";
import { decryptJsonField } from "@/lib/encryption/fields";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { nudge } from "@/lib/jobs/nudge";
import type { StoredTrimProposal } from "@/lib/recordings/trim-proposal";

import { requireRecordingView } from "@/lib/sharing/access";

type Context = { params: Promise<{ id: string }> };
const decision = z.object({ proposalId: z.string().min(1) }).strict();

export const POST = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as Context).params;
    await requireRecordingView(session.user.id, id, "private");
    const parsed = decision.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid trim decision",
            400,
        );
    const resolved = await db.transaction(async (tx) => {
        const snapshot = await readTrimSnapshot(tx, session.user.id, id);
        const proposal = snapshot
            ? decryptJsonField<StoredTrimProposal>(
                  snapshot.recording.trimProposal,
              )
            : null;
        if (
            !snapshot ||
            !proposal ||
            proposal.id !== parsed.data.proposalId ||
            !(await trimSnapshotMatches(snapshot, proposal))
        )
            return false;
        return resolveTrimInTx(tx, {
            userId: session.user.id,
            recordingId: id,
            reason: "declined",
            proposalId: parsed.data.proposalId,
        });
    });
    if (!resolved)
        throw new AppError(
            ErrorCode.CONFLICT,
            "The trim proposal is no longer available",
            409,
        );
    nudge();
    return NextResponse.json({ success: true });
});
