import ts from "typescript";
import { describe, expect, it } from "vitest";
import { auditTranslatorEscapes } from "../../../scripts/lib/translator-audit.mjs";

function programFor(files: Record<string, string>): ts.Program {
    const options: ts.CompilerOptions = {
        noLib: true,
        noResolve: true,
        jsx: ts.JsxEmit.ReactJSX,
    };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (file, languageVersion) => {
        const text = files[file];
        return text === undefined
            ? undefined
            : ts.createSourceFile(file, text, languageVersion, true);
    };
    host.readFile = (file) => files[file];
    host.fileExists = (file) => Object.hasOwn(files, file);
    return ts.createProgram(Object.keys(files), options, host);
}

describe("translator escape audit", () => {
    it("reports the escaped reference and accepts calls, closures and hook dependencies", () => {
        const program = programFor({
            "/audit/src/escaped.tsx": [
                'import { useExtracted as useMessages } from "next-intl";',
                "function Escaped() {",
                "  const tr = useMessages();",
                "  return helper(tr);",
                "}",
            ].join("\n"),
            "/audit/src/clean.tsx": `
                import { useExtracted } from "next-intl";
                import React, { useCallback as memoize, useEffect } from "react";
                function Clean() {
                    const i18n = useExtracted();
                    const callback = memoize(() => i18n("Save"), [i18n]);
                    useEffect(() => { i18n.rich("Hello"); }, [i18n]);
                    React.useMemo(() => i18n.markup("Markup"), [i18n]);
                    function nested() { return i18n("Nested"); }
                    return <button onClick={callback}>{nested()}</button>;
                }
                function unrelated(i18n: unknown) { return helper(i18n); }
            `,
        });

        expect(auditTranslatorEscapes(program)).toEqual([
            { file: "/audit/src/escaped.tsx", line: 4, snippet: "helper(tr)" },
        ]);
    });

    it.each([
        ["useExtracted", "next-intl", "renamed()"],
        ["useTranslations", "next-intl", "renamed()"],
        ["getExtracted", "next-intl/server", "await renamed()"],
        ["getTranslations", "next-intl/server", "await renamed()"],
    ])("tracks aliased %s bindings by symbol", (factory, module, initializer) => {
        const program = programFor({
            "/audit/src/aliases.ts": `
                import { ${factory} as renamed } from "${module}";
                async function example() {
                    const translator = ${initializer};
                    helper(translator);
                }
                function shadow(renamed: () => unknown) {
                    const translator = renamed();
                    helper(translator);
                }
            `,
        });

        expect(
            auditTranslatorEscapes(program).map(
                (reference) => reference.snippet,
            ),
        ).toEqual(["helper(translator)"]);
    });

    it("finds each escape through helpers, aliases, objects, props and returns", () => {
        const program = programFor({
            "/audit/src/forms.tsx": `
                import { useExtracted } from "next-intl";
                function Example() {
                    const t = useExtracted();
                    helper(t);
                    const alias = t;
                    const shorthand = { t };
                    const object = { translator: t };
                    const element = <Child translator={t} />;
                    const rich = t.rich;
                    arbitraryHook(() => {}, [t]);
                    return t;
                }
            `,
        });

        expect(
            auditTranslatorEscapes(program).map(
                (reference) => reference.snippet,
            ),
        ).toEqual([
            "helper(t)",
            "alias = t",
            "t",
            "translator: t",
            "{t}",
            "t.rich",
            "[t]",
            "return t;",
        ]);
    });

    it("tracks namespace imports and Promise.all bindings with omitted elements", () => {
        const program = programFor({
            "/audit/src/server.ts": `
                import * as intl from "next-intl/server";
                async function Example() {
                    const [, tr] = await Promise.all([null, intl.getExtracted()]);
                    tr("Clean");
                    helper(tr);
                    const t = await intl.getTranslations();
                    const object = { t };
                }
            `,
        });

        expect(
            auditTranslatorEscapes(program).map(
                (reference) => reference.snippet,
            ),
        ).toEqual(["helper(tr)", "t"]);
    });

    it("excludes test files and unrelated factory imports", () => {
        const escaped = `
            import { useExtracted } from "next-intl";
            function Example() {
                const t = useExtracted();
                return helper(t);
            }
        `;
        const program = programFor({
            "/audit/src/example.test.tsx": escaped,
            "/audit/src/example.spec.ts": escaped,
            "/audit/src/tests/fixture.ts": escaped,
            "/audit/src/__tests__/fixture.ts": escaped,
            "/audit/src/unrelated.ts": escaped.replace(
                '"next-intl"',
                '"./other"',
            ),
        });

        expect(auditTranslatorEscapes(program)).toEqual([]);
    });
});
