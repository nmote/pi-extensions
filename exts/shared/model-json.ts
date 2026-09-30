/**
 * Parses a JSON object out of untrusted model output that may be wrapped in
 * markdown fences or surrounded by prose. Text before the first "{" and after
 * the last "}" is discarded; what remains must itself be valid object JSON.
 */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const value: unknown = JSON.parse(text.slice(start, end + 1));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}
