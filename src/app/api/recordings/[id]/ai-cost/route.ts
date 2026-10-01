import { NextResponse } from "next/server";
import { recordingAiCost } from "@/lib/ai/usage-cost";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";

type IdContext = { params: Promise<{ id: string }> };

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    await requireRecordingView(
        session.user.id,
        id,
        requestedRecordingView(request),
    );
    return NextResponse.json(await recordingAiCost(id, session.user.id));
});
