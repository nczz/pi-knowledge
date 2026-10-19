import { describe, expect, it } from "vitest";
import { htmlToStructuredMarkdown } from "../../src/indexer/html.ts";

describe("HTML structure normalization", () => {
	it("preserves headings, paragraphs, lists, tables, and entities as lightweight Markdown", () => {
		const html = `
			<html>
				<head><title>Billing &amp; Payments</title><style>.hidden { display: none; }</style></head>
				<body>
					<h1>Billing &amp; Invoices</h1>
					<p>First paragraph<br>continues on another line.</p>
					<h2>Refunds</h2>
					<ul><li>Approve &#x2713;</li><li>Audit &#10003;</li></ul>
					<table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$20</td></tr></table>
					<script>SecretScriptToken</script>
				</body>
			</html>`;

		const normalized = htmlToStructuredMarkdown(html);

		expect(normalized).toContain("# Billing & Invoices");
		expect(normalized).toContain("First paragraph\ncontinues on another line.");
		expect(normalized).toContain("## Refunds");
		expect(normalized).toContain("- Approve ✓");
		expect(normalized).toContain("| Plan | Price");
		expect(normalized).not.toContain("SecretScriptToken");
		expect(normalized).not.toContain("display: none");
	});

	it("drops an unclosed non-content block instead of indexing its payload", () => {
		expect(htmlToStructuredMarkdown("<h1>Visible</h1><script>HiddenTailToken")).toBe("# Visible");
	});

	it("preserves unknown entities instead of silently deleting source text", () => {
		expect(htmlToStructuredMarkdown("<p>Known &amp; unknown &projectToken;</p>")).toContain(
			"Known & unknown &projectToken;",
		);
	});
});
