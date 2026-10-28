import type { ActorContext } from "@/lib/authz/model";
import { mayManageAccess, mayUse } from "@/lib/authz/policy";
import { isIdpAuthorization } from "@/lib/identity/factory";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";

/** Organization settings use the same management rights as Organization providers. */
export async function organizationSettingsContext(actor: ActorContext) {
    const orgUserId = mayUse(actor) ? await getOrgUserId() : null;
    const canManage = Boolean(
        orgUserId &&
            isOrgScopeEnabled() &&
            (isIdpAuthorization()
                ? actor.kind === "user" && mayManageAccess(actor)
                : actor.actorId === orgUserId),
    );
    return { orgUserId, canManage };
}
