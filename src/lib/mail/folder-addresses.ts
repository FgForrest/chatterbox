import { AppError, ErrorCode } from "@/lib/errors";
import {
    assertOrganizationTreeManager,
    reachableCustomFolder,
} from "@/lib/folders/folders";
import {
    listFolderAddresses,
    removeFolderSecondaryAddress,
    setFolderAddress,
} from "@/lib/mail/addresses";
import { type MailAddressView, toAddressView } from "@/lib/mail/views";

function folderNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
}

async function writableFolder(
    userId: string,
    folderId: string,
    canCurate: boolean,
) {
    const folder = await reachableCustomFolder(userId, folderId);
    if (!folder) throw folderNotFound();
    if (!folder.writable) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "The Organization is read-only on this instance",
            403,
        );
    }
    assertOrganizationTreeManager([folder], canCurate);
    return folder;
}

/**
 * A custom folder's live addresses as `userId` reaches the folder, or its
 * whole subtree's (what deleting it stops); null when they cannot.
 */
export async function loadFolderAddresses(
    userId: string,
    folderId: string,
    {
        subtree = false,
        canCurate = false,
    }: { subtree?: boolean; canCurate?: boolean } = {},
): Promise<{ writable: boolean; addresses: MailAddressView[] } | null> {
    const folder = await reachableCustomFolder(userId, folderId);
    if (!folder) return null;
    const rows = await listFolderAddresses(
        subtree ? folder.subtreeIds : [folder.folderId],
    );
    return {
        writable:
            folder.writable && (folder.scope !== "org" || canCurate === true),
        addresses: rows.map(toAddressView),
    };
}

/**
 * Gives a folder the address `alias`; whoever may rename the folder may.
 * The previous one stays as a secondary address.
 */
export async function setFolderAlias(input: {
    userId: string;
    folderId: string;
    alias: string;
    canCurate?: boolean;
}): Promise<MailAddressView> {
    await writableFolder(
        input.userId,
        input.folderId,
        input.canCurate === true,
    );
    return toAddressView(
        await setFolderAddress({
            actorUserId: input.userId,
            folderId: input.folderId,
            alias: input.alias,
        }),
    );
}

/** Stops one of a folder's secondary addresses for good. */
export async function removeFolderAlias(input: {
    userId: string;
    folderId: string;
    addressId: string;
    canCurate?: boolean;
}): Promise<void> {
    await writableFolder(
        input.userId,
        input.folderId,
        input.canCurate === true,
    );
    await removeFolderSecondaryAddress({
        folderId: input.folderId,
        addressId: input.addressId,
    });
}
