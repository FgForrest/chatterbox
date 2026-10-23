import { eq } from "drizzle-orm";
import { db } from "@/db";
import { recordingFolders } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { folderDisplayPath } from "@/lib/folders/labels";
import { privateTreeFolders } from "@/lib/folders/private-tree";

export interface TaskFolder {
    id: string;
    name: string;
    path: string;
}

/** Caller-owned Private folder metadata, with decrypted names and full paths. */
export async function loadTaskFolders(
    userId: string,
    executor: Pick<typeof db, "select"> = db,
): Promise<Map<string, TaskFolder>> {
    const rows = await executor
        .select()
        .from(recordingFolders)
        .where(eq(recordingFolders.userId, userId));
    const folders = privateTreeFolders(
        rows.map((row) => ({
            ...row,
            scope: "personal",
            name: decryptText(row.name),
        })),
    );
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    return new Map(
        folders
            .filter((folder) => folder.kind !== "private")
            .map((folder) => [
                folder.id,
                {
                    id: folder.id,
                    name: folder.name,
                    path: folderDisplayPath(
                        folder,
                        byId,
                        (entry) => entry.name,
                    ),
                },
            ]),
    );
}

/** Validate a folder while the caller holds their private-tree lock. */
export async function requireTaskFolder(
    userId: string,
    folderId: string,
    executor: Pick<typeof db, "select">,
): Promise<string> {
    if (!(await loadTaskFolders(userId, executor)).has(folderId))
        throw new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
    return folderId;
}
