// Package the extension into a distributable zip.
//
// Run from the repository root so `archiver` (a Riffado dependency) resolves:
//   node extensions/recorder/pack.mjs
//
// Produces extensions/recorder/dist/riffado-recorder-<version>.zip, suitable
// for an unlisted Chrome Web Store upload or manual distribution. For local
// development you do not need this: load the extensions/recorder folder as an
// unpacked extension instead.

import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

// archiver@8 is ESM with named exports; import it from the repo-root
// node_modules so this script works run from the repository root.
const archiverUrl = pathToFileURL(
    join(process.cwd(), "node_modules", "archiver", "index.js"),
).href;
const { ZipArchive } = await import(archiverUrl);

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
    await readFile(join(here, "manifest.json"), "utf8"),
);
const distDir = join(here, "dist");
await mkdir(distDir, { recursive: true });
const outPath = join(distDir, `riffado-recorder-${manifest.version}.zip`);

const output = createWriteStream(outPath);
const archive = new ZipArchive({ zlib: { level: 9 } });

const done = new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
});

archive.pipe(output);
// Everything the extension needs at runtime; nothing else.
for (const entry of [
    "manifest.json",
    "service-worker.js",
    "content-pairing.js",
    "probe.png",
    "lib",
    "offscreen",
    "popup",
    "options",
    "icons",
]) {
    const full = join(here, entry);
    if (entry.includes(".")) {
        archive.file(full, { name: entry });
    } else {
        archive.directory(full, entry);
    }
}
await archive.finalize();
await done;

console.log(`Packed ${outPath} (${archive.pointer()} bytes)`);
