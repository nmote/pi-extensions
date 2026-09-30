/**
 * Pairs provider HTTP response identifiers with the assistant message they
 * produced, so a session records the ids a provider needs to locate a request.
 *
 * Pi surfaces response headers (`after_provider_response`) separately from the
 * finished message (`message_end`) with no shared key, so the two are matched
 * by arrival order.
 */

/** Response headers carrying a request id, in preference order. */
const REQUEST_ID_HEADERS = ["request-id", "x-request-id"] as const;
const ORGANIZATION_ID_HEADER = "anthropic-organization-id";

export interface ProviderRequestRecord {
	/** Request id from the response headers. */
	requestId: string;
	/** Provider message id, absent when the response produced no message. */
	messageId?: string;
	provider?: string;
	/** Model reported by the message, falling back to the requested model. */
	model?: string;
	status: number;
	organizationId?: string;
	/** Present on non-200 responses that asked the client to back off. */
	retryAfter?: string;
	/** ISO timestamp of the response. */
	at: string;
}

interface PendingResponse {
	requestId: string;
	status: number;
	organizationId?: string;
	retryAfter?: string;
	at: string;
	model?: string;
}

interface AssistantResponse {
	provider?: string;
	model?: string;
	responseId?: string;
}

function header(headers: Record<string, string>, name: string): string | undefined {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name && value) return value;
	}
	return undefined;
}

/** Model from a provider payload, which is opaque to extensions. */
export function payloadModel(payload: unknown): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const model = (payload as { model?: unknown }).model;
	return typeof model === "string" && model ? model : undefined;
}

export class RequestIdCapture {
	/**
	 * Model of the most recent request. A request that fails before returning
	 * headers never reaches `onResponse`, so holding only the latest keeps a
	 * dropped request from shifting every later model by one.
	 */
	private requestedModel?: string;
	/** Responses not yet attributed to a message. */
	private pending: PendingResponse[] = [];

	onRequest(payload: unknown): void {
		this.requestedModel = payloadModel(payload);
	}

	/** Records a response; ignored when the provider exposes no request id. */
	onResponse(status: number, headers: Record<string, string>, at: string): void {
		const model = this.requestedModel;
		this.requestedModel = undefined;
		let requestId: string | undefined;
		for (const name of REQUEST_ID_HEADERS) {
			requestId ??= header(headers, name);
		}
		if (!requestId) return;
		this.pending.push({
			requestId,
			status,
			organizationId: header(headers, ORGANIZATION_ID_HEADER),
			retryAfter: status === 200 ? undefined : header(headers, "retry-after"),
			at,
			model,
		});
	}

	/**
	 * Attributes pending responses to a finished message. Retried attempts are
	 * kept as their own records; only the last response produced the message.
	 */
	onAssistantMessage(message: AssistantResponse): ProviderRequestRecord[] {
		const pending = this.pending;
		this.pending = [];
		return pending.map((response, index) => {
			const last = index === pending.length - 1;
			return {
				...response,
				model: message.model ?? response.model,
				...(last ? { messageId: message.responseId, provider: message.provider } : {}),
			};
		});
	}

	/** Records for responses that never produced a message, e.g. after an abort. */
	flush(): ProviderRequestRecord[] {
		const pending = this.pending;
		this.pending = [];
		this.requestedModel = undefined;
		return pending;
	}
}
