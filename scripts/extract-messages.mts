import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { unstable_extractMessages } from "next-intl/extractor";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const messagesPath = join(root, "messages");
const locales = ["en", "cs-CZ"] as const;
const { values } = parseArgs({
    options: { check: { type: "boolean", default: false } },
    allowPositionals: false,
    strict: true,
});

async function extract(path: string): Promise<void> {
    await unstable_extractMessages({
        srcPath: "./src",
        messages: {
            path: relative(root, path),
            format: "json",
            locales,
            sourceLocale: "en",
        },
    });
}

async function readCatalog(path: string): Promise<Record<string, string>> {
    return JSON.parse(await readFile(path, "utf8"));
}

if (!values.check) {
    await extract(messagesPath);
} else {
    const temporaryPath = await mkdtemp(join(tmpdir(), "chatterbox-messages-"));
    try {
        await extract(temporaryPath);
        let drift = false;
        for (const locale of locales) {
            const current = await readCatalog(
                join(messagesPath, `${locale}.json`),
            );
            const extracted = await readCatalog(
                join(temporaryPath, `${locale}.json`),
            ).catch((error: unknown) => {
                throw new Error(
                    `The extractor wrote no messages/${locale}.json`,
                    { cause: error },
                );
            });
            const missing = Object.keys(extracted).filter(
                (key) => !Object.hasOwn(current, key),
            );
            const stale = Object.keys(current).filter(
                (key) => !Object.hasOwn(extracted, key),
            );
            const changed =
                locale === "en"
                    ? Object.keys(extracted).filter(
                          (key) =>
                              Object.hasOwn(current, key) &&
                              current[key] !== extracted[key],
                      )
                    : [];
            const empty =
                locale === "cs-CZ"
                    ? Object.keys(current).filter((key) => !current[key].trim())
                    : [];
            for (const [kind, keys] of [
                ["missing", missing],
                ["stale", stale],
                ["changed English values", changed],
                ["empty Czech values", empty],
            ] as const) {
                if (keys.length === 0) continue;
                drift = true;
                console.error(
                    `messages/${locale}.json: ${kind}: ${keys.sort().join(", ")}`,
                );
            }
        }
        if (drift) {
            console.error(
                "Run pnpm i18n:extract, fill Czech translations, then format messages.",
            );
            process.exitCode = 1;
        } else {
            console.log("Message catalogs are current.");
        }
    } finally {
        await rm(temporaryPath, { recursive: true, force: true });
    }
}
