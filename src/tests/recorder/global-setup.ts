import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Metafile } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const buildScript = "extensions/recorder/build.mjs";
const generated = "extensions/recorder/generated";

async function isCurrent() {
    try {
        const meta: Metafile & { cssInputs?: string[] } = JSON.parse(
            await readFile(resolve(root, generated, "meta.json"), "utf8"),
        );
        if (!meta.cssInputs?.length) return false;

        const inputs = [
            buildScript,
            "package.json",
            "pnpm-lock.yaml",
            "tsconfig.json",
            ...Object.keys(meta.inputs),
            ...meta.cssInputs,
        ];
        const outputs = [
            `${generated}/meta.json`,
            `${generated}/folders.js`,
            `${generated}/text.js`,
            `${generated}/folders.css`,
            ...Object.keys(meta.outputs),
        ];
        const [sources, assets] = await Promise.all([
            Promise.all(inputs.map((path) => stat(resolve(root, path)))),
            Promise.all(outputs.map((path) => stat(resolve(root, path)))),
        ]);
        return (
            Math.max(...sources.map((source) => source.mtimeMs)) <=
            Math.min(...assets.map((asset) => asset.mtimeMs))
        );
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            return false;
        }
        throw error;
    }
}

export default async function setup() {
    if (await isCurrent()) return;
    execFileSync(process.execPath, [buildScript], {
        cwd: root,
        stdio: "inherit",
    });
}
