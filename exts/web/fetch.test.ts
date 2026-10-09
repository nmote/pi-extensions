import { readFile, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchUrl, isBlockedAddress, validateUrl } from "./fetch.ts";
import web, { savePdf, WEB_FETCH_TOOL } from "./index.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function throws(fn: () => unknown): boolean {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
}

async function main(): Promise<void> {
	const blocked = [
		"0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.31.255.255", "192.168.1.1",
		"224.0.0.1", "255.255.255.255", "::", "::1", "fd00::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:7f00:1",
		"64:ff9b::a00:1", "64:ff9b::10.0.0.1", "64:ff9b:1::808:808",
	];
	const allowed = ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "64:ff9b::808:808"];
	check(
		"address policy blocks private, local, and special ranges",
		blocked.every(isBlockedAddress) && !allowed.some(isBlockedAddress),
	);
	check(
		"URL validation rejects other schemes, credentials, long URLs, and private literal hosts",
		throws(() => validateUrl("file:///etc/passwd")) &&
			throws(() => validateUrl("https://user:secret@example.com/")) &&
			throws(() => validateUrl(`https://example.com/${"a".repeat(2048)}`)) &&
			throws(() => validateUrl("http://2130706433/")) &&
			throws(() => validateUrl("http://[::ffff:127.0.0.1]/")) &&
			!throws(() => validateUrl("https://example.com/docs?q=1")),
	);

	const googleSearchUrls = [
		"https://www.google.com/search?q=x",
		"https://google.com/search?q=x",
		"https://encrypted.google.com/search?q=x",
		"https://www.google.co.uk/search?q=x",
		"https://www.google.com.br/search?q=x",
		"https://www.google.com/webhp?q=x",
		"https://www.google.com/advanced_search",
		"https://www.google.com/",
		"https://google.com/",
		"https://images.google.com/",
		"https://images.google.com/imghp?q=x",
		"https://news.google.com/",
		"https://news.google.com/nshp?q=x",
		"https://www.google.com./search?q=x",
		"https://www.google.com/%73earch?q=x",
	];
	const otherGoogleUrls = [
		"https://developers.google.com/",
		"https://cloud.google.com/docs",
		"https://docs.google.com/document/d/abc",
		"https://news.google.com/articles/abc",
		"https://maps.google.com/?q=paris",
		"https://google.com.example.org/search?q=x",
		"https://notgoogle.com/search?q=x",
		"https://www.googleapis.com/youtube/v3/videos?id=abc",
	];
	check(
		"URL validation refuses Google search entry points and allows other Google resources",
		googleSearchUrls.every((text) => throws(() => validateUrl(text))) &&
			otherGoogleUrls.every((text) => !throws(() => validateUrl(text))),
	);
	check(
		"direct Google search fetches are refused before any request",
		(await rejection(fetchUrl("https://www.google.com/search?q=x"))).includes("prohibited"),
	);

	const pdfBytes = Buffer.from("%PDF-1.7\n\x00\xff\x80\n%%EOF", "latin1");
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		if (request.url === "/same") {
			response.writeHead(302, { location: "/page" }).end();
		} else if (request.url === "/cross") {
			response.writeHead(302, { location: `http://localhost:${port}/page` }).end();
		} else if (request.url === "/google") {
			response.writeHead(302, { location: "https://www.google.com/search?q=redirect" }).end();
		} else if (request.url === "/pdf") {
			response.writeHead(200, {
				"content-type": "Application/PDF; version=1.7",
				"content-disposition": 'attachment; filename="../../unsafe.pdf"',
			}).end(pdfBytes);
		} else {
			response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("hello");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	try {
		const hostnameBlock = await rejection(fetchUrl(`http://localhost:${port}/page`));
		check(
			"hostnames resolving to private addresses are refused before any request",
			hostnameBlock.includes("private address") && requests.length === 0,
		);

		const allowLoopback = { isBlockedAddress: () => false };
		const same = await fetchUrl(`http://127.0.0.1:${port}/same`, allowLoopback);
		check(
			"same-origin redirects are followed",
			same.kind === "content" && same.url === `http://127.0.0.1:${port}/page` && same.text === "hello",
		);

		const pdf = await fetchUrl(`http://127.0.0.1:${port}/pdf`, { ...allowLoopback, maxBodyBytes: pdfBytes.length });
		check("PDF at download limit returns unchanged bytes", pdf.kind === "pdf" && Buffer.from(pdf.bytes).equals(pdfBytes));
		if (pdf.kind === "pdf") {
			const saved = await savePdf(pdf);
			const path = saved.details.downloadPath!;
			try {
				check("PDF result reports private byte-exact file with safe name",
					isAbsolute(path) && path.endsWith("/document.pdf") &&
					(await readFile(path)).equals(pdfBytes) &&
					((await stat(path)).mode & 0o777) === 0o600 &&
					((await stat(dirname(path))).mode & 0o777) === 0o700 &&
					saved.content[0].text.includes(path) && saved.content[0].text.includes(`Bytes: ${pdfBytes.length}`) &&
					saved.content[0].text.includes("not inspected or extracted"));
			} finally {
				await rm(dirname(path), { recursive: true, force: true });
			}
		}
		check("oversized PDFs are rejected before saving",
			(await rejection(fetchUrl(`http://127.0.0.1:${port}/pdf`, {
				...allowLoopback, maxBodyBytes: pdfBytes.length - 1,
			}))).includes("PDF exceeds download limit"));
		const partialText = await fetchUrl(`http://127.0.0.1:${port}/page`, { ...allowLoopback, maxBodyBytes: 2 });
		check("text downloads still return truncated text", partialText.kind === "content" && partialText.text === "he" && partialText.bodyTruncated);

		const before = requests.length;
		const cross = await fetchUrl(`http://127.0.0.1:${port}/cross`, allowLoopback);
		check(
			"cross-origin redirects are returned without being followed",
			cross.kind === "redirect" && cross.location === `http://localhost:${port}/page` && requests.length === before + 1,
		);

		const beforeGoogle = requests.length;
		const googleRedirect = await rejection(fetchUrl(`http://127.0.0.1:${port}/google`, allowLoopback));
		check(
			"redirects to Google search are rejected after the initial request only",
			googleRedirect.includes("prohibited") && requests.length === beforeGoogle + 1,
		);
	} finally {
		server.close();
	}

	const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
	web({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never) } as unknown as ExtensionAPI);
	const toolBlock = await rejection(tools.get(WEB_FETCH_TOOL)!.execute("call-1", { url: "http://169.254.169.254/latest/meta-data/" }));
	check("web_fetch tool applies the default address policy", toolBlock.includes("private address"));
	const toolGoogleBlock = await rejection(tools.get(WEB_FETCH_TOOL)!.execute("call-2", { url: "https://www.google.com/search?q=x" }));
	check("web_fetch tool refuses Google searches", toolGoogleBlock.includes("prohibited"));

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
