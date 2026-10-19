import { holderAccess } from "@/lib/authz/access-state";
import { actsForOrganization } from "@/lib/authz/curator";
import type { ActorContext } from "@/lib/authz/model";
import { isIdpAuthorization } from "@/lib/identity/factory";
import { isOrgScopeEnabled } from "@/lib/org/config";
import type { ProfileScope } from "@/lib/profiles/settings";

export interface ProfileAccessSubject {
    ownerUserId: string;
    scope: ProfileScope;
}

/** Whether a user may use profiles from the Organization scope. */
export async function mayUseOrganizationProfiles(
    userId: string,
    options: { readOnly?: boolean } = {},
): Promise<boolean> {
    if (!isOrgScopeEnabled()) return false;
    if (!isIdpAuthorization()) return true;
    const access = await holderAccess(userId, options);
    return access.ok && access.capabilities.has("use");
}

/** Whether a request actor may edit a profile. */
export async function mayEditProfile(
    actor: ActorContext,
    profile: ProfileAccessSubject,
): Promise<boolean> {
    if (profile.scope === "personal") {
        return actor.kind === "user" && actor.actorId === profile.ownerUserId;
    }
    return isOrgScopeEnabled() && actsForOrganization(actor);
}

/** Whether a user may select a profile for processing. */
export async function mayUseProfile(
    actorUserId: string,
    profile: ProfileAccessSubject,
    options: { readOnly?: boolean } = {},
): Promise<boolean> {
    if (profile.scope === "personal") {
        return actorUserId === profile.ownerUserId;
    }
    return mayUseOrganizationProfiles(actorUserId, options);
}
