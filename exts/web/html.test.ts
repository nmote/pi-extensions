import { htmlToText } from "./html.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const page = `<!doctype html>
<html><head><title>Docs &amp; Guides</title><style>body { color: red }</style></head>
<body>
<script>document.write("<p>hidden</p>")</script>
<h2>Install</h2>
<p>Run   the <a href="/cli?x=1&amp;y=2&amp;amp;z">CLI</a>, not <a href="#top">this</a>.<!-- note --></p>
<ul>
  <li><p>First</p></li>
  <li>Second
  &lt;item&gt;</li>
  <li>Third</li>
</ul>
<pre><code>if (a &lt; b) {
    return;
}</code></pre>
</body></html>`;

const { title, text } = htmlToText(page, "https://example.com/docs/");
check("title is extracted and decoded", title === "Docs & Guides");
check(
	"converts headings, links, lists, entities, and preformatted text",
	text ===
		"## Install\n\n" +
			"Run the [CLI](https://example.com/cli?x=1&y=2&amp;z), not this.\n\n" +
			"- First\n\n- Second <item>\n- Third\n\n" +
			"```\nif (a < b) {\n    return;\n}\n```",
);

const started = Date.now();
htmlToText(
	`<pre>${" \n".repeat(100_000)}x</pre>${"<a href=x>".repeat(50_000)}${"<a".repeat(100_000)}${"<!--".repeat(100_000)}<${"a".repeat(200_000)}`,
	"https://example.com/",
);
check("malformed markup converts in linear time", Date.now() - started < 2000);

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
