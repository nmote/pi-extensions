import { readFileSync } from "node:fs";
import { canonicalImportFile, expandImportPath, ImportResolutionError } from "../shared/import-path.ts";

export interface ResolveImportsOptions {
	homeDir: string;
	maxDepth?: number;
}

export interface ResolvedImports {
	content: string;
	files: string[];
}

interface Fence {
	character: "`" | "~";
	length: number;
}

interface Line {
	text: string;
	ending: string;
}

function splitLines(content: string): Line[] {
	const parts = content.split(/(\r\n|\n|\r)/);
	const lines: Line[] = [];

	for (let index = 0; index < parts.length; index += 2) {
		const text = parts[index] ?? "";
		const ending = parts[index + 1] ?? "";
		if (text || ending) lines.push({ text, ending });
	}

	return lines;
}

function openingFence(line: string): Fence | undefined {
	const match = line.trim().match(/^(`{3,}|~{3,})/);
	if (!match) return undefined;
	return {
		character: match[1][0] as Fence["character"],
		length: match[1].length,
	};
}

function closesFence(line: string, fence: Fence): boolean {
	const trimmed = line.trim();
	if (trimmed.length < fence.length) return false;
	if ([...trimmed].some((character) => character !== fence.character)) return false;
	return trimmed.length >= fence.length;
}

function importPath(line: string): string | undefined {
	const match = line.trim().match(/^@(.+)$/);
	const value = match?.[1].trim();
	return value || undefined;
}

function endsWithNewline(content: string): boolean {
	return content.endsWith("\n") || content.endsWith("\r");
}

export function resolveImports(rootPath: string, options: ResolveImportsOptions): ResolvedImports {
	const maxDepth = options.maxDepth ?? 10;
	if (!Number.isInteger(maxDepth) || maxDepth < 0) {
		throw new ImportResolutionError(`maxDepth must be a non-negative integer, got ${maxDepth}`);
	}

	const seen = new Set<string>();
	const files: string[] = [];

	function expand(candidate: string, depth: number, ancestors: string[]): string | undefined {
		if (depth > maxDepth) {
			throw new ImportResolutionError(`Import nesting exceeds the maximum depth of ${maxDepth}: ${candidate}`);
		}

		const file = canonicalImportFile(candidate);
		const cycleStart = ancestors.indexOf(file);
		if (cycleStart !== -1) {
			const cycle = [...ancestors.slice(cycleStart), file].join(" -> ");
			throw new ImportResolutionError(`Import cycle detected: ${cycle}`);
		}
		if (seen.has(file)) return undefined;

		let source;
		try {
			source = readFileSync(file, "utf8");
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new ImportResolutionError(`Cannot read imported file ${file}: ${detail}`);
		}

		seen.add(file);
		files.push(file);
		const nextAncestors = [...ancestors, file];
		let fence: Fence | undefined;
		let output = "";

		for (const line of splitLines(source)) {
			if (fence) {
				output += line.text + line.ending;
				if (closesFence(line.text, fence)) fence = undefined;
				continue;
			}

			const opened = openingFence(line.text);
			if (opened) {
				fence = opened;
				output += line.text + line.ending;
				continue;
			}

			const specifier = importPath(line.text);
			if (!specifier) {
				output += line.text + line.ending;
				continue;
			}

			const imported = expand(expandImportPath(specifier, file, options.homeDir), depth + 1, nextAncestors);
			if (imported === undefined) continue;
			output += imported;
			if (line.ending && imported && !endsWithNewline(imported)) output += line.ending;
		}

		return output;
	}

	return {
		content: expand(rootPath, 0, []) ?? "",
		files,
	};
}
