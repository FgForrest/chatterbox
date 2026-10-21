import { requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange } from "@/lib/sharing/writer";

/** Authorize Learn for the owner or a curator, following the shared item's current scope. */
export async function requireLearnAccess(
    request: Request,
    recordingId: string,
) {
    const { session, actor } = await requireApiSessionActor(request);
    const access = await requireRecordingView(
        session.user.id,
        recordingId,
        requestedRecordingView(request),
        { kinds: ALL_ITEM_KINDS },
    );
    const curates = access.view === "org" && (await actsForOrganization(actor));
    assertMayChange(access, session.user.id, curates);
    return {
        access: {
            ...access,
            view: access.shared ? ("org" as const) : access.view,
        },
        actorUserId: session.user.id,
        curates,
    };
}
