export interface AvailableModel {
	provider: string;
	id: string;
	name: string;
}

export function matchingModelIds(models: readonly AvailableModel[], rawQuery?: string): string[] {
	const query = rawQuery?.trim().toLowerCase();
	return models
		.filter((model) => {
			if (!query) return true;
			return `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query);
		})
		.map((model) => `${model.provider}/${model.id}`)
		.sort((left, right) => left.localeCompare(right));
}
