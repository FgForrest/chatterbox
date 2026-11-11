import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSessionActor } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    decideRestrictedFolderAccessRequest,
    dismissRestrictedAccessNotice,
} from "@/lib/folders/access-requests";
import { consumePersonShareRateLimit } from "@/lib/sharing/person-share-routes";

type Context = { params: Promise<{ id: string; requestId: string }> };
const schema = z.object({
    state: z.enum(["approved", "declined", "dismissed"]),
});

export const PATCH = apiHandler<Context>(async (request, context) => {
    const { session, actor } = await requireApiSessionActor(request);
    if (actor.kind === "service")
        throw new AppError(ErrorCode.FORBIDDEN, ErrorCode.FORBIDDEN, 403);
    await consumePersonShareRateLimit(request, session.user.id);
    const { id, requestId } = await (context as Context).params;
    const input = schema.safeParse(await request.json().catch(() => null));
    if (!input.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            ErrorCode.INVALID_INPUT,
            400,
        );
    return NextResponse.json(
        input.data.state === "dismissed"
            ? await dismissRestrictedAccessNotice(
                  session.user.id,
                  id,
                  requestId,
              )
            : await decideRestrictedFolderAccessRequest(
                  session.user.id,
                  id,
                  requestId,
                  input.data.state,
              ),
    );
});
