import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { resolveMailAccess } from "@/lib/mail/access";
import { loadMailDetail } from "@/lib/mail/detail";
import { deleteMail } from "@/lib/mail/manage";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";

type IdContext = { params: Promise<{ id: string }> };

/** The caller's own mail, decrypted: headers, segments, attachments. */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const access = await resolveMailAccess(session.user.id, id);
    if (!access) {
        throw new AppError(ErrorCode.NOT_FOUND, "Mail not found", 404);
    }
    const [detail, processing] = await Promise.all([
        loadMailDetail(session.user.id, id),
        loadPrivateItemProcessing(access.ownerUserId, id, session.user.id),
    ]);
    if (!detail) {
        throw new AppError(ErrorCode.NOT_FOUND, "Mail not found", 404);
    }
    return NextResponse.json(
        { ...detail, processing },
        {
            headers: { "Cache-Control": "private, no-store" },
        },
    );
});

/** Deletes the caller's mail for good. */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    await deleteMail(session.user.id, id);
    return NextResponse.json({ success: true });
});
