import { and, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { filesystemExportNodes } from "@/db/schema";

export type FilesystemNodeKind = "directory" | "file";

/** Where a filesystem export records the entries it created. */
export interface FilesystemNodeStore {
    /** Every entry, by logical path. */
    list(): Promise<Map<string, FilesystemNodeKind>>;
    get(logicalPath: string): Promise<FilesystemNodeKind | null>;
    put(logicalPath: string, kind: FilesystemNodeKind): Promise<void>;
    /** Forgets `logicalPath` and everything beneath it. */
    removeSubtree(logicalPath: string): Promise<void>;
    /** Re-roots `previous` and everything beneath it at `current`. */
    movePrefix(previous: string, current: string): Promise<void>;
}

function underPrefix(logicalPath: string) {
    const prefix = `${logicalPath}/`;
    return sql`left(${filesystemExportNodes.logicalPath}, char_length(${prefix}::text)) = ${prefix}::text`;
}

export class DbFilesystemNodeStore implements FilesystemNodeStore {
    constructor(
        private readonly userId: string,
        private readonly exportId: string,
    ) {}

    private scope() {
        return and(
            eq(filesystemExportNodes.userId, this.userId),
            eq(filesystemExportNodes.exportConfigurationId, this.exportId),
        );
    }

    private subtree(logicalPath: string) {
        return and(
            this.scope(),
            or(
                eq(filesystemExportNodes.logicalPath, logicalPath),
                underPrefix(logicalPath),
            ),
        );
    }

    async list(): Promise<Map<string, FilesystemNodeKind>> {
        const rows = await db
            .select({
                logicalPath: filesystemExportNodes.logicalPath,
                kind: filesystemExportNodes.kind,
            })
            .from(filesystemExportNodes)
            .where(this.scope());
        return new Map(rows.map((row) => [row.logicalPath, row.kind]));
    }

    async get(logicalPath: string): Promise<FilesystemNodeKind | null> {
        const [row] = await db
            .select({ kind: filesystemExportNodes.kind })
            .from(filesystemExportNodes)
            .where(
                and(
                    this.scope(),
                    eq(filesystemExportNodes.logicalPath, logicalPath),
                ),
            )
            .limit(1);
        return row?.kind ?? null;
    }

    async put(logicalPath: string, kind: FilesystemNodeKind): Promise<void> {
        await db
            .insert(filesystemExportNodes)
            .values({
                userId: this.userId,
                exportConfigurationId: this.exportId,
                logicalPath,
                kind,
            })
            .onConflictDoUpdate({
                target: [
                    filesystemExportNodes.exportConfigurationId,
                    filesystemExportNodes.logicalPath,
                ],
                set: { kind, updatedAt: new Date() },
            });
    }

    async removeSubtree(logicalPath: string): Promise<void> {
        await db.delete(filesystemExportNodes).where(this.subtree(logicalPath));
    }

    async movePrefix(previous: string, current: string): Promise<void> {
        await db
            .update(filesystemExportNodes)
            .set({
                logicalPath: sql`${current}::text || substr(${filesystemExportNodes.logicalPath}, char_length(${previous}::text) + 1)`,
                updatedAt: new Date(),
            })
            .where(this.subtree(previous));
    }
}
