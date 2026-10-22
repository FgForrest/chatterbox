import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { localeFromAcceptLanguage } from "@/lib/i18n/config";
import { loadMailDetail } from "@/lib/mail/detail";
import { deleteMail } from "@/lib/mail/manage";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";

type IdContext = { params: Promise<{ id: string }> };

const noStore = { headers: { "Cache-Control": "private, no-store" } };

/** Read authorized mail detail, or processing status without decrypting the mail. */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const access = await requireRecordingView(
        session.user.id,
        id,
        requestedRecordingView(request),
        { kinds: ["mail"] },
    );
    const processingRequest = loadPrivateItemProcessing(
        access.ownerUserId,
        id,
        session.user.id,
        localeFromAcceptLanguage(request.headers.get("accept-language")),
        access.view,
    );
    if (new URL(request.url).searchParams.get("processing") === "1")
        return NextResponse.json(
            { processing: await processingRequest },
            noStore,
        );
    const [detail, processing] = await Promise.all([
        loadMailDetail(session.user.id, id),
        processingRequest,
    ]);
    if (!detail) {
        throw new AppError(ErrorCode.NOT_FOUND, "Mail not found", 404);
    }
    return NextResponse.json({ ...detail, processing }, noStore);
});

/** Deletes the caller's mail for good. */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    await deleteMail(session.user.id, id);
    return NextResponse.json({ success: true });
});
