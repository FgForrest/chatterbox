import type {
    FilesystemNodeKind,
    FilesystemNodeStore,
} from "@/lib/folder-exports/filesystem-nodes";

/** The filesystem node store, in memory, for tests that need no database. */
export class MemoryFilesystemNodeStore implements FilesystemNodeStore {
    readonly nodes = new Map<string, FilesystemNodeKind>();

    async list(): Promise<Map<string, FilesystemNodeKind>> {
        return new Map(this.nodes);
    }

    async get(logicalPath: string): Promise<FilesystemNodeKind | null> {
        return this.nodes.get(logicalPath) ?? null;
    }

    async put(logicalPath: string, kind: FilesystemNodeKind): Promise<void> {
        this.nodes.set(logicalPath, kind);
    }

    async putAll(
        entries: ReadonlyMap<string, FilesystemNodeKind>,
    ): Promise<void> {
        for (const [key, kind] of entries) this.nodes.set(key, kind);
    }

    async removeSubtree(logicalPath: string): Promise<void> {
        for (const key of [...this.nodes.keys()]) {
            if (key === logicalPath || key.startsWith(`${logicalPath}/`)) {
                this.nodes.delete(key);
            }
        }
    }

    /** Sorted `kind:path` lines, for comparing in tests. */
    entries(): string[] {
        return [...this.nodes].map(([key, kind]) => `${kind}:${key}`).sort();
    }
}
