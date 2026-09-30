import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getApiKeyInfo, type ApiKeyInfo, isInvalidApiKeyError } from "./client.ts";
import { SecretInputDialog } from "./secret-input.ts";

export interface CursorCredential {
	apiKey: string;
	info: ApiKeyInfo;
}

export interface CursorApiKeyStore {
	load(): Promise<string | undefined>;
	save(apiKey: string): Promise<void>;
	clear(): Promise<void>;
}

export class InvalidCursorConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidCursorConfigError";
	}
}

export function cursorConfigPath(): string {
	return join(getAgentDir(), "extensions", "cursor-cloud.json");
}

function errorCode(error: unknown): string | undefined {
	return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

export class FileCursorApiKeyStore implements CursorApiKeyStore {
	constructor(readonly path = cursorConfigPath()) {}

	async load(): Promise<string | undefined> {
		let text: string;
		try {
			await chmod(this.path, 0o600);
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if (errorCode(error) === "ENOENT") return undefined;
			throw new Error(`Could not read Cursor configuration at ${this.path}.`);
		}

		try {
			const value = JSON.parse(text) as unknown;
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
			const apiKey = (value as Record<string, unknown>).apiKey;
			if (typeof apiKey !== "string" || apiKey.trim().length === 0) throw new Error("missing apiKey");
			return apiKey.trim();
		} catch {
			throw new InvalidCursorConfigError(`Cursor configuration at ${this.path} is invalid.`);
		}
	}

	async save(apiKey: string): Promise<void> {
		const value = apiKey.trim();
		if (!value) throw new Error("Cursor API key cannot be empty.");
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify({ apiKey: value }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
			await chmod(temporary, 0o600);
			await rename(temporary, this.path);
			await chmod(this.path, 0o600);
		} finally {
			await unlink(temporary).catch((error) => {
				if (errorCode(error) !== "ENOENT") throw error;
			});
		}
	}

	async clear(): Promise<void> {
		await unlink(this.path).catch((error) => {
			if (errorCode(error) !== "ENOENT") throw error;
		});
	}
}

type ValidateApiKey = (apiKey: string, signal?: AbortSignal) => Promise<ApiKeyInfo>;
type PromptApiKey = (ctx: ExtensionContext, signal?: AbortSignal) => Promise<string | undefined>;

export interface CredentialOptions {
	store?: CursorApiKeyStore;
	validate?: ValidateApiKey;
	prompt?: PromptApiKey;
}

export async function promptCursorApiKey(
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui" || signal?.aborted) return undefined;
	return ctx.ui.custom<string | undefined>(
		(_tui, theme, _keybindings, done) => new SecretInputDialog(theme, "Cursor Cloud API key", done, signal),
		{ overlay: true },
	);
}

function credentialDescription(info: ApiKeyInfo, apiKey: string): string {
	const owner = info.userEmail ?? [info.userFirstName, info.userLastName].filter(Boolean).join(" ");
	const description = owner ? `${info.apiKeyName} (${owner})` : info.apiKeyName;
	return description.replace(/[\u0000-\u001f\u007f]/g, " ").split(apiKey).join("[redacted]");
}

async function promptForValidCredential(
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	options: CredentialOptions,
): Promise<CursorCredential> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		throw new Error("A valid Cursor API key is required. Run /cloud-agent-setup in an interactive Pi session.");
	}
	const store = options.store ?? new FileCursorApiKeyStore();
	const validate = options.validate ?? getApiKeyInfo;
	const prompt = options.prompt ?? promptCursorApiKey;

	while (!signal?.aborted) {
		const apiKey = await prompt(ctx, signal);
		if (!apiKey) throw new Error("Cursor API key setup was cancelled.");
		try {
			const info = await validate(apiKey, signal);
			await store.save(apiKey);
			ctx.ui.notify(`Cursor API key saved: ${credentialDescription(info, apiKey)}`, "info");
			return { apiKey, info };
		} catch (error) {
			if (!isInvalidApiKeyError(error)) throw error;
			ctx.ui.notify("Cursor rejected that API key. Enter a valid key or press Esc to cancel.", "warning");
		}
	}
	throw new Error("Cursor API key setup was cancelled.");
}

export async function ensureCursorCredential(
	ctx: ExtensionContext,
	signal?: AbortSignal,
	options: CredentialOptions = {},
): Promise<CursorCredential> {
	const store = options.store ?? new FileCursorApiKeyStore();
	const validate = options.validate ?? getApiKeyInfo;
	let apiKey: string | undefined;
	try {
		apiKey = await store.load();
	} catch (error) {
		if (!(error instanceof InvalidCursorConfigError)) throw error;
		ctx.ui.notify("Cursor API key configuration is malformed and must be replaced.", "warning");
	}

	if (apiKey) {
		try {
			return { apiKey, info: await validate(apiKey, signal) };
		} catch (error) {
			if (!isInvalidApiKeyError(error)) throw error;
			ctx.ui.notify("The stored Cursor API key is invalid and must be replaced.", "warning");
		}
	}
	return promptForValidCredential(ctx, signal, { ...options, store, validate });
}

export async function replaceCursorCredential(
	ctx: ExtensionContext,
	signal?: AbortSignal,
	options: CredentialOptions = {},
): Promise<CursorCredential> {
	return promptForValidCredential(ctx, signal, options);
}
