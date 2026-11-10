import { sqlClient } from "@/db";

/** Acquire ordered session locks on one reserved connection, outside a database transaction. */
export async function withFolderExportLocks<T>(
    exportIds: string[],
    mode: "exclusive" | "shared",
    work: () => Promise<T>,
): Promise<T> {
    const ids = [...new Set(exportIds)].sort();
    if (!ids.length || !sqlClient) return work();
    const connection = await sqlClient.reserve();
    const locked: string[] = [];
    try {
        for (const id of ids) {
            const key = `folder_export:${id}`;
            if (mode === "exclusive")
                await connection`select pg_advisory_lock(hashtextextended(${key}, 0))`;
            else
                await connection`select pg_advisory_lock_shared(hashtextextended(${key}, 0))`;
            locked.push(key);
        }
        return await work();
    } finally {
        try {
            for (const key of locked.reverse()) {
                if (mode === "exclusive")
                    await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
                else
                    await connection`select pg_advisory_unlock_shared(hashtextextended(${key}, 0))`;
            }
        } finally {
            connection.release();
        }
    }
}
