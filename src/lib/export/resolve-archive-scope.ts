import { AppError, ErrorCode } from "@/lib/errors";
import type { ArchiveScope } from "@/lib/export/archive-scope";
import { isOrgAccount, isOrgScopeVisible } from "@/lib/org/config";

/**
 * The scope an account's backups and exports carry: the Organization's for
 * the organization account, the account's own for everyone else. The
 * organization account on an instance that shows no Organization has
 * nothing it may export (409).
 */
export async function resolveArchiveScope(
    userId: string,
): Promise<ArchiveScope> {
    if (!(await isOrgAccount(userId))) return { kind: "personal", userId };
    if (!isOrgScopeVisible()) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "This instance shows no Organization to back up",
            409,
        );
    }
    return { kind: "organization", orgUserId: userId };
}

/**
 * Which scope an account's backups carry, for showing it: never refuses,
 * unlike `resolveArchiveScope`, which decides what an archive may hold.
 */
export async function archiveScopeKind(
    userId: string,
): Promise<ArchiveScope["kind"]> {
    return (await isOrgAccount(userId)) ? "organization" : "personal";
}
