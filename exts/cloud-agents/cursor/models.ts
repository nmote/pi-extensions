import type { CursorModel, ModelSelection } from "./client.ts";

export interface ResolvedModelSelection {
	selection: ModelSelection;
	effortParameter?: string;
}

function choices(ids: readonly string[]): string {
	return ids.join(", ");
}

function sameParams(left: NonNullable<ModelSelection["params"]>, right: NonNullable<ModelSelection["params"]>): boolean {
	return left.length === right.length && left.every((param) =>
		right.some((other) => other.id === param.id && other.value === param.value));
}

const EFFORT_PARAMETERS = ["effort", "reasoning", "reasoning_effort"];

export function resolveModelSelection(
	catalog: readonly CursorModel[],
	model: string,
	effort?: string,
): ResolvedModelSelection {
	const exact = catalog.find((item) => item.id === model);
	const aliases = catalog.filter((item) => item.aliases.includes(model));
	if (!exact && aliases.length > 1) {
		throw new Error(`Cursor model alias ${JSON.stringify(model)} is ambiguous: ${choices(aliases.map((item) => item.id))}.`);
	}
	const resolved = exact ?? aliases[0];
	if (!resolved) throw new Error(`Unknown Cursor model ${JSON.stringify(model)}. Valid models: ${choices(catalog.map((item) => item.id))}.`);
	if (effort === undefined) return { selection: { id: resolved.id } };

	const parameter = EFFORT_PARAMETERS
		.map((id) => resolved.parameters.find((item) => item.id === id))
		.find((item) => item !== undefined);
	if (!parameter) throw new Error(`Cursor model ${resolved.id} has no effort setting.`);
	if (!parameter.values.includes(effort)) {
		throw new Error(`Invalid effort ${JSON.stringify(effort)} for Cursor model ${resolved.id}. Valid values: ${choices(parameter.values)}.`);
	}

	const defaultVariant = resolved.variants.find((variant) => variant.isDefault) ?? resolved.variants[0];
	if (!defaultVariant) {
		return { selection: { id: resolved.id, params: [{ id: parameter.id, value: effort }] }, effortParameter: parameter.id };
	}
	const updated = defaultVariant.params.map((item) =>
		item.id === parameter.id ? { ...item, value: effort } : { ...item });
	if (!updated.some((item) => item.id === parameter.id)) updated.push({ id: parameter.id, value: effort });
	const variant = resolved.variants.find((item) => sameParams(item.params, updated)) ??
		resolved.variants.find((item) => item.params.some((param) => param.id === parameter.id && param.value === effort));
	if (!variant) {
		const listed = [...new Set(resolved.variants.flatMap((item) =>
			item.params.filter((param) => param.id === parameter.id).map((param) => param.value)))];
		throw new Error(`No Cursor model ${resolved.id} variant supports effort ${JSON.stringify(effort)}. Supported values: ${choices(listed)}.`);
	}
	return { selection: { id: resolved.id, params: variant.params.map((item) => ({ ...item })) }, effortParameter: parameter.id };
}
