// Package the extension into a distributable zip.
//
// Run from the repository root so `archiver` resolves:
//   node extensions/recorder/pack.mjs
//
// Produces extensions/recorder/dist/chatterbox-recorder-<version>.zip, suitable
// for a Chrome Web Store upload or manual distribution. For local
// development you do not need this: load the extensions/recorder folder as an
// unpacked extension instead.

import { ZipArchive } from "archiver";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
    await readFile(join(here, "manifest.json"), "utf8"),
);
const storeManifest = { ...manifest };
delete storeManifest.key;
const distDir = join(here, "dist");
await mkdir(distDir, { recursive: true });
const outPath = join(distDir, `chatterbox-recorder-${manifest.version}.zip`);

const output = createWriteStream(outPath);
const archive = new ZipArchive({ zlib: { level: 9 } });

const done = new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
});

archive.pipe(output);
archive.append(`${JSON.stringify(storeManifest, null, 4)}\n`, {
    name: "manifest.json",
});
// Everything the extension needs at runtime; nothing else.
for (const entry of [
    "service-worker.js",
    "content-pairing.js",
    "probe.png",
    "lib",
    "_locales",
    "offscreen",
    "popup",
    "picker",
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
