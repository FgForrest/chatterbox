import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { AppError, ErrorCode } from "@/lib/errors";
import { resolveReadableFolder } from "@/lib/folders/folders";
import { isOrgAccount } from "@/lib/org/config";
import { WRITER_NO_LONGER_CURATOR_MESSAGE } from "./types";

/** Whether this writer may configure or run an Organization folder export now. */
export async function mayWriteOrganizationExport(userId: string) {
    return (
        (await isOrgAccount(userId)) ||
        (await userCuratesOrganizationNow(userId))
    );
}

/** Resolve content separately from the writer whose connection and ledger are used. */
export async function resolveFolderExportScope(
    userId: string,
    folderId: string,
    options: { cleanupRestricted?: boolean } = {},
): Promise<{
    contentUserId: string;
    isOrganization: boolean;
    restricted?: boolean;
    parentId?: string | null;
}> {
    const access = await resolveReadableFolder(userId, folderId);
    if (!access) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Export folder is no longer accessible",
            403,
        );
    }
    const restricted = !!(
        access.folder.restrictedAt || access.folder.restrictingAt
    );
    if (restricted && !options.cleanupRestricted)
        throw new AppError(
            ErrorCode.RESTRICTED_FOLDER_EXPORT,
            ErrorCode.RESTRICTED_FOLDER_EXPORT,
            409,
        );
    if (access.scope === "org") {
        if (!(await mayWriteOrganizationExport(userId))) {
            throw new AppError(
                ErrorCode.FORBIDDEN,
                WRITER_NO_LONGER_CURATOR_MESSAGE,
                403,
            );
        }
        return {
            contentUserId: access.ownerId,
            isOrganization: true,
            ...(restricted
                ? { restricted: true, parentId: access.folder.parentId }
                : {}),
        };
    }
    return { contentUserId: userId, isOrganization: false };
}
