export interface UsageWindow {
	name: "primary" | "secondary";
	usedPercent: number;
	resetAt?: number;
	minutes?: number;
}

export interface UsageLimit {
	id: string;
	model?: string;
	allowed?: boolean;
	windows: UsageWindow[];
}

export interface UsageSnapshot {
	limits: UsageLimit[];
	at: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function window(value: unknown, name: UsageWindow["name"], stream = false): UsageWindow | undefined {
	const data = object(value);
	const used = number(data?.used_percent);
	if (used === undefined || used < 0 || used > 100) return undefined;
	const reset = number(data?.reset_at);
	const seconds = number(data?.limit_window_seconds);
	return {
		name,
		usedPercent: used,
		resetAt: reset !== undefined && reset > 0 ? reset * 1000 : undefined,
		minutes: stream ? number(data?.window_minutes) : seconds === undefined ? undefined : seconds / 60,
	};
}

function limit(id: string, value: unknown, model?: string): UsageLimit | undefined {
	const data = object(value);
	if (!data) return undefined;
	const windows = [window(data.primary_window, "primary"), window(data.secondary_window, "secondary")].filter((w): w is UsageWindow => !!w);
	if (!windows.length && typeof data.allowed !== "boolean") return undefined;
	return { id, model, allowed: typeof data.allowed === "boolean" ? data.allowed : undefined, windows };
}

export function parseUsage(value: unknown, at: number): UsageSnapshot {
	const data = object(value);
	const limits: UsageLimit[] = [];
	const primary = limit("codex", data?.rate_limit);
	if (primary) limits.push(primary);
	if (Array.isArray(data?.additional_rate_limits)) {
		for (const item of data.additional_rate_limits) {
			const extra = object(item);
			if (!extra || typeof extra.metered_feature !== "string") continue;
			const model = typeof extra.normal_model_slug === "string" ? extra.normal_model_slug
				: typeof extra.limit_name === "string" ? extra.limit_name : undefined;
			const parsed = limit(extra.metered_feature, extra.rate_limit, model);
			if (parsed) limits.push(parsed);
		}
	}
	if (!limits.length) throw new Error("Usage response has no recognizable limits");
	return { limits, at };
}

export function parseHeaders(headers: Record<string, string>, at: number): UsageSnapshot | undefined {
	const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
	const ids = new Set<string>();
	for (const key of Object.keys(normalized)) {
		const match = /^x-(codex(?:-[a-z0-9-]+)?)-(?:primary|secondary)-used-percent$/.exec(key);
		if (match) ids.add(match[1]);
	}
	const limits: UsageLimit[] = [];
	for (const id of ids) {
		const windows: UsageWindow[] = [];
		for (const name of ["primary", "secondary"] as const) {
			const prefix = `x-${id}-${name}`;
			const raw = normalized[`${prefix}-used-percent`];
			if (raw === undefined || raw.trim() === "") continue;
			const parsed = window({
				used_percent: Number(raw),
				reset_at: normalized[`${prefix}-reset-at`] === undefined ? undefined : Number(normalized[`${prefix}-reset-at`]),
				window_minutes: normalized[`${prefix}-window-minutes`] === undefined ? undefined : Number(normalized[`${prefix}-window-minutes`]),
			}, name, true);
			if (parsed) windows.push(parsed);
		}
		if (windows.length) limits.push({ id: id.replaceAll("-", "_"), model: normalized[`x-${id}-limit-name`], windows });
	}
	return limits.length ? { limits, at } : undefined;
}

export function parseStream(value: unknown, model: string, at: number): UsageSnapshot | undefined {
	const data = object(value);
	if (data?.type !== "codex.rate_limits") return undefined;
	const details = object(data.rate_limits);
	const windows = [window(details?.primary, "primary", true), window(details?.secondary, "secondary", true)].filter((w): w is UsageWindow => !!w);
	if (!windows.length) return undefined;
	const id = typeof data.metered_limit_name === "string" ? data.metered_limit_name
		: typeof data.limit_name === "string" ? data.limit_name : "codex";
	const normalized = id.replaceAll("-", "_");
	return { at, limits: [{ id: normalized, model: normalized === "codex" ? undefined : model, windows }] };
}

export function mergeUsage(previous: UsageSnapshot | undefined, update: UsageSnapshot): UsageSnapshot {
	const limits = new Map(previous?.limits.map((item) => [item.id, item]));
	for (const item of update.limits) {
		const old = limits.get(item.id);
		const windows = new Map(old?.windows.map((entry) => [entry.name, entry]));
		for (const entry of item.windows) windows.set(entry.name, entry);
		limits.set(item.id, { ...item, model: item.model ?? old?.model, allowed: item.allowed ?? old?.allowed, windows: [...windows.values()] });
	}
	return { at: update.at, limits: [...limits.values()] };
}

export function allowance(snapshot: UsageSnapshot | undefined, model: string, threshold: number): { remaining?: number; resetAt?: number } {
	const limits = snapshot?.limits.filter((item) => item.id === "codex" || item.model === model) ?? [];
	const windows = limits.flatMap((item) => item.windows);
	const remaining = limits.some((item) => item.allowed === false) ? 0
		: windows.length ? Math.max(0, 100 - Math.max(...windows.map((item) => item.usedPercent))) : undefined;
	const constrained = windows.filter((item) => 100 - item.usedPercent <= threshold);
	const resetAt = constrained.length && constrained.every((item) => item.resetAt !== undefined)
		? Math.max(...constrained.map((item) => item.resetAt!)) : undefined;
	return { remaining, resetAt };
}

export function isQuotaError(message: string): boolean {
	return /usage_limit_reached|subscription_sharing_usage_limit_exceeded|hit your ChatGPT usage limit/i.test(message);
}
