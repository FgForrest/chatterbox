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

    async removeSubtree(logicalPath: string): Promise<void> {
        for (const key of [...this.nodes.keys()]) {
            if (key === logicalPath || key.startsWith(`${logicalPath}/`)) {
                this.nodes.delete(key);
            }
        }
    }

    async movePrefix(previous: string, current: string): Promise<void> {
        const moved = [...this.nodes].filter(
            ([key]) => key === previous || key.startsWith(`${previous}/`),
        );
        for (const [key] of moved) this.nodes.delete(key);
        for (const [key, kind] of moved) {
            this.nodes.set(`${current}${key.slice(previous.length)}`, kind);
        }
    }

    /** Sorted `kind:path` lines, for comparing in tests. */
    entries(): string[] {
        return [...this.nodes].map(([key, kind]) => `${kind}:${key}`).sort();
    }
}
