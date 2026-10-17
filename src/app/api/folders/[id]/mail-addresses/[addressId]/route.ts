import { NextResponse } from "next/server";
import { requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
import { apiHandler } from "@/lib/errors";
import { removeFolderAlias } from "@/lib/mail/folder-addresses";
import { requireMailEnabled } from "@/lib/mail/require-mail";

type Context = { params: Promise<{ id: string; addressId: string }> };

/** Stops one of the folder's secondary addresses for good. */
export const DELETE = apiHandler<Context>(async (request, context) => {
    requireMailEnabled();
    const { actor, session } = await requireApiSessionActor(request);
    const { id, addressId } = await (context as Context).params;
    await removeFolderAlias({
        userId: session.user.id,
        folderId: id,
        addressId,
        canCurate: await actsForOrganization(actor),
    });
    return NextResponse.json({ success: true });
});
