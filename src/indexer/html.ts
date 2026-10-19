const HTML_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: " ",
	quot: '"',
	ndash: "–",
	mdash: "—",
	hellip: "…",
};

function decodeHtmlEntity(entity: string): string {
	if (!entity.startsWith("#")) return HTML_ENTITIES[entity.toLowerCase()] ?? `&${entity};`;
	const hexadecimal = entity[1]?.toLowerCase() === "x";
	const digits = entity.slice(hexadecimal ? 2 : 1);
	const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
	if (
		!digits ||
		!Number.isInteger(codePoint) ||
		codePoint <= 0 ||
		codePoint > 0x10ffff ||
		(codePoint >= 0xd800 && codePoint <= 0xdfff)
	) {
		return `&${entity};`;
	}
	return String.fromCodePoint(codePoint);
}

export function htmlToStructuredMarkdown(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
		.replace(/<h([1-6])\b[^>]*>/gi, (_tag, level: string) => `\n\n${"#".repeat(Number(level))} `)
		.replace(/<\/h[1-6]\s*>/gi, "\n\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<\/li\s*>/gi, "\n")
		.replace(/<br\s*\/?\s*>/gi, "\n")
		.replace(/<(th|td)\b[^>]*>/gi, " | ")
		.replace(/<\/(th|td)\s*>/gi, "")
		.replace(/<tr\b[^>]*>/gi, "\n")
		.replace(/<\/tr\s*>/gi, "\n")
		.replace(
			/<\/?(?:address|article|aside|blockquote|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|header|hr|main|nav|ol|p|section|table|tbody|thead|tfoot|ul)\b[^>]*>/gi,
			"\n\n",
		)
		.replace(/<[^>]+>/g, "")
		.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (_match, entity: string) => decodeHtmlEntity(entity))
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[\t\f\v ]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
