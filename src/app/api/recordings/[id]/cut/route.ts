import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import {
    AppError,
    apiHandler,
    ErrorCode,
    mapErrorToAppError,
} from "@/lib/errors";
import {
    cutRequestSchema,
    latestRecordingCut,
    requestRecordingCut,
} from "@/lib/recordings/cut";
import { requireRecordingView } from "@/lib/sharing/access";

type IdContext = { params: Promise<{ id: string }> };

export const POST = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    try {
        const session = await requireApiSession(request);
        const access = await requireRecordingView(
            session.user.id,
            id,
            "private",
        );
        if (
            access.role !== "owner" ||
            access.ownerUserId !== session.user.id ||
            access.orgUserId === session.user.id
        ) {
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "Only the recording owner may cut it",
                403,
            );
        }
        const parsed = cutRequestSchema.safeParse(
            await request.json().catch(() => null),
        );
        if (!parsed.success)
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "Invalid cut range",
                400,
            );
        const job = await requestRecordingCut(session.user.id, id, parsed.data);
        console.info(
            `[cut] requested recording=${id} job=${job.id} startMs=${parsed.data.startMs} endMs=${parsed.data.endMs} shared=${access.shared}`,
        );
        return NextResponse.json({ jobId: job.id }, { status: 202 });
    } catch (error) {
        const app = mapErrorToAppError(error);
        if (app.statusCode >= 400 && app.statusCode < 500)
            console.info(
                `[cut] refused recording=${id} code=${app.code} status=${app.statusCode}`,
            );
        throw error;
    }
});

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    return NextResponse.json({
        job: await latestRecordingCut(session.user.id, id),
    });
});
