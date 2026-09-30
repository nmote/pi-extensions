import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";

export interface NamedAgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	model?: string;
	tools?: string[];
	filePath: string;
}

export interface AgentDiscovery {
	names: string[];
	definitions: NamedAgentDefinition[];
	errors: string[];
}

// WebSearch is absent: Pi has no search tool, and a definition that needs one should fail to load.
const TOOL_ALIASES: Record<string, string[]> = {
	Bash: ["bash"],
	Edit: ["edit"],
	Glob: ["find", "ls"],
	Grep: ["grep"],
	Read: ["read"],
	WebFetch: ["web_fetch"],
	Write: ["write"],
	bash: ["bash"],
	edit: ["edit"],
	find: ["find"],
	grep: ["grep"],
	ls: ["ls"],
	read: ["read"],
	web_fetch: ["web_fetch"],
	write: ["write"],
};

function stripYamlComment(value: string): string {
	let quote: "single" | "double" | undefined;
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (quote === "double" && character === "\\") {
			index++;
			continue;
		}
		if (quote === "single" && character === "'" && value[index + 1] === "'") {
			index++;
			continue;
		}
		if (character === '"') quote = quote === "double" ? undefined : quote ?? "double";
		else if (character === "'") quote = quote === "single" ? undefined : quote ?? "single";
		else if (character === "#" && quote === undefined && (index === 0 || /\s/.test(value[index - 1]))) {
			return value.slice(0, index);
		}
	}
	return value;
}

function scalarValue(value: string): string {
	const trimmed = stripYamlComment(value).trim();
	if (trimmed.startsWith('"') !== trimmed.endsWith('"') || trimmed.startsWith("'") !== trimmed.endsWith("'")) {
		throw new Error("unterminated quoted scalar");
	}
	if (trimmed.startsWith('"')) return JSON.parse(trimmed) as string;
	if (trimmed.startsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
	return trimmed;
}

function frontmatterValue(frontmatter: string, field: string): string | undefined {
	const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
	if (!match) return undefined;
	const value = scalarValue(match[1]);
	return value.trim() ? value.trim() : undefined;
}

function frontmatterTools(frontmatter: string): string[] | undefined {
	const lines = frontmatter.split("\n");
	const fieldIndex = lines.findIndex((line) => /^tools:\s*/.test(line));
	if (fieldIndex === -1) return undefined;

	const inline = stripYamlComment(lines[fieldIndex].replace(/^tools:\s*/, "")).trim();
	if (inline) {
		const value = inline.startsWith("[") && inline.endsWith("]")
			? inline.slice(1, -1)
			: scalarValue(inline);
		return value.split(",").map(scalarValue).map((name) => name.trim()).filter(Boolean);
	}

	const names: string[] = [];
	for (const line of lines.slice(fieldIndex + 1)) {
		if (!stripYamlComment(line).trim()) continue;
		const match = line.match(/^\s+-\s+(.+)$/);
		if (!match) break;
		const name = scalarValue(match[1]).trim();
		if (name) names.push(name);
	}
	return names;
}

function parseTools(names: string[] | undefined): string[] | undefined {
	if (names === undefined) return undefined;
	const tools: string[] = [];
	for (const name of names) {
		const alias = TOOL_ALIASES[name];
		if (!alias) throw new Error(`unsupported tool ${JSON.stringify(name)}`);
		for (const tool of alias) {
			if (!tools.includes(tool)) tools.push(tool);
		}
	}
	return tools;
}

export function discoverAgents(directory: string, { allowMissing = false } = {}): AgentDiscovery {
	const definitions: NamedAgentDefinition[] = [];
	const errors: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch (error) {
		if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return { names: [], definitions, errors };
		}
		const detail = error instanceof Error ? error.message : String(error);
		return { names: [], definitions, errors: [`Cannot read agent directory ${directory}: ${detail}`] };
	}

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filePath = join(directory, entry.name);
		const expectedName = basename(entry.name, ".md");
		let source: string;
		try {
			source = readFileSync(filePath, "utf8");
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			errors.push(`${entry.name}: ${detail}`);
			continue;
		}

		const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
		const frontmatterMatch = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
		if (!frontmatterMatch) {
			errors.push(`${entry.name}: missing YAML frontmatter`);
			continue;
		}

		const frontmatter = frontmatterMatch[1];
		const body = normalized.slice(frontmatterMatch[0].length).trim();
		let name: string;
		let description: string;
		let model: string | undefined;
		let tools: string[] | undefined;
		try {
			name = frontmatterValue(frontmatter, "name") ?? "";
			description = frontmatterValue(frontmatter, "description") ?? "";
			model = frontmatterValue(frontmatter, "model");
			tools = parseTools(frontmatterTools(frontmatter));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			errors.push(`${entry.name}: invalid frontmatter: ${detail}`);
			continue;
		}
		if (!name) errors.push(`${entry.name}: missing frontmatter name`);
		else if (name !== expectedName) errors.push(`${entry.name}: name must be "${expectedName}"`);
		if (!description) errors.push(`${entry.name}: missing frontmatter description`);
		if (name !== expectedName || !description) continue;

		definitions.push({ name, description, systemPrompt: body, model, tools, filePath });
	}

	return { names: definitions.map((definition) => definition.name), definitions, errors };
}
