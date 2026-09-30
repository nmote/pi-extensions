/**
 * Fails when extension sources import modules Pi cannot supply at runtime.
 *
 * Pi aliases its own packages for extensions and resolves every other bare
 * specifier from the extension's directory. Dev dependencies and their
 * transitive packages are installed for tests, so importing them works in
 * development but not where only `dependencies` are installed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/** Specifiers aliased by Pi's extension loader. */
const PI_PROVIDED = new Set([
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/compat",
	"@earendil-works/pi-ai/oauth",
	"@earendil-works/pi-ai/providers/all",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
	"typebox/compile",
	"typebox/value",
]);

export interface ImportViolation {
	file: string;
	line: number;
	specifier: string;
}

export function isAllowedSpecifier(specifier: string, dependencies: readonly string[]): boolean {
	if (specifier.startsWith("./") || specifier.startsWith("../")) return true;
	if (isBuiltin(specifier)) return true;
	if (PI_PROVIDED.has(specifier)) return true;
	return dependencies.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/** Runtime module specifiers in `source`; type-only imports and exports are skipped. */
export function runtimeSpecifiers(fileName: string, source: string): Array<{ line: number; specifier: string }> {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
	const found: Array<{ line: number; specifier: string }> = [];
	const add = (node: ts.Node, specifier: string) => {
		const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		found.push({ line: line + 1, specifier });
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			if (!node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
				add(node, node.moduleSpecifier.text);
			}
		} else if (ts.isExportDeclaration(node)) {
			if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
				add(node, node.moduleSpecifier.text);
			}
		} else if (ts.isImportEqualsDeclaration(node)) {
			const reference = node.moduleReference;
			if (!node.isTypeOnly && ts.isExternalModuleReference(reference)) {
				add(node, ts.isStringLiteral(reference.expression) ? reference.expression.text : "<dynamic>");
			}
		} else if (ts.isCallExpression(node)) {
			const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
			const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
			if (isImport || isRequire) {
				const [argument] = node.arguments;
				add(node, argument && ts.isStringLiteralLike(argument) ? argument.text : "<dynamic>");
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

function extensionSources(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...extensionSources(path));
		else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
	}
	return files;
}

export function checkImports(root: string, scope: string): ImportViolation[] {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const dependencies = Object.keys(manifest.dependencies ?? {});
	const self = resolve(import.meta.dirname, "check-imports.ts");
	const violations: ImportViolation[] = [];
	for (const file of extensionSources(scope).sort()) {
		if (file === self) continue;
		for (const { line, specifier } of runtimeSpecifiers(file, readFileSync(file, "utf8"))) {
			if (!isAllowedSpecifier(specifier, dependencies)) {
				violations.push({ file: relative(root, file), line, specifier });
			}
		}
	}
	return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, "check-imports.ts")) {
	const [root, scope] = process.argv.slice(2);
	if (!root || !scope) {
		console.error("usage: check-imports.ts <package root> <scope directory>");
		process.exit(2);
	}
	const violations = checkImports(resolve(root), resolve(scope));
	for (const { file, line, specifier } of violations) {
		console.error(
			`${file}:${line}: "${specifier}" is not a relative path, Node built-in, Pi-provided module, or declared dependency`,
		);
	}
	if (violations.length > 0) process.exit(1);
}
