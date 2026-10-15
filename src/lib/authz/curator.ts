import { holderAccess } from "@/lib/authz/access-state";
import type { ActorContext } from "@/lib/authz/model";
import { mayCurate } from "@/lib/authz/policy";
import { isIdpAuthorization } from "@/lib/identity/factory";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";

/**
 * Whether the actor of a request may change the Organization's content
 * now: the Organization accepts changes, and the actor is either the
 * organization account (`AUTHZ_MODE=local`) or a person holding `use` and
 * `org.curate` in their verified session (`AUTHZ_MODE=idp`). The actor
 * stays themselves; the Organization is only the data context they write
 * into.
 */
export async function actsForOrganization(
    actor: ActorContext,
): Promise<boolean> {
    if (!isOrgScopeEnabled()) return false;
    if (isIdpAuthorization()) {
        return actor.kind === "user" && mayCurate(actor);
    }
    return (await getOrgUserId()) === actor.actorId;
}

/**
 * {@link actsForOrganization} for work that runs later (a job, a
 * queued run): re-checked against the actor's current verified access at
 * the moment the work takes effect, never the access it was queued with.
 */
export async function userCuratesOrganizationNow(
    userId: string,
): Promise<boolean> {
    if (!isOrgScopeEnabled()) return false;
    if (isIdpAuthorization()) {
        const access = await holderAccess(userId);
        return access.ok && access.capabilities.has("org.curate");
    }
    return (await getOrgUserId()) === userId;
}
