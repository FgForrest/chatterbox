import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { AppError, ErrorCode } from "@/lib/errors";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";

/** Care is visible to current curators and the Organization account, only where the scope exists. */
export async function canOpenCare(actorId: string): Promise<boolean> {
    if (!isOrgScopeEnabled()) return false;
    const scope = await getOrgUserId();
    return (
        scope !== null &&
        (scope === actorId || (await userCuratesOrganizationNow(actorId)))
    );
}

/** Recheck every Care request and mutation against the current Organization capability. */
export async function requireCareCurator(actorId: string): Promise<string> {
    if (!isOrgScopeEnabled())
        throw new AppError(ErrorCode.NOT_FOUND, "Organization not found", 404);
    const scope = await getOrgUserId();
    if (!scope)
        throw new AppError(ErrorCode.NOT_FOUND, "Organization not found", 404);
    if (actorId !== scope && !(await userCuratesOrganizationNow(actorId)))
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only an Organization curator can curate the Almanac",
            403,
        );
    return scope;
}
