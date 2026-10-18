import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import csMessages from "../../../messages/cs-CZ.json";
import enMessages from "../../../messages/en.json";

const forbiddenBrand = /Riffado|Mynah/i;

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
        ids: [
            "72hXBy",
            "e_80xo",
            "EH1h-J",
            "Q4-QGK",
            "1m5mpM",
            "-YD2Ne",
            "HOhb5L",
            "Olsl1l",
            "KpXYt-",
            "1gPeBR",
            "v8YuKu",
            "I8FN3p",
            "cBxAXf",
            "pn5qlo",
            "GAAmZ5",
            "8UPn8T",
            "mQPvT4",
            "0-fOE9",
            "AdL9vO",
            "4VEbO2",
            "M18Mt5",
            "s3Qeks",
            "F--PHk",
            "wFJyLm",
            "pOEUXT",
            "C_tF0p",
            "u6-FVa",
            "fZRas7",
            "QI1DuW",
            "l3TOjG",
        ],
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
            .filter(([, value]) => forbiddenBrand.test(value))
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
                if (!forbiddenBrand.test(line)) return;
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
});
