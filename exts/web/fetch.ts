/**
 * Anonymous GET with fixed guards: http(s) only, no URL credentials, bounded
 * URL and body sizes, no private-network addresses, and redirects followed only
 * within one origin. Other redirects are returned so the next hop passes
 * through tool-call approval.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { ReadableStream } from "node:stream/web";
import { Agent, fetch } from "undici";

export const MAX_URL_LENGTH = 2048;
export const MAX_REDIRECTS = 5;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_MS = 30_000;
const USER_AGENT = "Mozilla/5.0 (compatible; pi-web-fetch)";

const BLOCKED = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], // unspecified / this network
	["10.0.0.0", 8],
	["100.64.0.0", 10], // CGNAT
	["127.0.0.0", 8],
	["169.254.0.0", 16], // link-local, including cloud metadata
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved and broadcast
] as const) {
	BLOCKED.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7], // unique local
	["fe80::", 10], // link-local
	["fec0::", 10], // site-local
	["ff00::", 8], // multicast
	["64:ff9b:1::", 48], // local-use NAT64
] as const) {
	BLOCKED.addSubnet(network, prefix, "ipv6");
}
const NAT64 = new BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");

/** The IPv4 address embedded in a well-known-prefix NAT64 address, which a gateway may route to a private network. */
function nat64Ipv4(address: string): string | undefined {
	if (!NAT64.check(address, "ipv6")) return undefined;
	const last = address.slice(address.lastIndexOf(":") + 1);
	if (isIP(last) === 4) return last;
	const [head, tail] = address.split("::");
	const headGroups = head.split(":").filter(Boolean);
	const tailGroups = tail === undefined ? [] : tail.split(":").filter(Boolean);
	const groups = [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill("0"), ...tailGroups];
	const bits = (Number.parseInt(groups[6], 16) << 16) | Number.parseInt(groups[7], 16);
	return [bits >>> 24, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join(".");
}

export class WebFetchError extends Error {}

/** True for addresses web_fetch must not connect to. IPv4-mapped IPv6 uses the IPv4 rules. */
export function isBlockedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 0) return true;
	if (family === 6) {
		const embedded = nat64Ipv4(address);
		if (embedded) return BLOCKED.check(embedded, "ipv4");
	}
	return BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Parses and checks a URL, including literal IP hosts, which skip DNS lookup. */
export function validateUrl(text: string, isBlocked = isBlockedAddress): URL {
	if (text.length > MAX_URL_LENGTH) throw new WebFetchError(`URL exceeds ${MAX_URL_LENGTH} characters`);
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new WebFetchError(`invalid URL: ${text}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new WebFetchError(`unsupported URL scheme ${url.protocol}; use http or https`);
	}
	if (url.username || url.password) throw new WebFetchError("URLs with credentials are not allowed");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(host) && isBlocked(host)) throw new WebFetchError(`refusing to connect to private address ${host}`);
	return url;
}

function guardedLookup(isBlocked: (address: string) => boolean): LookupFunction {
	return (hostname, options, callback) => {
		dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
			if (error) {
				callback(error, "", 0);
				return;
			}
			const allowed = addresses.filter((entry) => !isBlocked(entry.address));
			if (allowed.length === 0) {
				const resolved = addresses.map((entry) => entry.address).join(", ");
				callback(new WebFetchError(`refusing to connect to ${hostname}: it resolves to private address ${resolved}`), "", 0);
				return;
			}
			if (options.all) callback(null, allowed);
			else callback(null, allowed[0].address, allowed[0].family);
		});
	};
}

export interface FetchOptions {
	signal?: AbortSignal;
	/** Address policy; replaceable so tests can reach a loopback server. */
	isBlockedAddress?: (address: string) => boolean;
	timeoutMs?: number;
	maxBodyBytes?: number;
}

export type FetchOutcome =
	| {
			kind: "content";
			url: string;
			status: number;
			contentType: string;
			text: string;
			/** True when the body exceeded maxBodyBytes and was cut off. */
			bodyTruncated: boolean;
	  }
	| { kind: "redirect"; url: string; status: number; location: string };

function isTextType(mimeType: string): boolean {
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml" ||
		mimeType === "application/javascript" ||
		mimeType.endsWith("+json") ||
		mimeType.endsWith("+xml")
	);
}

function decoder(contentType: string): TextDecoder {
	const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
	try {
		return new TextDecoder(charset ?? "utf-8");
	} catch {
		return new TextDecoder("utf-8");
	}
}

async function readBody(body: ReadableStream | null, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!body) return { bytes: new Uint8Array(), truncated: false };
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
			if (done) break;
			if (size + value.byteLength > maxBytes) {
				chunks.push(value.subarray(0, maxBytes - size));
				size = maxBytes;
				truncated = true;
				break;
			}
			chunks.push(value);
			size += value.byteLength;
		}
	} finally {
		if (truncated) await reader.cancel().catch(() => {});
		else reader.releaseLock();
	}
	return { bytes: Buffer.concat(chunks, size), truncated };
}

/** An http-to-https redirect on the same host and default ports reaches no new server. */
function isHttpsUpgrade(from: URL, to: URL): boolean {
	return from.protocol === "http:" && to.protocol === "https:" && from.hostname === to.hostname && !from.port && !to.port;
}

/** The guard's own error, if any, from undici's wrapped connection failures. */
function guardError(error: unknown, depth = 0): WebFetchError | undefined {
	if (error instanceof WebFetchError) return error;
	if (depth > 4 || !(error instanceof Error)) return undefined;
	if (error instanceof AggregateError) {
		for (const inner of error.errors) {
			const found = guardError(inner, depth + 1);
			if (found) return found;
		}
	}
	return guardError(error.cause, depth + 1);
}

export async function fetchUrl(text: string, options: FetchOptions = {}): Promise<FetchOutcome> {
	const isBlocked = options.isBlockedAddress ?? isBlockedAddress;
	let url = validateUrl(text, isBlocked);
	const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const agent = new Agent({ connect: { lookup: guardedLookup(isBlocked) } });
	try {
		for (let redirects = 0; ; redirects++) {
			const response = await fetch(url, {
				method: "GET",
				dispatcher: agent,
				redirect: "manual",
				signal,
				headers: {
					accept: "text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1",
					"user-agent": USER_AGENT,
				},
			});

			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel().catch(() => {});
				const location = response.headers.get("location");
				if (!location) throw new WebFetchError(`HTTP ${response.status} redirect without a Location header`);
				let next: URL;
				try {
					next = new URL(location, url);
				} catch {
					throw new WebFetchError(`HTTP ${response.status} redirect to an invalid URL: ${location}`);
				}
				if (next.origin !== url.origin && !isHttpsUpgrade(url, next)) {
					return { kind: "redirect", url: url.href, status: response.status, location: next.href };
				}
				if (redirects >= MAX_REDIRECTS) throw new WebFetchError(`more than ${MAX_REDIRECTS} redirects`);
				url = validateUrl(next.href, isBlocked);
				continue;
			}

			if (response.status >= 400) {
				await response.body?.cancel().catch(() => {});
				throw new WebFetchError(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
			}

			const contentType = response.headers.get("content-type") ?? "";
			const mimeType = contentType.split(";")[0].trim().toLowerCase();
			if (!isTextType(mimeType)) {
				await response.body?.cancel().catch(() => {});
				throw new WebFetchError(`unsupported content type ${mimeType || "(none)"}; only text, JSON, and XML are returned`);
			}
			const body = await readBody(response.body, options.maxBodyBytes ?? MAX_BODY_BYTES);
			return {
				kind: "content",
				url: url.href,
				status: response.status,
				contentType,
				text: decoder(contentType).decode(body.bytes),
				bodyTruncated: body.truncated,
			};
		}
	} catch (error) {
		const guard = guardError(error);
		if (guard) throw guard;
		if (timeout.aborted) throw new WebFetchError(`timed out after ${timeoutMs / 1000}s`);
		if (options.signal?.aborted) throw new WebFetchError("aborted");
		const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
		throw new WebFetchError(`${error instanceof Error ? error.message : String(error)}${cause}`);
	} finally {
		await agent.destroy().catch(() => {});
	}
}
