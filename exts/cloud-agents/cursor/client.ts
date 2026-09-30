const DEFAULT_BASE_URL = "https://api.cursor.com";
const REQUEST_TIMEOUT_MS = 30_000;

export interface ApiKeyInfo {
	apiKeyName: string;
	createdAt: string;
	userId?: number;
	userEmail?: string;
	userFirstName?: string;
	userLastName?: string;
}

export interface ModelSelection {
	id: string;
	params?: { id: string; value: string }[];
}

export interface CursorModelParameter {
	id: string;
	values: string[];
}

export interface CursorModelVariant {
	params: NonNullable<ModelSelection["params"]>;
	isDefault?: boolean;
}

export interface CursorModel {
	id: string;
	displayName: string;
	aliases: string[];
	parameters: CursorModelParameter[];
	variants: CursorModelVariant[];
}

export interface CreateAgentInput {
	agentId: string;
	plan: string;
	name?: string;
	model?: ModelSelection;
	repositoryUrl: string;
	startingRef?: string;
}

export interface CreatedAgent {
	agentId: string;
	runId: string;
	url: string;
	agentStatus: string;
	runStatus: string;
}

export interface AgentInfo {
	id: string;
	name?: string;
	status: string;
	url: string;
	latestRunId?: string;
}

export interface RunBranch {
	repoUrl?: string;
	branch?: string;
	prUrl?: string;
}

export interface RunInfo {
	id: string;
	status: string;
	updatedAt?: string;
	durationMs?: number;
	result?: string;
	branches: RunBranch[];
}

interface ClientOptions {
	fetch?: typeof fetch;
	baseUrl?: string;
}

export class CursorApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
		readonly helpUrl?: string,
	) {
		super(message);
		this.name = "CursorApiError";
	}
}

export function isInvalidApiKeyError(error: unknown): boolean {
	return error instanceof CursorApiError &&
		(error.status === 401 || error.code === "unauthorized" || error.code === "api_key_not_found");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Cursor API returned an invalid ${field}.`);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pathSegment(value: string, field: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid Cursor ${field}: ${JSON.stringify(value)}.`);
	return value;
}

function redact(text: string, apiKey: string): string {
	const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1000);
	return apiKey ? clean.split(apiKey).join("[redacted]") : clean;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function cursorRequest(
	path: string,
	apiKey: string,
	init: RequestInit,
	signal: AbortSignal | undefined,
	options: ClientOptions,
): Promise<unknown> {
	const fetchImpl = options.fetch ?? fetch;
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	const effectiveSignal = requestSignal(signal);
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl}${path}`, {
			...init,
			headers: {
				Accept: "application/json",
				...init.headers,
				Authorization: `Bearer ${apiKey}`,
			},
			signal: effectiveSignal,
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Cursor API request cancelled.");
		if (effectiveSignal.aborted) throw new Error(`Cursor API request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cursor API request failed: ${redact(message, apiKey)}`);
	}

	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		if (signal?.aborted) throw new Error("Cursor API response was cancelled.");
		const message = error instanceof Error ? error.message : String(error);
		const reason = effectiveSignal.aborted
			? `timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`
			: `failed: ${redact(message, apiKey)}`;
		throw new Error(`Reading the Cursor API response ${reason}.`);
	}

	let body: unknown;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		body = undefined;
	}

	if (!response.ok) {
		const root = record(body);
		const nested = record(root?.error);
		const code = optionalString(nested?.code) ?? optionalString(root?.code);
		const apiMessage = optionalString(nested?.message) ?? optionalString(root?.message);
		const flatError = optionalString(root?.error);
		const helpUrl = optionalString(nested?.helpUrl) ?? optionalString(root?.helpUrl);
		const summary = apiMessage ?? flatError ?? response.statusText ?? `HTTP ${response.status}`;
		throw new CursorApiError(
			`Cursor API rejected the request${code ? ` (${code})` : ""}: ${redact(summary, apiKey)}`,
			response.status,
			code,
			helpUrl,
		);
	}
	return body;
}

export async function getApiKeyInfo(
	apiKey: string,
	signal?: AbortSignal,
	options: ClientOptions = {},
): Promise<ApiKeyInfo> {
	const body = record(await cursorRequest("/v1/me", apiKey, { method: "GET" }, signal, options));
	return {
		apiKeyName: requiredString(body?.apiKeyName, "API key name"),
		createdAt: requiredString(body?.createdAt, "API key creation time"),
		userId: optionalNumber(body?.userId),
		userEmail: optionalString(body?.userEmail),
		userFirstName: optionalString(body?.userFirstName),
		userLastName: optionalString(body?.userLastName),
	};
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function parseParameters(value: unknown): CursorModelParameter[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const parameter = record(item);
		const id = optionalString(parameter?.id);
		const values = Array.isArray(parameter?.values)
			? parameter.values.flatMap((entry) => optionalString(record(entry)?.value) ?? [])
			: [];
		return id ? [{ id, values }] : [];
	});
}

function parseVariants(value: unknown): CursorModelVariant[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const variant = record(item);
		if (!Array.isArray(variant?.params)) return [];
		const params = variant.params.flatMap((entry) => {
			const param = record(entry);
			const id = optionalString(param?.id);
			const value = optionalString(param?.value);
			return id && value ? [{ id, value }] : [];
		});
		return params.length === variant.params.length
			? [{ params, ...(variant.isDefault === true ? { isDefault: true } : {}) }]
			: [];
	});
}

export async function listModels(
	apiKey: string,
	signal?: AbortSignal,
	options: ClientOptions = {},
): Promise<CursorModel[]> {
	const body = record(await cursorRequest("/v1/models", apiKey, { method: "GET" }, signal, options));
	if (!Array.isArray(body?.items)) return [];
	return body.items.flatMap((item) => {
		const model = record(item);
		const id = optionalString(model?.id);
		const displayName = optionalString(model?.displayName);
		if (!model || !id || !displayName) return [];
		return [{
			id,
			displayName,
			aliases: stringArray(model.aliases),
			parameters: parseParameters(model.parameters),
			variants: parseVariants(model.variants),
		}];
	});
}

export async function createAgent(
	apiKey: string,
	input: CreateAgentInput,
	signal?: AbortSignal,
	options: ClientOptions = {},
): Promise<CreatedAgent> {
	try {
		const body = record(await cursorRequest(
			"/v1/agents",
			apiKey,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					agentId: input.agentId,
					prompt: {
						text: `Execute this approved plan autonomously. You receive only the cloned repository and this plan, not the dispatcher's local checkout or Pi conversation. If an assumed prerequisite is missing and this plan does not include creating it, stop and report the missing prerequisite rather than guessing.\n\nFollow all repository instructions. Implement every step, run relevant validation, and produce a reviewable pull request.\n\n${input.plan}`,
					},
					...(input.name ? { name: input.name } : {}),
					...(input.model ? { model: input.model } : {}),
					repos: [{ url: input.repositoryUrl, ...(input.startingRef !== undefined ? { startingRef: input.startingRef } : {}) }],
					mode: "agent",
					workOnCurrentBranch: false,
					autoCreatePR: true,
				}),
			},
			signal,
			options,
		));
		const agent = record(body?.agent);
		const run = record(body?.run);
		const agentId = requiredString(agent?.id, "agent ID");
		if (agentId !== input.agentId) throw new Error("Cursor API returned an unexpected agent ID.");
		return {
			agentId,
			runId: requiredString(run?.id, "run ID"),
			url: requiredString(agent?.url, "agent URL"),
			agentStatus: requiredString(agent?.status, "agent status"),
			runStatus: requiredString(run?.status, "run status"),
		};
	} catch (error) {
		const uncertain = !(error instanceof CursorApiError) || error.status >= 500 || error.code === "agent_id_conflict";
		if (!uncertain) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${message} The launch outcome is uncertain. Check agent ${input.agentId} with cloud_agent_status({ provider: 'cursor', agentId: '${input.agentId}' }) before retrying.`,
		);
	}
}

export async function getAgent(
	apiKey: string,
	agentId: string,
	signal?: AbortSignal,
	options: ClientOptions = {},
): Promise<AgentInfo> {
	const path = `/v1/agents/${pathSegment(agentId, "agent ID")}`;
	const body = record(await cursorRequest(path, apiKey, { method: "GET" }, signal, options));
	return {
		id: requiredString(body?.id, "agent ID"),
		name: optionalString(body?.name),
		status: requiredString(body?.status, "agent status"),
		url: requiredString(body?.url, "agent URL"),
		latestRunId: optionalString(body?.latestRunId),
	};
}

export async function getRun(
	apiKey: string,
	agentId: string,
	runId: string,
	signal?: AbortSignal,
	options: ClientOptions = {},
): Promise<RunInfo> {
	const path = `/v1/agents/${pathSegment(agentId, "agent ID")}/runs/${pathSegment(runId, "run ID")}`;
	const body = record(await cursorRequest(path, apiKey, { method: "GET" }, signal, options));
	const branches = record(body?.git)?.branches;
	return {
		id: requiredString(body?.id, "run ID"),
		status: requiredString(body?.status, "run status"),
		updatedAt: optionalString(body?.updatedAt),
		durationMs: optionalNumber(body?.durationMs),
		result: optionalString(body?.result),
		branches: (Array.isArray(branches) ? branches : []).flatMap((value) => {
			const branch = record(value);
			return branch
				? [{
					repoUrl: optionalString(branch.repoUrl),
					branch: optionalString(branch.branch),
					prUrl: optionalString(branch.prUrl),
				}]
				: [];
		}),
	};
}
