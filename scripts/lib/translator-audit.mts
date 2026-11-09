import ts from "typescript";

const factories = new Set([
    "useExtracted",
    "getExtracted",
    "useTranslations",
    "getTranslations",
]);
const dependencyHooks = new Set([
    "useEffect",
    "useLayoutEffect",
    "useInsertionEffect",
    "useMemo",
    "useCallback",
    "useImperativeHandle",
]);
const testFile = /(?:^|\/)(?:tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** A translator reference that the message extractor cannot follow. */
export interface TranslatorEscape {
    file: string;
    line: number;
    snippet: string;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
}

function unwrap(expression: ts.Expression): ts.Expression {
    while (
        ts.isAwaitExpression(expression) ||
        ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression) ||
        ts.isTypeAssertionExpression(expression) ||
        ts.isSatisfiesExpression(expression) ||
        ts.isNonNullExpression(expression)
    ) {
        expression = expression.expression;
    }
    return expression;
}

/** Finds escaped next-intl translator bindings, excluding tests and dependencies. */
export function auditTranslatorEscapes(
    program: ts.Program,
): TranslatorEscape[] {
    const checker = program.getTypeChecker();
    const escapes: TranslatorEscape[] = [];

    for (const source of program.getSourceFiles()) {
        if (
            source.isDeclarationFile ||
            program.isSourceFileFromExternalLibrary(source) ||
            testFile.test(source.fileName.replaceAll("\\", "/"))
        ) {
            continue;
        }

        const factoryImports = new Set<ts.Symbol>();
        const hookImports = new Set<ts.Symbol>();
        const intlNamespaces = new Set<ts.Symbol>();
        const reactNamespaces = new Set<ts.Symbol>();

        for (const statement of source.statements) {
            if (
                !ts.isImportDeclaration(statement) ||
                !ts.isStringLiteral(statement.moduleSpecifier)
            ) {
                continue;
            }
            const module = statement.moduleSpecifier.text;
            const intl =
                module === "next-intl" || module === "next-intl/server";
            if (!intl && module !== "react") continue;
            const bindings = statement.importClause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings)) {
                for (const specifier of bindings.elements) {
                    const name = (specifier.propertyName ?? specifier.name)
                        .text;
                    const symbol = checker.getSymbolAtLocation(specifier.name);
                    if (!symbol) continue;
                    if (intl && factories.has(name)) factoryImports.add(symbol);
                    if (!intl && dependencyHooks.has(name))
                        hookImports.add(symbol);
                }
            }
            const namespace =
                bindings && ts.isNamespaceImport(bindings)
                    ? bindings.name
                    : statement.importClause?.name;
            const symbol = namespace && checker.getSymbolAtLocation(namespace);
            if (symbol) (intl ? intlNamespaces : reactNamespaces).add(symbol);
        }
        if (factoryImports.size === 0 && intlNamespaces.size === 0) continue;

        function isImportedCall(
            expression: ts.Expression,
            imports: Set<ts.Symbol>,
            namespaces: Set<ts.Symbol>,
            names: Set<string>,
        ): boolean {
            expression = unwrap(expression);
            const symbol = checker.getSymbolAtLocation(expression);
            if (symbol && imports.has(symbol)) return true;
            if (!ts.isPropertyAccessExpression(expression)) return false;
            const namespace = checker.getSymbolAtLocation(
                expression.expression,
            );
            return (
                !!namespace &&
                namespaces.has(namespace) &&
                names.has(expression.name.text)
            );
        }

        function isFactory(expression: ts.Expression): boolean {
            expression = unwrap(expression);
            return (
                ts.isCallExpression(expression) &&
                isImportedCall(
                    expression.expression,
                    factoryImports,
                    intlNamespaces,
                    factories,
                )
            );
        }

        const translators = new Set<ts.Symbol>();
        function addBinding(name: ts.BindingName): void {
            if (!ts.isIdentifier(name)) return;
            const symbol = checker.getSymbolAtLocation(name);
            if (symbol) translators.add(symbol);
        }

        walk(source, (node) => {
            if (!ts.isVariableDeclaration(node) || !node.initializer) return;
            const initializer = unwrap(node.initializer);
            if (isFactory(initializer)) addBinding(node.name);
            if (
                ts.isArrayBindingPattern(node.name) &&
                ts.isCallExpression(initializer) &&
                ts.isPropertyAccessExpression(initializer.expression) &&
                initializer.expression.expression.getText(source) ===
                    "Promise" &&
                initializer.expression.name.text === "all"
            ) {
                const argument = initializer.arguments[0];
                const array = argument && unwrap(argument);
                if (!array || !ts.isArrayLiteralExpression(array)) return;
                node.name.elements.forEach((element, index) => {
                    const value = array.elements[index];
                    if (
                        ts.isBindingElement(element) &&
                        value &&
                        isFactory(value)
                    ) {
                        addBinding(element.name);
                    }
                });
            }
        });

        walk(source, (node) => {
            if (!ts.isIdentifier(node)) return;
            const parent = node.parent;
            const symbol = ts.isShorthandPropertyAssignment(parent)
                ? checker.getShorthandAssignmentValueSymbol(parent)
                : checker.getSymbolAtLocation(node);
            if (!symbol || !translators.has(symbol)) return;
            if (
                (ts.isVariableDeclaration(parent) ||
                    ts.isBindingElement(parent)) &&
                parent.name === node
            )
                return;
            if (ts.isCallExpression(parent) && parent.expression === node)
                return;
            if (
                ts.isPropertyAccessExpression(parent) &&
                parent.expression === node &&
                ts.isCallExpression(parent.parent) &&
                parent.parent.expression === parent
            )
                return;
            if (
                ts.isArrayLiteralExpression(parent) &&
                ts.isCallExpression(parent.parent) &&
                parent.parent.arguments.at(-1) === parent &&
                isImportedCall(
                    parent.parent.expression,
                    hookImports,
                    reactNamespaces,
                    dependencyHooks,
                )
            )
                return;

            escapes.push({
                file: source.fileName,
                line:
                    source.getLineAndCharacterOfPosition(node.getStart(source))
                        .line + 1,
                snippet: parent.getText(source).replace(/\s+/g, " "),
            });
        });
    }
    return escapes;
}
