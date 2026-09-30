import {
	createAgent,
	CursorApiError,
	getApiKeyInfo,
	getRun,
	isInvalidApiKeyError,
	listModels,
} from "./client.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function main(): Promise<void> {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const responses = [
		jsonResponse(200, {
			apiKeyName: "Pi key",
			createdAt: "2026-01-01T00:00:00Z",
			userEmail: "developer@example.com",
		}),
		jsonResponse(201, {
			agent: { id: "bc-00000000-0000-0000-0000-000000000001", url: "https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001", status: "ACTIVE" },
			run: { id: "run-agent", status: "CREATING" },
		}),
		jsonResponse(200, {
			id: "run-agent",
			status: "FINISHED",
			durationMs: 12357,
			result: "Done.",
			git: { branches: [{ repoUrl: "github.com/example/project", branch: "cursor/change", prUrl: "https://github.com/example/project/pull/7" }] },
		}),
	];
	const fetchMock = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(url), init: init ?? {} });
		const response = responses.shift();
		if (!response) throw new Error("unexpected request");
		return response;
	};
	const options = { fetch: fetchMock as typeof fetch, baseUrl: "https://cursor.test/" };

	const info = await getApiKeyInfo("secret-key", undefined, options);
	check("API key validation returns non-secret identity data", info.apiKeyName === "Pi key" && info.userEmail === "developer@example.com");
	check(
		"API key validation uses bearer auth against /v1/me",
		calls[0]?.url === "https://cursor.test/v1/me" && new Headers(calls[0]?.init.headers).get("authorization") === "Bearer secret-key",
	);

	const created = await createAgent("secret-key", {
		agentId: "bc-00000000-0000-0000-0000-000000000001",
		plan: "Implement the approved change.",
		name: "Approved change",
		repositoryUrl: "https://github.com/example/project",
	}, undefined, options);
	const request = JSON.parse(String(calls[1]?.init.body)) as Record<string, any>;
	check(
		"agent creation returns agent and run metadata",
		created.agentId === "bc-00000000-0000-0000-0000-000000000001" && created.runId === "run-agent" && created.runStatus === "CREATING",
	);
	check(
		"launch request hardcodes safe autonomous PR behavior",
		request.mode === "agent" && request.workOnCurrentBranch === false && request.autoCreatePR === true &&
			request.agentId === "bc-00000000-0000-0000-0000-000000000001" && request.model === undefined,
	);
	check(
		"launch request omits startingRef when unspecified",
		request.repos?.[0]?.url === "https://github.com/example/project" &&
			!Object.hasOwn(request.repos[0], "startingRef"),
	);
	check(
		"launch prompt contains the complete plan and execution instructions",
		request.prompt?.text.includes("Execute this approved plan autonomously.") &&
			request.prompt?.text.includes("only the cloned repository and this plan") &&
			request.prompt?.text.includes("If an assumed prerequisite is missing") &&
			request.prompt?.text.includes("stop and report") &&
			request.prompt?.text.endsWith("Implement the approved change."),
	);

	let selectedModel: unknown;
	let internalRef: unknown;
	await createAgent("secret-key", {
		agentId: "bc-00000000-0000-0000-0000-000000000002",
		plan: "Implement the approved change.",
		repositoryUrl: "https://github.com/example/project",
		startingRef: "feature",
		model: { id: "claude-4", params: [{ id: "effort", value: "high" }] },
	}, undefined, {
		fetch: (async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			selectedModel = body.model;
			internalRef = body.repos?.[0]?.startingRef;
			return jsonResponse(201, {
				agent: { id: "bc-00000000-0000-0000-0000-000000000002", url: "https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000002", status: "ACTIVE" },
				run: { id: "run-model", status: "CREATING" },
			});
		}) as typeof fetch,
	});
	check("launch request sends a supplied model verbatim", JSON.stringify(selectedModel) === JSON.stringify({ id: "claude-4", params: [{ id: "effort", value: "high" }] }));
	check("an explicit internal startingRef is preserved", internalRef === "feature");

	const catalog = await listModels("secret-key", undefined, {
		fetch: (async () => jsonResponse(200, { items: [
			{ id: "claude-4", displayName: "Claude 4", aliases: ["claude"], parameters: [{ id: "effort", values: [{ value: "low" }, { value: "high" }] }], variants: [{ params: [{ id: "effort", value: "low" }], isDefault: true }] },
			{ id: 7, displayName: "Malformed" },
			{ id: "missing-name" },
		] })) as typeof fetch,
	});
	check(
		"model catalog parses documented fields and drops malformed items",
		catalog.length === 1 && catalog[0]?.aliases[0] === "claude" && catalog[0]?.parameters[0]?.values.join(",") === "low,high",
	);

	const run = await getRun("secret-key", "bc-00000000-0000-0000-0000-000000000001", "run-agent", undefined, options);
	check(
		"run status reads pushed branches and pull requests",
		calls[2]?.url === "https://cursor.test/v1/agents/bc-00000000-0000-0000-0000-000000000001/runs/run-agent" &&
			run.status === "FINISHED" && run.branches[0]?.prUrl === "https://github.com/example/project/pull/7",
	);

	const traversal = await rejection(getRun("secret-key", "bc-1", "..", undefined, options));
	check("run lookups reject IDs that are not single path segments", traversal instanceof Error && calls.length === 3);

	const invalid = await rejection(getApiKeyInfo("do-not-print", undefined, {
		fetch: (async () => jsonResponse(401, {
			error: { code: "api_key_not_found", message: "Key do-not-print is invalid" },
		})) as typeof fetch,
	}));
	check(
		"401 responses are classified as invalid credentials without exposing the key",
		invalid instanceof CursorApiError && isInvalidApiKeyError(invalid) && !invalid.message.includes("do-not-print"),
	);

	const flatError = await rejection(getApiKeyInfo("flat-secret", undefined, {
		fetch: (async () => jsonResponse(400, { error: "Bad Request", message: "Detailed validation failure" })) as typeof fetch,
	}));
	check(
		"flat Cursor error responses preserve their actionable message",
		flatError instanceof CursorApiError && flatError.message.includes("Detailed validation failure"),
	);

	const network = await rejection(getApiKeyInfo("network-secret", undefined, {
		fetch: (async () => { throw new Error("failed for network-secret"); }) as typeof fetch,
	}));
	check(
		"network errors redact credentials",
		network instanceof Error && network.message.includes("[redacted]") && !network.message.includes("network-secret"),
	);

	const uncertainId = "bc-00000000-0000-0000-0000-000000000099";
	const uncertain = await rejection(createAgent("launch-secret", {
		agentId: uncertainId,
		plan: "Implement it.",
		repositoryUrl: "https://github.com/example/project",
		startingRef: "a".repeat(40),
	}, undefined, {
		fetch: (async () => { throw new Error("connection lost for launch-secret"); }) as typeof fetch,
	}));
	check(
		"uncertain launches name the client-supplied agent ID without exposing credentials",
		uncertain instanceof Error && uncertain.message.includes(`cloud_agent_status({ provider: 'cursor', agentId: '${uncertainId}' })`) &&
			uncertain.message.includes("outcome is uncertain") && !uncertain.message.includes("launch-secret"),
	);

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
