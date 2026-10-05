import { constants } from "node:fs";
import {
    lstat,
    mkdir,
    open,
    readdir,
    realpath,
    rename,
    rmdir,
    unlink,
} from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type {
    FilesystemNodeKind,
    FilesystemNodeStore,
} from "./filesystem-nodes";
import type { ExpectedArtifact, ExportProvider, OwnedEntryKind } from "./types";

export const MAX_EXPORT_PATH_LENGTH = 1024;

/** A file the export did not create sits where it has to write. */
export class ExportPathTakenError extends Error {
    constructor(relativePath: string) {
        super(
            `A file Riffado did not create is in the way of the export at ${relativePath}`,
        );
        this.name = "ExportPathTakenError";
    }
}

export function validateRelativeExportPath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_EXPORT_PATH_LENGTH) {
        throw new Error("Export path must be between 1 and 1024 characters");
    }
    if (trimmed.includes("\0") || trimmed.includes("\\")) {
        throw new Error("Export path contains invalid characters");
    }
    if (path.posix.isAbsolute(trimmed)) {
        throw new Error("Export path must be relative to the configured root");
    }
    const parts = trimmed.split("/");
    if (
        parts.some(
            (part) =>
                part.length === 0 ||
                part === "." ||
                part === ".." ||
                part.length > 255,
        )
    ) {
        throw new Error("Export path contains an invalid segment");
    }
    return parts.join("/");
}

function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
}

function isMissing(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
}

async function directoryExists(target: string): Promise<boolean> {
    try {
        const stat = await lstat(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error("Export directory is not a regular directory");
        }
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

async function entryExists(target: string): Promise<boolean> {
    try {
        await lstat(target);
        return true;
    } catch (error) {
        if (isMissing(error)) return false;
        throw error;
    }
}

async function isKind(target: string, kind: OwnedEntryKind): Promise<boolean> {
    try {
        const stat = await lstat(target);
        if (stat.isSymbolicLink()) return false;
        return kind === "directory" ? stat.isDirectory() : stat.isFile();
    } catch (error) {
        if (isMissing(error)) return false;
        throw error;
    }
}

/**
 * An export into a directory under `FILESYSTEM_EXPORT_ROOT`.
 *
 * Every file and directory it creates is recorded in the node store before
 * it exists on disk, so the store always covers what the export made. It
 * moves, overwrites and deletes only those; anything else under the root is
 * someone's own and is left exactly where it is.
 */
export class FilesystemExportProvider implements ExportProvider {
    private readonly root: string;
    private readonly nodes: FilesystemNodeStore;
    /** The node store, loaded once a plan starts. */
    private snapshot: Map<string, FilesystemNodeKind> | null = null;

    constructor(root: string, nodes: FilesystemNodeStore) {
        if (!root) throw new Error("Filesystem export is not configured");
        this.root = root;
        this.nodes = nodes;
    }

    private async loadSnapshot(): Promise<Map<string, FilesystemNodeKind>> {
        this.snapshot ??= await this.nodes.list();
        return this.snapshot;
    }

    private async owned(
        relativePath: string,
    ): Promise<FilesystemNodeKind | null> {
        if (this.snapshot) return this.snapshot.get(relativePath) ?? null;
        return this.nodes.get(relativePath);
    }

    private async claim(
        relativePath: string,
        kind: FilesystemNodeKind,
    ): Promise<void> {
        await this.nodes.put(relativePath, kind);
        this.snapshot?.set(relativePath, kind);
    }

    private async release(relativePath: string): Promise<void> {
        await this.nodes.removeSubtree(relativePath);
        if (!this.snapshot) return;
        for (const key of [...this.snapshot.keys()]) {
            if (key === relativePath || key.startsWith(`${relativePath}/`)) {
                this.snapshot.delete(key);
            }
        }
    }

    private async moveClaims(previous: string, current: string): Promise<void> {
        await this.nodes.removeSubtree(current);
        await this.nodes.movePrefix(previous, current);
        if (!this.snapshot) return;
        const moved: Array<[string, FilesystemNodeKind]> = [];
        for (const key of [...this.snapshot.keys()]) {
            if (key === current || key.startsWith(`${current}/`)) {
                this.snapshot.delete(key);
            }
        }
        for (const [key, kind] of [...this.snapshot]) {
            if (key === previous || key.startsWith(`${previous}/`)) {
                this.snapshot.delete(key);
                moved.push([`${current}${key.slice(previous.length)}`, kind]);
            }
        }
        for (const [key, kind] of moved) this.snapshot.set(key, kind);
    }

    /**
     * The absolute path of `relativePath`, refusing symlinks and anything
     * outside the root on the way. With `create`, missing parent
     * directories are created as the export's own; without it, a missing
     * parent gives null.
     */
    private async resolve(
        relativePath: string,
        create: boolean,
    ): Promise<{ root: string; target: string } | null> {
        if (!path.isAbsolute(this.root)) {
            throw new Error("FILESYSTEM_EXPORT_ROOT must be an absolute path");
        }
        await mkdir(this.root, { recursive: true });
        const root = await realpath(this.root);
        const normalized = validateRelativeExportPath(relativePath);
        const parts = normalized.split("/");
        const name = parts.pop();
        if (!name) throw new Error("Export path needs a name");

        let parent = root;
        let logical = "";
        for (const part of parts) {
            logical = logical ? `${logical}/${part}` : part;
            const candidate = path.join(parent, part);
            try {
                const stat = await lstat(candidate);
                if (stat.isSymbolicLink() || !stat.isDirectory()) {
                    throw new Error(
                        "Export path crosses a non-directory or symlink",
                    );
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
                if (!create) return null;
                await this.makeDirectory(logical, candidate);
            }
            parent = await realpath(candidate);
            if (!isWithin(root, parent)) {
                throw new Error("Export path escapes the configured root");
            }
        }
        return { root, target: path.join(parent, name) };
    }

    private async makeDirectory(
        relativePath: string,
        target: string,
    ): Promise<void> {
        await this.claim(relativePath, "directory");
        try {
            await mkdir(target);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }
    }

    /** Whether everything beneath a directory is the export's own. */
    private async onlyOwnedUnder(
        target: string,
        relativePath: string,
    ): Promise<boolean> {
        for (const entry of await readdir(target, { withFileTypes: true })) {
            const logical = `${relativePath}/${entry.name}`;
            const kind = await this.owned(logical);
            if (entry.isDirectory()) {
                if (
                    kind !== "directory" ||
                    !(await this.onlyOwnedUnder(
                        path.join(target, entry.name),
                        logical,
                    ))
                ) {
                    return false;
                }
            } else if (!entry.isFile() || kind !== "file") {
                return false;
            }
        }
        return true;
    }

    async exists(
        relativePath: string,
        expected: ExpectedArtifact,
    ): Promise<boolean> {
        if ((await this.owned(relativePath)) !== "file") return false;
        // Only looks: a check that created the directories on its way
        // left an empty one behind for every path that had since moved.
        const resolved = await this.resolve(relativePath, false);
        if (!resolved) return false;
        const { root, target } = resolved;
        if (!isWithin(root, target)) return false;
        try {
            const stat = await lstat(target);
            return (
                !stat.isSymbolicLink() &&
                stat.isFile() &&
                stat.size === expected.size
            );
        } catch (error) {
            if (isMissing(error)) return false;
            throw error;
        }
    }

    async foreignNames(relativePath: string): Promise<Set<string>> {
        const owned = await this.loadSnapshot();
        const resolved = await this.resolve(relativePath, false);
        if (!resolved || !(await isKind(resolved.target, "directory"))) {
            return new Set();
        }
        const names = await readdir(resolved.target);
        return new Set(
            names.filter((name) => !owned.has(`${relativePath}/${name}`)),
        );
    }

    async reconcileDirectory(
        previousPath: string | null,
        currentPath: string,
    ): Promise<{ contentPreserved: boolean }> {
        await this.loadSnapshot();
        const current = await this.resolve(currentPath, true);
        if (!current) throw new Error("Export directory has no parent");
        const currentExists = await directoryExists(current.target);
        const moving = previousPath !== null && previousPath !== currentPath;

        if (moving && !currentExists) {
            const previous = await this.resolve(previousPath, false);
            if (
                previous &&
                (await directoryExists(previous.target)) &&
                (await this.owned(previousPath)) === "directory" &&
                (await this.onlyOwnedUnder(previous.target, previousPath))
            ) {
                await this.moveClaims(previousPath, currentPath);
                await rename(previous.target, current.target);
                return { contentPreserved: true };
            }
        }

        if (currentExists) return { contentPreserved: !moving };
        await this.makeDirectory(currentPath, current.target);
        return { contentPreserved: false };
    }

    async moveFile(from: string, to: string): Promise<boolean> {
        if ((await this.owned(from)) !== "file") return false;
        const source = await this.resolve(from, false);
        if (!source || !(await isKind(source.target, "file"))) return false;
        const destination = await this.resolve(to, true);
        if (!destination || (await entryExists(destination.target))) {
            return false;
        }
        await this.claim(to, "file");
        try {
            await rename(source.target, destination.target);
        } catch (error) {
            await this.release(to);
            throw error;
        }
        await this.release(from);
        return true;
    }

    async removeFile(
        relativePath: string,
        _options: { duplicate: boolean },
    ): Promise<boolean> {
        if ((await this.owned(relativePath)) !== "file") return false;
        const resolved = await this.resolve(relativePath, false);
        if (!resolved || !(await isKind(resolved.target, "file"))) {
            // Gone, or replaced by something that is not the export's.
            await this.release(relativePath);
            return false;
        }
        try {
            await unlink(resolved.target);
        } catch (error) {
            if (!isMissing(error)) throw error;
        }
        await this.release(relativePath);
        return true;
    }

    async removeEmptyDirectory(relativePath: string): Promise<boolean> {
        if ((await this.owned(relativePath)) !== "directory") return false;
        const resolved = await this.resolve(relativePath, false);
        if (
            !resolved ||
            !isWithin(resolved.root, resolved.target) ||
            !(await isKind(resolved.target, "directory"))
        ) {
            await this.release(relativePath);
            return false;
        }
        try {
            await rmdir(resolved.target);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOTEMPTY" || code === "EEXIST") return false;
            if (!isMissing(error)) throw error;
        }
        await this.release(relativePath);
        return true;
    }

    async ownedEntries(): Promise<Map<string, OwnedEntryKind>> {
        return new Map(await this.loadSnapshot());
    }

    async forgetMissing(): Promise<void> {
        const owned = await this.loadSnapshot();
        for (const [relativePath, kind] of [...owned]) {
            if (!owned.has(relativePath)) continue;
            let present = false;
            try {
                const resolved = await this.resolve(relativePath, false);
                present = resolved
                    ? await isKind(resolved.target, kind)
                    : false;
            } catch {
                present = false;
            }
            if (!present) await this.release(relativePath);
        }
    }

    async adopt(entries: ReadonlyMap<string, OwnedEntryKind>): Promise<void> {
        await this.loadSnapshot();
        for (const [relativePath, kind] of entries) {
            if (await this.owned(relativePath)) continue;
            try {
                const resolved = await this.resolve(relativePath, false);
                if (resolved && (await isKind(resolved.target, kind))) {
                    await this.claim(relativePath, kind);
                }
            } catch {
                // Not a path the export could have written: leave it.
            }
        }
    }

    async materialize(
        relativePath: string,
        content: Buffer | Readable,
    ): Promise<void> {
        const resolved = await this.resolve(relativePath, true);
        if (!resolved || !isWithin(resolved.root, resolved.target)) {
            throw new Error("Export path escapes the configured root");
        }
        const { root, target } = resolved;
        try {
            const current = await lstat(target);
            if (current.isSymbolicLink() || !current.isFile()) {
                throw new Error("Export target is not a regular file");
            }
            if ((await this.owned(relativePath)) !== "file") {
                throw new ExportPathTakenError(relativePath);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        const suffix = `.riffado-${crypto.randomUUID()}.tmp`;
        const temporary = `${target}${suffix}`;
        const temporaryPath = `${relativePath}${suffix}`;
        await this.claim(temporaryPath, "file");
        const handle = await open(
            temporary,
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_WRONLY |
                constants.O_NOFOLLOW,
            0o600,
        );
        try {
            if (Buffer.isBuffer(content)) {
                await handle.writeFile(content);
            } else {
                // Written chunk by chunk through the handle rather than piped
                // into `handle.createWriteStream({ autoClose: false })`: that
                // stream never emits `close`, so `pipeline` never settles and
                // every streamed (audio) export hung until its job timed out.
                for await (const chunk of content) {
                    await handle.write(
                        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                    );
                }
            }
            await handle.sync();
            await handle.close();
            const parent = await realpath(path.dirname(target));
            if (!isWithin(root, parent)) {
                throw new Error("Export path changed during materialization");
            }
            await this.claim(relativePath, "file");
            await rename(temporary, target);
        } catch (error) {
            await handle.close().catch(() => {});
            await unlink(temporary).catch(() => {});
            await this.release(temporaryPath);
            throw error;
        }
        await this.release(temporaryPath);
    }
}
