import { holderAccess } from "@/lib/authz/access-state";
import {
    actsForOrganization,
    userCuratesOrganizationNow,
} from "@/lib/authz/curator";
import type { ActorContext } from "@/lib/authz/model";
import { isIdpAuthorization } from "@/lib/identity/factory";
import { isOrgScopeEnabled } from "@/lib/org/config";
import type { ProfileScope } from "@/lib/profiles/settings";

export interface ProfileAccessSubject {
    ownerUserId: string;
    scope: ProfileScope;
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

/** Recheck whether a user may edit a profile when queued work takes effect. */
export async function mayEditProfileInJob(
    actorUserId: string,
    profile: ProfileAccessSubject,
): Promise<boolean> {
    if (profile.scope === "personal") {
        return actorUserId === profile.ownerUserId;
    }
    return isOrgScopeEnabled() && userCuratesOrganizationNow(actorUserId);
}

/** Whether a user may select a profile for processing. */
export async function mayUseProfile(
    actorUserId: string,
    profile: ProfileAccessSubject,
): Promise<boolean> {
    if (profile.scope === "personal") {
        return actorUserId === profile.ownerUserId;
    }
    if (!isOrgScopeEnabled()) return false;
    if (!isIdpAuthorization()) return true;
    const access = await holderAccess(actorUserId);
    return access.ok && access.capabilities.has("use");
}
