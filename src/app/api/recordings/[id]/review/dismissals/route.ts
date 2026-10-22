import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { forgetDismissals } from "@/lib/learn/review";
import { requireLearnAccess } from "@/lib/sharing/learn-access";

type IdContext = { params: Promise<{ id: string }> };

/**
 * Forget what was rejected in Learn's reviews of this recording, in this
 * view, so Re-learn may propose it again.
 */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access } = await requireLearnAccess(request, id);
    return NextResponse.json({
        forgotten: await forgetDismissals(access),
    });
});
