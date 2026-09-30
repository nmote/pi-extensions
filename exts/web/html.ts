/**
 * Small HTML-to-text converter for web_fetch. It keeps headings, list items,
 * absolute link targets, and preformatted blocks readable; it is not a full
 * HTML parser.
 *
 * Scanning is linear in the input: backtracking regexes over whole documents
 * can take quadratic time on malformed HTML and block Pi's event loop.
 */

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	bull: "•",
	copy: "©",
	gt: ">",
	hellip: "…",
	laquo: "«",
	ldquo: "“",
	lsquo: "‘",
	lt: "<",
	mdash: "—",
	middot: "·",
	nbsp: "\u00a0",
	ndash: "–",
	quot: '"',
	raquo: "»",
	rdquo: "”",
	reg: "®",
	rsquo: "’",
	times: "×",
	trade: "™",
};

/** Elements whose contents are dropped. */
const SKIPPED = new Set(["iframe", "noscript", "object", "script", "style", "svg", "template", "title"]);
const BLOCKS = new Set([
	"address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption",
	"figure", "footer", "form", "header", "hr", "main", "nav", "ol", "p", "section", "summary", "table", "tbody",
	"tfoot", "thead", "tr", "ul",
]);

export function decodeEntities(text: string): string {
	return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, name: string) => {
		if (name.startsWith("#")) {
			const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
			const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
			return valid ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[name] ?? match;
	});
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function linkTarget(attributes: string, baseUrl: string): string | undefined {
	const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
	if (!match) return undefined;
	try {
		const url = new URL(decodeEntities(match[1] ?? match[2] ?? match[3]), baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		const base = new URL(baseUrl);
		// Same-page fragment links add noise without new content.
		if (url.hash && url.origin === base.origin && url.pathname === base.pathname && url.search === base.search) return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

export function htmlToText(html: string, baseUrl: string): { title?: string; text: string } {
	const source = html.replaceAll("\u0000", "");
	const out: string[] = [];
	const blocks: string[] = [];
	let skipping: string | undefined;
	let title: string | undefined;
	let pre: string[] | undefined;
	let link: { target?: string; start: number } | undefined;
	// Attributes must follow whitespace or "/", so the name and attribute loops cannot trade characters.
	const tagPattern = /<(\/?)([a-zA-Z][\w:-]*)((?:\s|\/)[^<>]*)?>|<!--|<[^<>]*>/y;

	const closeLink = () => {
		if (!link) return;
		const label = collapse(out.splice(link.start).join(""));
		// Output is entity-decoded once at the end; the target is already decoded.
		out.push(link.target && label ? `[${label}](${link.target.replaceAll("&", "&amp;")})` : label);
		link = undefined;
	};

	let index = 0;
	while (index < source.length) {
		const next = source.indexOf("<", index);
		const textEnd = next === -1 ? source.length : next;
		if (textEnd > index) {
			const text = source.slice(index, textEnd);
			if (skipping === "title") title ??= text;
			else if (pre) pre.push(text);
			// Source whitespace, including newlines, renders as one space; tags supply line breaks.
			else if (!skipping) out.push(text.replace(/\s+/g, " "));
		}
		if (next === -1) break;

		tagPattern.lastIndex = next;
		const match = tagPattern.exec(source);
		if (!match) {
			if (!skipping) (pre ?? out).push("<");
			index = next + 1;
			continue;
		}
		index = tagPattern.lastIndex;
		if (match[0] === "<!--" && !skipping) {
			const end = source.indexOf("-->", index);
			index = end === -1 ? source.length : end + 3;
			continue;
		}
		if (!match[2]) continue; // doctype, processing instruction, or other markup
		const closing = match[1] === "/";
		const name = match[2].toLowerCase();

		if (skipping) {
			if (closing && name === skipping) skipping = undefined;
			continue;
		}
		if (pre) {
			if (name === "br") pre.push("\n");
			else if (closing && name === "pre") {
				// trimEnd, not /\s+$/, which is quadratic on long whitespace runs.
				blocks.push(decodeEntities(pre.join("")).replace(/^\n+/, "").trimEnd());
				out.push(`\n\u0000${blocks.length - 1}\u0000\n`);
				pre = undefined;
			}
			continue;
		}

		if (!closing && SKIPPED.has(name)) {
			skipping = name;
		} else if (!closing && name === "pre") {
			pre = [];
		} else if (name === "a") {
			closeLink();
			if (!closing) link = { target: linkTarget(match[3] ?? "", baseUrl), start: out.length };
		} else if (name === "br") {
			out.push("\n");
		} else if (/^h[1-6]$/.test(name)) {
			out.push(closing ? "\n\n" : `\n\n${"#".repeat(Number(name[1]))} `);
		} else if (name === "li" && !closing) {
			out.push("\n- ");
		} else if (closing && (name === "td" || name === "th")) {
			out.push(" | ");
		} else if (BLOCKS.has(name)) {
			out.push("\n\n");
		}
	}
	if (pre) out.push(pre.join(""));
	closeLink();

	const text = decodeEntities(out.join(""))
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.join("\n")
		.replace(/^-\n+(?=\S)/gm, "- ")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.replace(/\u0000(\d+)\u0000/g, (_match, block: string) => `\`\`\`\n${blocks[Number(block)]}\n\`\`\``);
	const titleText = title ? collapse(decodeEntities(title)) : "";
	return { title: titleText || undefined, text };
}
