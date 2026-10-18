import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import csMessages from "../../../messages/cs-CZ.json";
import enMessages from "../../../messages/en.json";

const forbiddenMessageBrand = /Chatterbox|Klepna|Klepn|Riffado|Mynah/i;
const forbiddenDocsBrand = /Riffado|Mynah/i;
const forbiddenSourceBrand = /Chatterbox|Klepna|Riffado/;

const messageAllowlist = [
    {
        reason: "hosted legal pages",
        ids: [
            "IfLya9",
            "DIQsOn",
            "fPAjvA",
            "nWqsKG",
            "T2dCIV",
            "VJ7Zo9",
            "N9U05d",
            "03Fc87",
        ],
    },
    {
        reason: "upstream attribution",
        ids: ["9QC3bk", "shmHYA"],
    },
    {
        reason: "hosted landing and announcement surfaces",
        ids: [
            "-l5jrS",
            "MfAdmD",
            "dtMxE0",
            "sw_TUF",
            "MaUrpu",
            "-nrowi",
            "g1kHSV",
            "Un6Wu-",
            "j8eXFe",
            "yHNFV3",
            "YwCwcp",
            "rr9FgW",
            "oj6Aps",
            "rTYd8N",
            "L9wZvZ",
            "dOlf9G",
            "J5K6oc",
            "Lw2X3x",
            "KVJ2N_",
            "A_m91e",
            "kxGlj0",
            "i0a3d3",
            "5cFZKS",
            "N5NAp8",
            "ZlaVcZ",
            "cKIHel",
            "aUU5wd",
            "xB0okk",
            "ObHnwe",
            "mkmriZ",
            "qIK9kQ",
            "Xp7Qsu",
            "iDnoDn",
            "LRkNI2",
            "Zn0tY-",
            "I9W-CI",
            "qDiwkQ",
            "8A2r9c",
            "IpKRpB",
            "WDjrp8",
            "OtewX_",
            "93JrVN",
            "yXxsFE",
            "09TOxt",
            "19BYSI",
            "o7KCI0",
            "ikt2EH",
            "fe3fmI",
            "1JBgUk",
            "D2ZtRC",
            "YknqH0",
            "2qPKF3",
            "Dt47MH",
            "tHhLab",
            "8T40v8",
            "RkLbIJ",
            "6yZmjo",
            "A1-sej",
            "oBvKOK",
            "79Q5gJ",
            "m0gBHt",
            "5ya0Me",
            "bpsvUI",
            "oEs5w3",
            "0YQxHr",
            "88dtBm",
            "d0psKP",
        ],
    },
    {
        reason: "hosted billing and campaign emails",
        ids: ["AdL9vO", "4VEbO2", "XLg0Vn", "iNHGDh", "4b41j2", "QI1DuW"],
    },
    {
        reason: "hosted-only transcription fallback in the profile editor",
        ids: ["lGtM5k"],
    },
] as const;

const docsAllowlist = [
    {
        reason: "upstream attribution",
        files: [/^index\.mdx$/, /^index\.cs-CZ\.mdx$/],
        value: /\[Riffado\]\(https:\/\/github\.com\/riffado\/riffado\)/,
    },
    {
        reason: "deprecated deploy variable",
        files: [
            /^self-hosting\/(install|upgrading|environment-variables)(\.cs-CZ)?\.mdx$/,
        ],
        value: /RIFFADO_VERSION/,
    },
    {
        reason: "existing end-to-end test identifiers",
        files: [/^self-hosting\/sso(\.cs-CZ)?\.mdx$/],
        value: /riffado-e2e|RIFFADO_E2E_APP_URL/,
    },
    {
        reason: "existing MCP client identifiers",
        files: [/^self-hosting\/mcp(\.cs-CZ)?\.mdx$/],
        value: /riffado-mcp/,
    },
    {
        reason: "public webhook API fields",
        files: [
            /^guides\/automation-and-webhooks(\.cs-CZ)?\.mdx$/,
            /^reference\/security-model(\.cs-CZ)?\.mdx$/,
        ],
        value: /X-Riffado-/,
    },
    {
        reason: "historical issue and upstream connector repositories",
        files: [/^guides\/connect-plaud-account(\.cs-CZ)?\.mdx$/],
        value: /\]\(https:\/\/github\.com\/riffado\/(riffado\/issues\/65|connector\/releases\/latest)\)/,
    },
] as const;

const sourceExclusions = [
    { reason: "tests may name every expected brand", files: /^src\/tests\// },
    {
        reason: "product name constants and locale mapping",
        files: /^src\/lib\/brand\.ts$/,
    },
    {
        reason: "server deployment mapping",
        files: /^src\/lib\/deployment-brand\.ts$/,
    },
    {
        reason: "hosted-only implementation modules",
        files: /^src\/lib\/hosted\//,
    },
    {
        reason: "hosted-only app route group",
        files: /^src\/app\/\(hosted\)\//,
    },
    {
        reason: "hosted-only marketing routes",
        files: /^src\/app\/(page\.tsx|for-professionals\/|rebrand\/|updates\/|changelog\/|\(legal\)\/)/,
    },
    {
        reason: "hosted-only Stripe routes",
        files: /^src\/app\/api\/stripe\//,
    },
] as const;

const sourceAllowlist = [
    {
        reason: "hosted-only marketing components",
        files: /^src\/components\/(landing\/|landing-footer\.tsx$)/,
        value: forbiddenSourceBrand,
    },
    {
        reason: "hosted historical rebrand notices",
        files: /^src\/components\/rebrand-(announcement-bar|banner)\.tsx$/,
        value: /OpenPlaud is now Riffado\./,
    },
    {
        reason: "public webhook API header names",
        files: /^src\/lib\/webhooks\/worker\.ts$/,
        value: /Riffado/,
    },
    {
        reason: "historical rebrand copy",
        files: /^src\/lib\/(public-changelog|seo\/og-cards)\.ts$/,
        value: /Riffado/,
    },
    {
        reason: "hosted billing plan default",
        files: /^src\/lib\/env\.ts$/,
        value: /^Riffado Hosted Pro$/,
    },
] as const;

function walkFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...walkFiles(path));
        else files.push(path);
    }
    return files;
}

describe("self-host branding", () => {
    it.each([
        ["en", enMessages],
        ["cs-CZ", csMessages],
    ] as const)("keeps forbidden brands out of %s messages", (_locale, messages) => {
        const allowed = new Set<string>(
            messageAllowlist.flatMap((group) => group.ids),
        );
        const matches = Object.entries(messages)
            .filter(([, value]) => forbiddenMessageBrand.test(value))
            .map(([id]) => id);

        expect(matches.filter((id) => !allowed.has(id))).toEqual([]);
        expect([...allowed].filter((id) => !matches.includes(id))).toEqual([]);
    });

    it("keeps forbidden brands out of self-host documentation", () => {
        const docsRoot = join(process.cwd(), "content/docs");
        const unexpected: string[] = [];
        const matchedRules = new Set<number>();

        for (const file of walkFiles(docsRoot)) {
            const path = relative(docsRoot, file);
            const lines = readFileSync(file, "utf8").split("\n");
            lines.forEach((line, index) => {
                if (!forbiddenDocsBrand.test(line)) return;
                const ruleIndex = docsAllowlist.findIndex(
                    (rule) =>
                        rule.files.some((pattern) => pattern.test(path)) &&
                        rule.value.test(line),
                );
                if (ruleIndex === -1) unexpected.push(`${path}:${index + 1}`);
                else matchedRules.add(ruleIndex);
            });
        }

        expect(unexpected).toEqual([]);
        expect(
            [...docsAllowlist.keys()].filter((i) => !matchedRules.has(i)),
        ).toEqual([]);
    });

    it("keeps hardcoded product names out of shared source strings", () => {
        const sourceRoot = process.cwd();
        const unexpected: string[] = [];
        const matchedRules = new Set<number>();
        const sourceFiles = walkFiles(join(sourceRoot, "src")).filter((file) =>
            /\.tsx?$/.test(file),
        );

        for (const file of sourceFiles) {
            const path = relative(sourceRoot, file);
            if (sourceExclusions.some((rule) => rule.files.test(path))) {
                continue;
            }
            const sourceFile = ts.createSourceFile(
                path,
                readFileSync(file, "utf8"),
                ts.ScriptTarget.Latest,
                true,
                path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
            );
            const inspect = (node: ts.Node): void => {
                const text =
                    ts.isStringLiteralLike(node) ||
                    ts.isTemplateHead(node) ||
                    ts.isTemplateMiddle(node) ||
                    ts.isTemplateTail(node) ||
                    ts.isJsxText(node)
                        ? node.text
                        : null;
                if (text && forbiddenSourceBrand.test(text)) {
                    const ruleIndex = sourceAllowlist.findIndex(
                        (rule) =>
                            rule.files.test(path) && rule.value.test(text),
                    );
                    if (ruleIndex === -1) {
                        const line =
                            sourceFile.getLineAndCharacterOfPosition(
                                node.getStart(sourceFile),
                            ).line + 1;
                        unexpected.push(`${path}:${line}`);
                    } else {
                        matchedRules.add(ruleIndex);
                    }
                }
                ts.forEachChild(node, inspect);
            };
            inspect(sourceFile);
        }

        expect(unexpected).toEqual([]);
        expect(
            [...sourceAllowlist.keys()].filter((i) => !matchedRules.has(i)),
        ).toEqual([]);
    });
});
