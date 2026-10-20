import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import cs from "../../../messages/cs-CZ.json";
import en from "../../../messages/en.json";

function filesIn(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
            ? filesIn(path)
            : /\.tsx?$/.test(path)
              ? [path]
              : [];
    });
}

function source(path: string) {
    return ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
}

function initializer(
    file: ts.SourceFile,
    name: string,
): ts.Expression | undefined {
    let value: ts.Expression | undefined;
    walk(file, (node) => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === name
        )
            value = node.initializer;
    });
    return value;
}

function expanded(
    node: ts.Node,
    file: ts.SourceFile,
    seen = new Set<string>(),
): string {
    let text = node.getText(file);
    walk(node, (child) => {
        if (!ts.isIdentifier(child) || seen.has(child.text)) return;
        const value = initializer(file, child.text);
        if (value) {
            seen.add(child.text);
            text += ` ${expanded(value, file, seen)}`;
        }
    });
    return text;
}

function translationAdapter(node: ts.Node): boolean {
    for (
        let parent: ts.Node | undefined = node;
        parent;
        parent = parent.parent
    ) {
        if (
            ts.isCallExpression(parent) &&
            parent.expression.getText() === "repairLearnReviewProse"
        )
            return true;
    }
    return false;
}

function hasSystemPrompt(
    node: ts.Node,
    file: ts.SourceFile,
    seen = new Set<string>(),
): boolean {
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
        seen.add(node.text);
        const value = initializer(file, node.text);
        return value ? hasSystemPrompt(value, file, seen) : false;
    }
    if (ts.isArrayLiteralExpression(node))
        return node.elements.some((item) => hasSystemPrompt(item, file, seen));
    if (ts.isObjectLiteralExpression(node)) {
        return node.properties.some(
            (property) =>
                (ts.isPropertyAssignment(property) ||
                    ts.isShorthandPropertyAssignment(property)) &&
                (property.name.getText(file) === "system" ||
                    (ts.isPropertyAssignment(property) &&
                        property.name.getText(file) === "role" &&
                        ts.isStringLiteral(property.initializer) &&
                        property.initializer.text === "system")),
        );
    }
    return false;
}

function promptViolations(file: ts.SourceFile): string[] {
    const failures: string[] = [];
    walk(file, (node) => {
        if (ts.isCallExpression(node)) {
            const callee = node.expression.getText(file);
            if (
                (callee.endsWith(".complete") || callee === "complete") &&
                !translationAdapter(node) &&
                (!node.arguments[0] ||
                    !hasSystemPrompt(node.arguments[0], file))
            ) {
                failures.push(
                    `${file.fileName}: completion without a system prompt`,
                );
            }
            if (
                callee.endsWith("completions.create") &&
                !file.fileName.endsWith("chat-clients.ts")
            )
                failures.push(
                    `${file.fileName}: completion bypasses Learn transport`,
                );
        }
        if (
            !ts.isPropertyAssignment(node) &&
            !ts.isShorthandPropertyAssignment(node)
        )
            return;
        const name = node.name.getText(file);
        const object = node.parent;
        const systemContent =
            name === "content" &&
            ts.isObjectLiteralExpression(object) &&
            object.properties.some(
                (property) =>
                    ts.isPropertyAssignment(property) &&
                    property.name.getText(file) === "role" &&
                    ts.isStringLiteral(property.initializer) &&
                    property.initializer.text === "system",
            );
        if (name !== "system" && !systemContent) return;
        const value = ts.isPropertyAssignment(node)
            ? node.initializer
            : node.name;
        if (
            file.fileName.endsWith("chat-clients.ts") &&
            value.getText(file) === "system"
        )
            return;
        const text = expanded(value, file);
        if (text.includes("learnReviewLanguageRule(")) return;
        if (text.includes('"mentions"') && !text.includes("reason")) return;
        if (
            value.getText(file) === "request.system" &&
            translationAdapter(node)
        )
            return;
        failures.push(
            `${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
        );
    });
    return failures;
}

function componentFiles(): string[] {
    const pending = [
        ...filesIn("src/components/learn"),
        "src/lib/knowledge/vocabulary-labels.ts",
        "src/components/people/use-speaker-label.ts",
        "src/components/items/item-header.tsx",
        "src/components/pipeline/workflow-indicator.tsx",
    ];
    const seen = new Set<string>();
    while (pending.length) {
        const path = resolve(pending.pop() ?? "");
        if (seen.has(path)) continue;
        seen.add(path);
        const file = source(path);
        const tags = new Set<string>();
        walk(file, (node) => {
            if (
                ts.isJsxOpeningElement(node) ||
                ts.isJsxSelfClosingElement(node)
            )
                tags.add(node.tagName.getText(file).split(".")[0]);
        });
        for (const statement of file.statements) {
            if (
                !ts.isImportDeclaration(statement) ||
                !ts.isStringLiteral(statement.moduleSpecifier) ||
                statement.importClause?.isTypeOnly
            )
                continue;
            const bindings = statement.importClause?.namedBindings;
            const names = [
                statement.importClause?.name?.text,
                ...(bindings && ts.isNamedImports(bindings)
                    ? bindings.elements
                          .filter((element) => !element.isTypeOnly)
                          .map((element) => element.name.text)
                    : []),
            ];
            if (!names.some((name) => name && tags.has(name))) continue;
            const specifier = statement.moduleSpecifier.text;
            const base = specifier.startsWith("@/")
                ? resolve("src", specifier.slice(2))
                : specifier.startsWith(".")
                  ? resolve(dirname(path), specifier)
                  : null;
            if (!base) continue;
            const dependency = [
                base,
                `${base}.tsx`,
                `${base}.ts`,
                join(base, "index.tsx"),
            ].find((candidate) => existsSync(candidate));
            if (dependency) pending.push(dependency);
        }
    }
    return [...seen];
}

const english = en as Record<string, string>;
const czech = cs as Record<string, string>;
const bySource = new Map(
    Object.entries(english).map(([id, message]) => [message, id]),
);

function requireCzech(
    message: string,
    location: string,
    id = bySource.get(message),
) {
    expect(id, `${location}: ${message}`).toBeTruthy();
    expect(czech[id ?? ""]?.trim(), `${location}: ${message}`).toBeTruthy();
    expect(czech[id ?? ""], location).not.toMatch(/\bLearn\b/);
}

function bareText(
    expression: ts.Expression,
    file: ts.SourceFile,
    seen = new Set<string>(),
): string[] {
    if (ts.isStringLiteralLike(expression))
        return /[a-zA-Z]{2}/.test(expression.text) ? [expression.text] : [];
    if (ts.isTemplateExpression(expression)) {
        return [
            expression.head.text,
            ...expression.templateSpans.map((span) => span.literal.text),
        ].filter((text) => /[a-zA-Z]{2}/.test(text));
    }
    if (ts.isConditionalExpression(expression))
        return [
            ...bareText(expression.whenTrue, file, seen),
            ...bareText(expression.whenFalse, file, seen),
        ];
    if (
        ts.isBinaryExpression(expression) &&
        [
            ts.SyntaxKind.QuestionQuestionToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.AmpersandAmpersandToken,
        ].includes(expression.operatorToken.kind)
    ) {
        return [
            ...(expression.operatorToken.kind ===
            ts.SyntaxKind.AmpersandAmpersandToken
                ? []
                : bareText(expression.left, file, seen)),
            ...bareText(expression.right, file, seen),
        ];
    }
    if (
        ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression)
    )
        return bareText(expression.expression, file, seen);
    if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
        seen.add(expression.text);
        const value = initializer(file, expression.text);
        if (value) return bareText(value, file, seen);
    }
    return [];
}

function serverProseViolations(file: ts.SourceFile): string[] {
    const failures: string[] = [];
    walk(file, (node) => {
        if (
            !ts.isPropertyAssignment(node) ||
            !/^(reason|note|explanation)$/i.test(node.name.getText(file))
        )
            return;
        const object = node.parent;
        if (
            ts.isObjectLiteralExpression(object) &&
            object.properties.some(
                (property) =>
                    ts.isPropertyAssignment(property) &&
                    property.name.getText(file) === "code",
            )
        )
            return;
        for (const text of bareText(node.initializer, file)) {
            if (!/^[a-z0-9_-]+$/.test(text))
                failures.push(`${file.fileName}: ${text}`);
        }
    });
    return failures;
}

function translatorNames(file: ts.SourceFile): Set<string> {
    const hooks = new Set(["useExtracted", "getExtracted"]);
    for (const statement of file.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
            for (const binding of bindings.elements) {
                if (hooks.has(binding.propertyName?.text ?? binding.name.text))
                    hooks.add(binding.name.text);
            }
        }
    }
    const names = new Set<string>();
    walk(file, (node) => {
        if (
            !ts.isVariableDeclaration(node) ||
            !ts.isIdentifier(node.name) ||
            !node.initializer
        )
            return;
        const value = ts.isAwaitExpression(node.initializer)
            ? node.initializer.expression
            : node.initializer;
        if (
            ts.isCallExpression(value) &&
            hooks.has(value.expression.getText(file))
        )
            names.add(node.name.text);
    });
    return names;
}

describe("Learn language coverage guards", () => {
    it("discovers every Learn system prompt, including new builders and repairs", () => {
        const failures = filesIn("src/lib/learn").flatMap((path) =>
            promptViolations(source(path)),
        );
        expect(failures).toEqual([]);
        const missing = ts.createSourceFile(
            "new-builder.ts",
            'chat.complete({system: "Explain each proposal", user: text});',
            ts.ScriptTarget.Latest,
            true,
        );
        expect(promptViolations(missing)).toHaveLength(1);
        const noSystem = ts.createSourceFile(
            "new-builder.ts",
            'chat.complete([{role: "user", content: "Explain each proposal"}], 1000);',
            ts.ScriptTarget.Latest,
            true,
        );
        expect(promptViolations(noSystem)).toHaveLength(1);
    });

    it("discovers Learn components and rendered dependencies, rejecting untranslated UI copy", () => {
        const failures: string[] = [];
        for (const path of componentFiles()) {
            const file = source(path);
            const translators = translatorNames(file);
            walk(file, (node) => {
                const line =
                    file.getLineAndCharacterOfPosition(node.getStart()).line +
                    1;
                if (ts.isJsxText(node) && /[a-zA-Z]{2}/.test(node.text))
                    failures.push(`${path}:${line}: ${node.text.trim()}`);
                if (
                    ts.isJsxExpression(node) &&
                    node.expression &&
                    !(
                        ts.isJsxAttribute(node.parent) &&
                        !/^(title|label|aria-label|placeholder|alt|description|closeLabel|actionLabel|expandLabel)$/.test(
                            node.parent.name.getText(file),
                        )
                    )
                ) {
                    failures.push(
                        ...bareText(node.expression, file).map(
                            (text) => `${path}:${line}: ${text}`,
                        ),
                    );
                }
                if (
                    ts.isCallExpression(node) &&
                    /^toast\.(error|info|success|warning)$/.test(
                        node.expression.getText(file),
                    ) &&
                    node.arguments[0]
                ) {
                    failures.push(
                        ...bareText(node.arguments[0], file).map(
                            (text) => `${path}:${line}: ${text}`,
                        ),
                    );
                }
                if (
                    ts.isJsxAttribute(node) &&
                    /^(title|label|aria-label|placeholder|alt)$/.test(
                        node.name.getText(file),
                    ) &&
                    node.initializer &&
                    ts.isStringLiteral(node.initializer) &&
                    /[a-zA-Z]{2}/.test(node.initializer.text)
                )
                    failures.push(`${path}:${line}: ${node.initializer.text}`);
                if (
                    ts.isPropertyAssignment(node) &&
                    /^(title|label|description|message|ariaLabel|placeholder)$/.test(
                        node.name.getText(file),
                    ) &&
                    !(
                        ts.isCallExpression(node.parent.parent) &&
                        translators.has(
                            node.parent.parent.expression.getText(file),
                        )
                    )
                ) {
                    failures.push(
                        ...bareText(node.initializer, file).map(
                            (text) => `${path}:${line}: ${text}`,
                        ),
                    );
                }
                if (
                    !ts.isCallExpression(node) ||
                    !translators.has(node.expression.getText(file))
                )
                    return;
                const argument = node.arguments[0];
                if (argument && ts.isStringLiteralLike(argument))
                    requireCzech(argument.text, `${path}:${line}`);
                else if (argument && ts.isObjectLiteralExpression(argument)) {
                    const properties = Object.fromEntries(
                        argument.properties
                            .filter(ts.isPropertyAssignment)
                            .map((property) => [
                                property.name.getText(file),
                                property.initializer,
                            ]),
                    );
                    if (
                        properties.message &&
                        ts.isStringLiteralLike(properties.message) &&
                        properties.id &&
                        ts.isStringLiteralLike(properties.id)
                    )
                        requireCzech(
                            properties.message.text,
                            `${path}:${line}`,
                            properties.id.text,
                        );
                    else
                        failures.push(
                            `${path}:${line}: unsupported message descriptor`,
                        );
                } else
                    failures.push(
                        `${path}:${line}: nonliteral translation key`,
                    );
            });
        }
        expect(failures).toEqual([]);
        expect(
            bareText(
                ts.factory.createStringLiteral("Untranslated new label"),
                source("src/components/learn/learn-review.tsx"),
            ),
        ).toEqual(["Untranslated new label"]);
    });

    it("discovers server-composed review messages and requires Czech catalog entries", () => {
        let count = 0;
        for (const path of filesIn("src/lib/learn")) {
            const file = source(path);
            expect(serverProseViolations(file), path).toEqual([]);
            walk(file, (node) => {
                if (
                    !ts.isCallExpression(node) ||
                    node.expression.getText(file) !== "translatedSourceMessage"
                )
                    return;
                const message = node.arguments[1];
                expect(message && ts.isStringLiteralLike(message), path).toBe(
                    true,
                );
                if (message && ts.isStringLiteralLike(message)) {
                    requireCzech(message.text, path);
                    count++;
                }
            });
        }
        expect(count).toBeGreaterThan(0);
        const unlocalized = ts.createSourceFile(
            "new-producer.ts",
            'const payload = {reason: "A new English reason", note: "An English note"};',
            ts.ScriptTarget.Latest,
            true,
        );
        expect(serverProseViolations(unlocalized)).toHaveLength(2);
        expect(
            /^\s*\{operation\}\s*$/m.test(
                readFileSync(
                    "src/components/recordings/ai-cost-summary.tsx",
                    "utf8",
                ),
            ),
        ).toBe(false);
        for (const path of filesIn("src/components/learn")) {
            const text = readFileSync(path, "utf8");
            expect(text, path).not.toContain('from "@/lib/i18n/messages"');
            expect(text, path).not.toMatch(
                /import\s*\{[^}]*getApiErrorMessage[^}]*\}\s*from\s*["']@\/lib\/api-errors/,
            );
            expect(text, path).not.toMatch(/\bjob\.error\b/);
        }
    });
});
