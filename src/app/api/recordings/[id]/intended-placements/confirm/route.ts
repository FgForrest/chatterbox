import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { apiHandler } from "@/lib/errors";
import { confirmIntendedPlacements } from "@/lib/pipeline/share-intent";
import { requireRecordingView } from "@/lib/sharing/access";

type ConfirmIntentContext = {
    params: Promise<{ id: string }>;
};

/** Confirm every current intended Organization placement of a manual-only item. */
export const POST = apiHandler<ConfirmIntentContext>(
    async (request, context) => {
        const session = await requireApiSession(request);
        const { id } = await (context as ConfirmIntentContext).params;
        const access = await requireRecordingView(
            session.user.id,
            id,
            "private",
            {
                kinds: ALL_ITEM_KINDS,
            },
        );
        const confirmed = await confirmIntendedPlacements(
            access.ownerUserId,
            id,
        );
        return NextResponse.json({ confirmed });
    },
);
