import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	ensureCursorCredential,
	FileCursorApiKeyStore,
	replaceCursorCredential,
} from "./auth.ts";
import { CursorApiError, type ApiKeyInfo } from "./client.ts";
import { SecretInputDialog } from "./secret-input.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

const info: ApiKeyInfo = {
	apiKeyName: "Pi key",
	createdAt: "2026-01-01T00:00:00Z",
	userEmail: "developer@example.com",
};

function context(notices: string[]): ExtensionContext {
	return {
		hasUI: true,
		mode: "tui",
		ui: {
			notify(message: string) { notices.push(message); },
		},
	} as unknown as ExtensionContext;
}

async function main(): Promise<void> {
	const temp = await mkdtemp(join(tmpdir(), "pi-cursor-auth-test-"));
	try {
		const path = join(temp, "extensions", "cursor-cloud.json");
		const store = new FileCursorApiKeyStore(path);
		await store.save("first-secret");
		const fileMode = (await stat(path)).mode & 0o777;
		check("API keys round-trip through private configuration", await store.load() === "first-secret");
		check("credential configuration is mode 0600", fileMode === 0o600);
		check(
			"atomic writes leave no temporary credential files",
			(await readdir(join(temp, "extensions"))).join(",") === "cursor-cloud.json",
		);

		const notices: string[] = [];
		const missingStore = new FileCursorApiKeyStore(join(temp, "missing", "cursor-cloud.json"));
		const missing = await ensureCursorCredential(context(notices), undefined, {
			store: missingStore,
			prompt: async () => "new-secret",
			validate: async (apiKey) => {
				if (apiKey !== "new-secret") throw new Error("wrong key");
				return info;
			},
		});
		check(
			"a missing key is prompted for, validated, and persisted",
			missing.apiKey === "new-secret" && await missingStore.load() === "new-secret",
		);

		const invalidStore = new FileCursorApiKeyStore(join(temp, "invalid", "cursor-cloud.json"));
		await invalidStore.save("expired-secret");
		let prompted = 0;
		const replacement = await ensureCursorCredential(context(notices), undefined, {
			store: invalidStore,
			prompt: async () => {
				prompted++;
				return "replacement-secret";
			},
			validate: async (apiKey) => {
				if (apiKey === "expired-secret") throw new CursorApiError("invalid", 401, "unauthorized");
				return info;
			},
		});
		check(
			"an invalid stored key triggers replacement and resumes",
			prompted === 1 && replacement.apiKey === "replacement-secret" && await invalidStore.load() === "replacement-secret",
		);

		await store.save("preserved-secret");
		const candidates = ["bad-secret", undefined];
		const cancelled = await rejection(replaceCursorCredential(context(notices), undefined, {
			store,
			prompt: async () => candidates.shift(),
			validate: async () => { throw new CursorApiError("invalid", 401, "unauthorized"); },
		}));
		check(
			"invalid replacement input and cancellation preserve the existing key",
			cancelled.includes("cancelled") && await store.load() === "preserved-secret",
		);

		let temporaryPrompted = false;
		const temporary = await rejection(ensureCursorCredential(context(notices), undefined, {
			store,
			prompt: async () => {
				temporaryPrompted = true;
				return "unused";
			},
			validate: async () => { throw new Error("temporary outage"); },
		}));
		check(
			"temporary validation failures do not solicit or overwrite credentials",
			temporary.includes("temporary outage") && !temporaryPrompted && await store.load() === "preserved-secret",
		);
		check(
			"credential notifications contain no entered keys",
			!["new-secret", "expired-secret", "replacement-secret", "bad-secret", "preserved-secret"].some((secret) => notices.join("\n").includes(secret)),
		);

		const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text } as unknown as Theme;
		let submitted: string | undefined;
		const dialog = new SecretInputDialog(theme, "Cursor key", (value) => { submitted = value; });
		dialog.focused = true;
		dialog.handleInput("visible-secret");
		const rendered = dialog.render(80).join("\n");
		dialog.handleInput("\n");
		check("secret input masks the key while preserving submission", !rendered.includes("visible-secret") && rendered.includes("••••") && submitted === "visible-secret");

		await writeFile(path, "{}\n", { mode: 0o600 });
		const malformed = await ensureCursorCredential(context(notices), undefined, {
			store,
			prompt: async () => "recovered-secret",
			validate: async () => info,
		});
		check("malformed configuration can be replaced interactively", malformed.apiKey === "recovered-secret" && await store.load() === "recovered-secret");
	} finally {
		await rm(temp, { recursive: true, force: true });
	}

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("\nall checks passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
