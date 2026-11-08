import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Bundle local browser dependencies and compile the shared picker's Tailwind utilities. */
export async function buildRecorder() {
    await rm(join(here, "generated"), { recursive: true, force: true });
    await mkdir(join(here, "generated"), { recursive: true });
    const result = await build({
        entryPoints: [join(here, "bundle/folders.jsx"), join(here, "bundle/text.js")],
        outdir: join(here, "generated"), bundle: true, splitting: true, format: "esm", platform: "browser", target: "chrome116",
        jsx: "automatic", minify: true, metafile: true,
        define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PHASE": '""' },
    });
    const forbidden = Object.keys(result.metafile.inputs).filter((path) => /node_modules\/(next|server-only)\//.test(path));
    if (forbidden.length) throw new Error(`Next.js-only code in recorder: ${forbidden.join(", ")}`);
    const cssPath = join(here, "bundle/folders.css");
    const css = await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath });
    await writeFile(join(here, "generated/folders.css"), css.css);
    await writeFile(join(here, "generated/meta.json"), JSON.stringify(result.metafile, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildRecorder();
