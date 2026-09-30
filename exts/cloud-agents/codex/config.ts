import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export class CodexEnvironmentStore {
	constructor(readonly path = join(getAgentDir(), "extensions", "codex-cloud.json")) {}

	async load(repository: string): Promise<string | undefined> {
		let text: string;
		try {
			await chmod(this.path, 0o600);
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new Error("Could not read Codex environment mappings.");
		}
		let value: unknown;
		try { value = JSON.parse(text); } catch { throw new Error("Invalid Codex environment mappings."); }
		if (!value || typeof value !== "object" || Array.isArray(value) ||
			Object.values(value).some((v) => typeof v !== "string" || !v.trim())) {
			throw new Error("Invalid Codex environment mappings.");
		}
		return Object.hasOwn(value, repository) ? (value as Record<string, string>)[repository] : undefined;
	}

	async set(repository: string, environment?: string): Promise<void> {
		if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository URL.");
		if (environment !== undefined && (!environment.trim() || environment.length > 200 || /[\x00-\x1f\x7f]/.test(environment))) throw new Error("Invalid environment.");
		let values: Record<string, string> = {};
		try {
			await chmod(this.path, 0o600);
			const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((v) => typeof v !== "string" || !v.trim())) throw new Error("Invalid Codex environment mappings.");
			values = parsed as Record<string, string>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (environment === undefined) delete values[repository];
		else Object.defineProperty(values, repository, { value: environment, enumerable: true, configurable: true, writable: true });
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temp, `${JSON.stringify(values, null, 2)}\n`, { flag: "wx", mode: 0o600 });
			await chmod(temp, 0o600);
			await rename(temp, this.path);
			await chmod(this.path, 0o600);
		} finally {
			await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
		}
	}
}
