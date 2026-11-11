import { sqlClient } from "@/db";
import { AppError, ErrorCode } from "@/lib/errors";

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
            const [result] =
                mode === "exclusive"
                    ? await connection<
                          { acquired: boolean }[]
                      >`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired`
                    : await connection<
                          { acquired: boolean }[]
                      >`select pg_try_advisory_lock_shared(hashtextextended(${key}, 0)) as acquired`;
            if (!result.acquired)
                throw new AppError(
                    ErrorCode.EXPORT_LOCK_BUSY,
                    "Another operation is using this export. Try again.",
                    409,
                    { retryable: true },
                );
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
