import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { loadMailDetail } from "@/lib/mail/detail";
import { buildMailMessageMarkdown } from "@/lib/mail/export-document";
import {
    contentDispositionAttachment,
    sanitizeDownloadBasename,
} from "@/lib/recordings/filename";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";

type IdContext = { params: Promise<{ id: string }> };

/** Download the text of a mail using the same view and masking as its detail. */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const access = await requireRecordingView(
        session.user.id,
        id,
        requestedRecordingView(request),
        { kinds: ["mail"] },
    );
    const detail =
        access.view === "private"
            ? await loadMailDetail(session.user.id, id)
            : await loadMailDetail(session.user.id, id, access.view);
    if (!detail) throw new AppError(ErrorCode.NOT_FOUND, "Mail not found", 404);
    const filename = `${sanitizeDownloadBasename(detail.subject) || "message"}.md`;
    return new Response(buildMailMessageMarkdown(detail), {
        headers: {
            "Cache-Control": "private, no-store",
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": contentDispositionAttachment(filename),
        },
    });
});
