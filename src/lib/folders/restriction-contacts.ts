import {
    readableRestrictionContactFolder,
    storedFolderRestrictionContacts,
} from "@/db/queries/folder-restriction-contacts";
import { holderAccess } from "@/lib/authz/access-state";
import { AppError, ErrorCode } from "@/lib/errors";
import { isIdpAuthorization } from "@/lib/identity/factory";
import { getOrgUserId, isOrgScopeVisible } from "@/lib/org/config";

/** Restriction contacts disclose only stored access to readers of a custom Organization folder. */
export async function folderRestrictionContacts(
    userId: string,
    folderId: string,
) {
    const notFound = () =>
        new AppError(ErrorCode.NOT_FOUND, ErrorCode.NOT_FOUND, 404);
    if (!isOrgScopeVisible()) throw notFound();
    const orgUserId = await getOrgUserId();
    if (!orgUserId) throw notFound();
    const access = isIdpAuthorization()
        ? await holderAccess(userId, { verify: false })
        : null;
    const isCurator = isIdpAuthorization()
        ? !!access?.ok && access.capabilities.has("org.curate")
        : userId === orgUserId;
    if (
        !(await readableRestrictionContactFolder(
            { userId, isCurator },
            folderId,
            orgUserId,
        ))
    )
        throw notFound();

    const contacts = await storedFolderRestrictionContacts(folderId, orgUserId);
    const curators = contacts
        .filter((person) => person.isCurator)
        .map(({ id, name, email }) => ({ id, name, email }));
    const creator = contacts.find((person) => !person.isCurator);
    return {
        curators,
        creator: creator
            ? { id: creator.id, name: creator.name, email: creator.email }
            : null,
    };
}
