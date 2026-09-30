import type { Usage } from "@earendil-works/pi-ai";

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function isUsage(value: unknown): value is Usage {
	if (!value || typeof value !== "object") return false;
	const usage = value as Partial<Usage>;
	const cost = usage.cost as Partial<Usage["cost"]> | undefined;
	return (
		finiteNumber(usage.input) &&
		finiteNumber(usage.output) &&
		finiteNumber(usage.cacheRead) &&
		finiteNumber(usage.cacheWrite) &&
		(usage.cacheWrite1h === undefined || finiteNumber(usage.cacheWrite1h)) &&
		(usage.reasoning === undefined || finiteNumber(usage.reasoning)) &&
		finiteNumber(usage.totalTokens) &&
		!!cost &&
		finiteNumber(cost.input) &&
		finiteNumber(cost.output) &&
		finiteNumber(cost.cacheRead) &&
		finiteNumber(cost.cacheWrite) &&
		finiteNumber(cost.total)
	);
}

function optionalSum(left: number | undefined, right: number | undefined): number | undefined {
	return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

export function addUsage(left: Usage, right: Usage): Usage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		cacheWrite1h: optionalSum(left.cacheWrite1h, right.cacheWrite1h),
		reasoning: optionalSum(left.reasoning, right.reasoning),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

export function addUsageCost(usage: Usage, auxiliary: Usage): Usage {
	return {
		...usage,
		cost: {
			input: usage.cost.input + auxiliary.cost.input,
			output: usage.cost.output + auxiliary.cost.output,
			cacheRead: usage.cost.cacheRead + auxiliary.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite + auxiliary.cost.cacheWrite,
			total: usage.cost.total + auxiliary.cost.total,
		},
	};
}
