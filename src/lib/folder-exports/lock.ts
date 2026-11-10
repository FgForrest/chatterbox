import { withFolderExportLocks } from "@/db/queries/folder-export-locks";

/**
 * Runs `work` under an advisory lock on one export configuration.
 *
 * Planning takes it exclusively: it renames directories on disk and moves
 * every stored path with them. Writing and checking files take it shared,
 * and read their paths inside it. Without it, a job holding a path from
 * before a rename recreated the old directory -- empty, or with the file
 * the new directory was missing -- and two planners could each rename on
 * a view of the tree the other had already changed.
 *
 * A session lock on a reserved connection, not a transaction lock: audio
 * streams for minutes, and an open transaction would sit idle all that
 * time. A process that dies drops its connection, and the lock with it.
 */
export async function withExportLock<T>(
    exportId: string,
    mode: "exclusive" | "shared",
    work: () => Promise<T>,
): Promise<T> {
    return withFolderExportLocks([exportId], mode, work);
}

/** Hold several export locks on one connection so large subtree deletion cannot exhaust the pool. */
export async function withExportLocks<T>(
    exportIds: string[],
    work: () => Promise<T>,
): Promise<T> {
    return withFolderExportLocks(exportIds, "exclusive", work);
}
