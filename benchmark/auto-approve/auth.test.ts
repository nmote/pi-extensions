/** Offline request-time OAuth refresh. Run with ./scripts/test benchmark/auto-approve. */
import { strict as assert } from "node:assert";
import {
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	type AssistantMessage,
	type Model,
	type OAuthCredential,
	type Provider,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const providerId = "benchmark-offline-oauth";
const credentials = new InMemoryCredentialStore();
const expired: OAuthCredential = { type: "oauth", access: "dummy-expired", refresh: "dummy-refresh", expires: 0 };
const refreshed: OAuthCredential = {
	type: "oauth", access: "dummy-fresh", refresh: "dummy-rotated", expires: Date.now() + 60 * 60 * 1000,
};
const model: Model<"benchmark-offline-api"> = {
	id: "offline", name: "Offline", provider: providerId, api: "benchmark-offline-api",
	baseUrl: "https://benchmark.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
};
let refreshCalls = 0;
let requestCalls = 0;
let networkCalls = 0;
const events: string[] = [];
const provider: Provider<"benchmark-offline-api"> = {
	id: providerId,
	name: "Offline OAuth",
	auth: {
		oauth: {
			name: "Offline OAuth",
			login: async () => { throw new Error("login must not run"); },
			refresh: async (current, signal) => {
				signal.throwIfAborted();
				assert.deepEqual(current, expired);
				refreshCalls++;
				events.push("refresh");
				return refreshed;
			},
			toAuth: async (current) => {
				assert.deepEqual(current, refreshed);
				assert.deepEqual(await credentials.read(providerId), refreshed);
				events.push("derive-auth");
				return { apiKey: current.access };
			},
		},
	},
	getModels: () => [model],
	stream: () => { throw new Error("expected streamSimple"); },
	streamSimple: (requestedModel, _context, options) => {
		assert.equal(requestedModel.id, model.id);
		assert.equal(options?.apiKey, refreshed.access);
		requestCalls++;
		events.push("request");
		const response: AssistantMessage = {
			role: "assistant", api: model.api, provider: providerId, model: model.id,
			content: [{ type: "text", text: '{"decision":"allow","reason":"offline"}' }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...model.cost, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: response });
		stream.push({ type: "done", reason: "stop", message: response });
		stream.end();
		return stream;
	},
};

async function createRuntime(): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	// Dummy stored OAuth entries prevent availability checks from reading ambient keys or cloud auth files.
	for (const builtin of runtime.getProviders()) {
		await credentials.modify(builtin.id, async () => ({ ...refreshed }));
	}
	runtime.registerNativeProvider(provider);
	// Await the offline catalog/availability pass also triggered by provider registration.
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	networkCalls++;
	throw new Error("network forbidden in offline OAuth test");
};
try {
	await credentials.modify(providerId, async () => ({ ...expired }));
	const runtime = await createRuntime();
	assert.equal(refreshCalls, 0);
	assert.deepEqual(await credentials.read(providerId), expired);
	assert.ok((await runtime.getAvailable(providerId)).some((value) => value.id === model.id));
	assert.equal(refreshCalls, 0);

	const response = await runtime.completeSimple(model, { messages: [{ role: "user", content: "offline", timestamp: 0 }] });
	assert.equal(response.stopReason, "stop", response.errorMessage);
	assert.equal(refreshCalls, 1);
	assert.equal(requestCalls, 1);
	assert.deepEqual(await credentials.read(providerId), refreshed);
	assert.deepEqual(events, ["refresh", "derive-auth", "request"]);
	console.log("  ok  OAuth refresh occurs at request time and persists before dispatch");

	// A new runtime must reuse the stored rotated credential rather than a runtime-local auth cache.
	const nextRuntime = await createRuntime();
	const next = await nextRuntime.completeSimple(model, { messages: [{ role: "user", content: "offline again", timestamp: 0 }] });
	assert.equal(next.stopReason, "stop", next.errorMessage);
	assert.equal(refreshCalls, 1);
	assert.equal(requestCalls, 2);
	assert.deepEqual(events, ["refresh", "derive-auth", "request", "derive-auth", "request"]);
	assert.equal(networkCalls, 0);
	console.log("  ok  a second runtime reuses persisted OAuth credentials without another refresh");
} finally {
	globalThis.fetch = originalFetch;
}
console.log("\nall checks passed");
