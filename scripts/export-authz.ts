/**
 * Print Chatterbox's authorization catalog (capabilities, MCP permissions,
 * implications) as deterministic JSON, or write it to a file:
 *
 *   bun scripts/export-authz.ts [--out <file>]
 *
 * This command prints data only and never connects to an identity provider.
 */

import { writeFile } from "node:fs/promises";
import { serializeAuthzCatalog } from "../src/lib/authz/export";

const out = process.argv.indexOf("--out");
const text = serializeAuthzCatalog();
if (out >= 0 && process.argv[out + 1]) {
    await writeFile(process.argv[out + 1] as string, text);
} else {
    process.stdout.write(text);
}
