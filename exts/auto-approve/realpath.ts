import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Symlink-resolved form of an absolute path whose trailing components may not
 * exist yet, or undefined when it cannot be determined (e.g. a dangling symlink,
 * which a write would follow, or an unreadable directory).
 */
export function realPathOf(abs: string): string | undefined {
	try {
		return realpathSync(abs);
	} catch (error) {
		if (!isMissing(error)) return undefined;
	}
	try {
		lstatSync(abs);
		// abs exists but does not resolve, so it is a dangling symlink.
		return undefined;
	} catch (error) {
		if (!isMissing(error)) return undefined;
	}
	const parent = dirname(abs);
	if (parent === abs) return undefined;
	const realParent = realPathOf(parent);
	return realParent === undefined ? undefined : join(realParent, basename(abs));
}
