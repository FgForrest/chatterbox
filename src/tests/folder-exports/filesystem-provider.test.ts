import { createReadStream } from "node:fs";
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    ExportPathTakenError,
    FilesystemExportProvider,
    validateRelativeExportPath,
} from "@/lib/folder-exports/filesystem-provider";
import {
    allocateDirectoryName,
    folderDirectory,
    recordingDirectory,
    safePathSegment,
} from "@/lib/folder-exports/naming";
import { MemoryFilesystemNodeStore } from "./memory-filesystem-nodes";

const roots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
    roots.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(
        roots.splice(0).map((root) => rm(root, { recursive: true })),
    );
});

const file = (size: number) => ({
    size,
    version: "v",
    format: "file" as const,
});

describe("filesystem export provider", () => {
    let root = "";
    let nodes: MemoryFilesystemNodeStore;

    function provider() {
        return new FilesystemExportProvider(root, nodes);
    }

    beforeEach(async () => {
        root = await tempDir("riffado-export-");
        nodes = new MemoryFilesystemNodeStore();
    });

    it("rejects traversal, absolute paths, backslashes, and malformed segments", () => {
        for (const value of ["../escape", "/absolute", "a\\b", "a//b", "./a"]) {
            expect(() => validateRelativeExportPath(value)).toThrow();
        }
        expect(validateRelativeExportPath("team/weekly/file.md")).toBe(
            "team/weekly/file.md",
        );
    });

    it("writes atomically, records what it created and is safe to repeat", async () => {
        await provider().materialize(
            "team/item/transcript.md",
            Buffer.from("one"),
        );
        await provider().materialize(
            "team/item/transcript.md",
            Buffer.from("two"),
        );
        expect(
            await readFile(path.join(root, "team/item/transcript.md"), "utf8"),
        ).toBe("two");
        expect(
            await provider().exists("team/item/transcript.md", file(3)),
        ).toBe(true);
        expect(nodes.entries()).toEqual([
            "directory:team",
            "directory:team/item",
            "file:team/item/transcript.md",
        ]);
        await expect(readdir(path.join(root, "team/item"))).resolves.toEqual([
            "transcript.md",
        ]);
    });

    it("finishes a streamed write, as audio exports are", async () => {
        const source = await tempDir("riffado-source-");
        await writeFile(path.join(source, "source.mp3"), "audio-bytes");
        await provider().materialize(
            "team/item/audio.mp3",
            createReadStream(path.join(source, "source.mp3")),
        );
        expect(
            await readFile(path.join(root, "team/item/audio.mp3"), "utf8"),
        ).toBe("audio-bytes");
    });

    it("never overwrites a file it did not write", async () => {
        await mkdir(path.join(root, "team/item"), { recursive: true });
        await writeFile(path.join(root, "team/item/audio.mp3"), "mine");
        const failure = await provider()
            .materialize("team/item/audio.mp3", Buffer.from("export"))
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ExportPathTakenError);
        expect(
            await readFile(path.join(root, "team/item/audio.mp3"), "utf8"),
        ).toBe("mine");
        expect(await provider().exists("team/item/audio.mp3", file(4))).toBe(
            false,
        );
    });

    it("rejects symlink traversal beneath the configured root", async () => {
        const outside = await tempDir("riffado-outside-");
        await symlink(outside, path.join(root, "linked"), "dir");
        await expect(
            provider().materialize("linked/file.md", Buffer.from("content")),
        ).rejects.toThrow(/symlink/);
    });

    it("uses readable names and disambiguates only actual collisions", () => {
        expect(safePathSegment("../Team/Notes", "recording")).toBe(
            "..-Team-Notes",
        );
        expect(recordingDirectory("Same title")).toBe("Same title");
        expect(folderDirectory("Team/Notes")).toBe("Team-Notes");
        expect(
            allocateDirectoryName("Same title", new Set(["Same title"])),
        ).toBe("Same title (2)");
        expect(
            allocateDirectoryName(
                "Same title",
                new Set(["Same title", "Same title (2)"]),
            ),
        ).toBe("Same title (3)");
    });

    it("renames its own directory and keeps what is in it", async () => {
        await provider().materialize(
            "team/Old recording/transcript.md",
            Buffer.from("content"),
        );
        await expect(
            provider().reconcileDirectory(
                "team/Old recording",
                "team/New recording",
            ),
        ).resolves.toEqual({ contentPreserved: true });
        await expect(
            readFile(
                path.join(root, "team/New recording/transcript.md"),
                "utf8",
            ),
        ).resolves.toBe("content");
        await expect(readdir(path.join(root, "team"))).resolves.toEqual([
            "New recording",
        ]);
        expect(nodes.entries()).toEqual([
            "directory:team",
            "directory:team/New recording",
            "file:team/New recording/transcript.md",
        ]);
    });

    it("does not carry someone's file along with a directory it moves", async () => {
        const p = provider();
        await p.materialize("team/Old/transcript.md", Buffer.from("content"));
        await writeFile(path.join(root, "team/Old/notes.txt"), "mine");
        await expect(
            p.reconcileDirectory("team/Old", "team/New"),
        ).resolves.toEqual({ contentPreserved: false });
        await expect(
            p.moveFile("team/Old/transcript.md", "team/New/transcript.md"),
        ).resolves.toBe(true);
        await expect(readdir(path.join(root, "team/Old"))).resolves.toEqual([
            "notes.txt",
        ]);
        await expect(readdir(path.join(root, "team/New"))).resolves.toEqual([
            "transcript.md",
        ]);
        await expect(p.removeEmptyDirectory("team/Old")).resolves.toBe(false);
    });

    it("never renames a directory it did not create", async () => {
        await mkdir(path.join(root, "team/Old recording"), { recursive: true });
        await writeFile(
            path.join(root, "team/Old recording/transcript.md"),
            "content",
        );
        await expect(
            provider().reconcileDirectory(
                "team/Old recording",
                "team/New recording",
            ),
        ).resolves.toEqual({ contentPreserved: false });
        await expect(readdir(path.join(root, "team"))).resolves.toEqual([
            "New recording",
            "Old recording",
        ]);
    });

    it("creates the new directory when the previous one is missing", async () => {
        await expect(
            provider().reconcileDirectory(
                "team/Missing recording",
                "team/New recording",
            ),
        ).resolves.toEqual({ contentPreserved: false });
        await provider().materialize(
            "team/New recording/transcript.md",
            Buffer.from("restored"),
        );
        await expect(
            readFile(
                path.join(root, "team/New recording/transcript.md"),
                "utf8",
            ),
        ).resolves.toBe("restored");
    });

    it("leaves the previous directory when the new one already exists", async () => {
        const p = provider();
        await p.reconcileDirectory(null, "team/One");
        await p.reconcileDirectory(null, "team/Two");
        await expect(
            p.reconcileDirectory("team/One", "team/Two"),
        ).resolves.toEqual({ contentPreserved: false });
        await expect(readdir(path.join(root, "team"))).resolves.toEqual([
            "One",
            "Two",
        ]);
    });

    it("checks a file without creating the directories on its path", async () => {
        const p = provider();
        await p.reconcileDirectory(null, "team/Old recording");
        await p.reconcileDirectory("team/Old recording", "team/New recording");
        // A path read before the rename used to recreate the old directory.
        await expect(
            p.exists("team/Old recording/transcript.md", file(7)),
        ).resolves.toBe(false);
        await expect(
            p.exists("gone/Old recording/transcript.md", file(7)),
        ).resolves.toBe(false);
        await expect(readdir(path.join(root, "team"))).resolves.toEqual([
            "New recording",
        ]);
        await expect(readdir(root)).resolves.toEqual(["team"]);
    });

    it("moves only its own files, and only to a free path", async () => {
        const p = provider();
        await p.materialize("a/audio.mp3", Buffer.from("abc"));
        await p.materialize("b/audio.mp3", Buffer.from("xyz"));
        await mkdir(path.join(root, "c"));
        await writeFile(path.join(root, "c/mine.mp3"), "mine");

        await expect(p.moveFile("a/audio.mp3", "b/audio.mp3")).resolves.toBe(
            false,
        );
        await expect(p.moveFile("c/mine.mp3", "d/mine.mp3")).resolves.toBe(
            false,
        );
        await expect(p.moveFile("a/audio.mp3", "d/e/audio.mp3")).resolves.toBe(
            true,
        );
        expect(await readFile(path.join(root, "d/e/audio.mp3"), "utf8")).toBe(
            "abc",
        );
        await expect(readdir(path.join(root, "a"))).resolves.toEqual([]);
        await expect(readdir(path.join(root, "c"))).resolves.toEqual([
            "mine.mp3",
        ]);
        expect(nodes.entries()).toEqual([
            "directory:a",
            "directory:b",
            "directory:d",
            "directory:d/e",
            "file:b/audio.mp3",
            "file:d/e/audio.mp3",
        ]);
    });

    it("deletes only its own files", async () => {
        const p = provider();
        await p.materialize("team/item/audio.mp3", Buffer.from("abc"));
        await writeFile(path.join(root, "team/item/notes.txt"), "mine");
        await expect(
            p.removeFile("team/item/notes.txt", { duplicate: false }),
        ).resolves.toBe(false);
        await expect(
            p.removeFile("team/item/audio.mp3", { duplicate: false }),
        ).resolves.toBe(true);
        await expect(readdir(path.join(root, "team/item"))).resolves.toEqual([
            "notes.txt",
        ]);
        expect(nodes.entries()).toEqual([
            "directory:team",
            "directory:team/item",
        ]);
    });

    it("removes only empty directories it created", async () => {
        const p = provider();
        await p.reconcileDirectory(null, "team/Empty");
        await p.reconcileDirectory(null, "team/Kept");
        await writeFile(path.join(root, "team/Kept/notes.md"), "mine");
        await mkdir(path.join(root, "team/Theirs"));
        await expect(p.removeEmptyDirectory("team/Empty")).resolves.toBe(true);
        await expect(p.removeEmptyDirectory("team/Kept")).resolves.toBe(false);
        await expect(p.removeEmptyDirectory("team/Theirs")).resolves.toBe(
            false,
        );
        await expect(p.removeEmptyDirectory("team/Missing")).resolves.toBe(
            false,
        );
        await expect(
            p.removeEmptyDirectory("team/Kept/notes.md"),
        ).resolves.toBe(false);
        await expect(readdir(path.join(root, "team"))).resolves.toEqual([
            "Kept",
            "Theirs",
        ]);
    });

    it("never removes through a symlink", async () => {
        const outside = await tempDir("riffado-outside-");
        await mkdir(path.join(outside, "empty"));
        const p = provider();
        await p.reconcileDirectory(null, "team");
        await symlink(outside, path.join(root, "team/Link"), "dir");
        nodes.nodes.set("team/Link", "directory");
        nodes.nodes.set("team/Link/empty", "directory");
        await expect(
            provider().removeEmptyDirectory("team/Link/empty"),
        ).rejects.toThrow(/symlink/);
        await expect(
            provider().removeEmptyDirectory("team/Link"),
        ).resolves.toBe(false);
        await expect(readdir(outside)).resolves.toEqual(["empty"]);
    });

    it("rejects symlink directories during rename reconciliation", async () => {
        const outside = await tempDir("riffado-outside-");
        await mkdir(path.join(root, "team"));
        await symlink(outside, path.join(root, "team/Stale"), "dir");
        await expect(
            provider().reconcileDirectory("team/Stale", "team/Current"),
        ).rejects.toThrow(/regular directory/);
    });

    it("names everything in a directory as taken, what it did not create as foreign", async () => {
        const p = provider();
        await p.reconcileDirectory(null, "team/Ours");
        await mkdir(path.join(root, "team/Theirs"));
        await writeFile(path.join(root, "team/notes.txt"), "mine");
        await expect(p.takenNames("team")).resolves.toEqual({
            names: new Set(["Ours", "Theirs", "notes.txt"]),
            foreign: new Set(["Theirs", "notes.txt"]),
        });
        await expect(p.takenNames("missing")).resolves.toEqual({
            names: new Set(),
            foreign: new Set(),
        });
    });

    it.skipIf(process.getuid?.() === 0)(
        "keeps its records on the old directory when the rename fails",
        async () => {
            const p = provider();
            await p.materialize("a/Old/audio.mp3", Buffer.from("abc"));
            await p.reconcileDirectory(null, "b");
            await chmod(path.join(root, "b"), 0o555);
            try {
                await expect(
                    p.reconcileDirectory("a/Old", "b/New"),
                ).rejects.toThrow();
            } finally {
                await chmod(path.join(root, "b"), 0o755);
            }
            expect(nodes.entries()).toEqual([
                "directory:a",
                "directory:a/Old",
                "directory:b",
                "file:a/Old/audio.mp3",
            ]);
            await expect(
                provider().exists("a/Old/audio.mp3", file(3)),
            ).resolves.toBe(true);
        },
    );

    it("forgets what someone removed and adopts what earlier versions wrote", async () => {
        const p = provider();
        await p.materialize("team/a/audio.mp3", Buffer.from("abc"));
        await rm(path.join(root, "team/a"), { recursive: true });
        await p.forgetMissing();
        expect(nodes.entries()).toEqual(["directory:team"]);

        await mkdir(path.join(root, "team/b"));
        await writeFile(path.join(root, "team/b/audio.mp3"), "abc");
        await provider().adopt(
            new Map([
                ["team/b", "directory"],
                ["team/b/audio.mp3", "file"],
                ["team/b/missing.md", "file"],
                ["team/b/audio.mp3/nested", "directory"],
            ]),
        );
        expect(nodes.entries()).toEqual([
            "directory:team",
            "directory:team/b",
            "file:team/b/audio.mp3",
        ]);
    });
});
