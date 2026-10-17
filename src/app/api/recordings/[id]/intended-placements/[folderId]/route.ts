import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { apiHandler } from "@/lib/errors";
import { cancelIntendedPlacement } from "@/lib/pipeline/share-intent";
import { requireRecordingView } from "@/lib/sharing/access";

type IntentContext = {
    params: Promise<{ id: string; folderId: string }>;
};

/** Cancel one intended Organization placement as the item's owner. */
export const DELETE = apiHandler<IntentContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id, folderId } = await (context as IntentContext).params;
    const access = await requireRecordingView(session.user.id, id, "private", {
        kinds: ALL_ITEM_KINDS,
    });
    await cancelIntendedPlacement(access.ownerUserId, id, folderId);
    return NextResponse.json({ cancelled: true });
});
