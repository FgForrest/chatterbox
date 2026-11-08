import { buildRecorder } from "./build.mjs";
import { ZipArchive } from "archiver";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
await buildRecorder();
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
    "content-meeting.js",
    "probe.png",
    "lib",
    "_locales",
    "offscreen",
    "popup",
    "picker",
    "request",
    "options",
    "agenda",
    "icons",
    "generated",
]) {
    const full = join(here, entry);
    if (entry.includes(".")) {
        archive.file(full, { name: entry });
    } else {
        archive.glob("**/*", { cwd: full, ignore: ["meta.json"] }, { prefix: entry });
    }
}
await archive.finalize();
await done;

console.log(`Packed ${outPath} (${archive.pointer()} bytes)`);
