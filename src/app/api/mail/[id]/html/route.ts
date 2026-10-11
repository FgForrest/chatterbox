import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { mailRawFor } from "@/lib/mail/detail";
import { mailHtmlBody } from "@/lib/mail/html-view";
import { readRawMail } from "@/lib/mail/raw-storage";
import { secretAddressMaskerForHtml } from "@/lib/mail/redact";

type IdContext = { params: Promise<{ id: string }> };

/**
 * The mail's HTML, NOT sanitized (the browser sanitizes it with
 * `mailHtmlDocument` before a sandboxed frame shows it), and only ever as
 * JSON so it is never rendered as a page of this origin: `{ html: null }`
 * when it has none. Its owner's, or a shared one.
 */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const found = await mailRawFor(session.user.id, id);
    if (!found) throw new AppError(ErrorCode.NOT_FOUND, "Mail not found", 404);
    let html = await mailHtmlBody(
        await readRawMail(found.access.ownerUserId, found.path),
    );
    if (html && found.access.role !== "owner") {
        html = (await secretAddressMaskerForHtml(html))(html);
    }
    return NextResponse.json(
        { html },
        {
            headers: {
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        },
    );
});
