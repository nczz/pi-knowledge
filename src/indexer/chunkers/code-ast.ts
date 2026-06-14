import { contentHash, preTokenizeForFTS } from "../chunker.ts";
import type { ChunkInsert } from "../../storage/sqlite.ts";

interface ASTNode {
	type: string;
	text: string;
	startPosition: { row: number };
	endPosition: { row: number };
	children: ASTNode[];
	childForFieldName(name: string): ASTNode | null;
}

const FN_TYPES = new Set(["function_declaration", "method_definition", "arrow_function", "generator_function_declaration"]);
const CLASS_TYPES = new Set(["class_declaration", "interface_declaration"]);

function getName(node: ASTNode): string {
	return node.childForFieldName("name")?.text ?? "anonymous";
}

function collectChunks(root: ASTNode): Array<{ name: string; text: string; start: number; end: number }> {
	const chunks: Array<{ name: string; text: string; start: number; end: number }> = [];

	function walk(node: ASTNode, className?: string) {
		// Exported function
		if (node.type === "export_statement") {
			for (const child of node.children) {
				if (FN_TYPES.has(child.type)) {
					chunks.push({ name: getName(child), text: node.text, start: node.startPosition.row + 1, end: node.endPosition.row + 1 });
					return;
				}
				if (CLASS_TYPES.has(child.type)) { walk(child); return; }
			}
		}
		// Standalone function
		if (FN_TYPES.has(node.type) && !className) {
			chunks.push({ name: getName(node), text: node.text, start: node.startPosition.row + 1, end: node.endPosition.row + 1 });
			return;
		}
		// Class: extract methods
		if (CLASS_TYPES.has(node.type)) {
			const name = getName(node);
			for (const child of node.children) {
				if (child.type === "class_body" || child.type === "interface_body" || child.type === "object_type") {
					for (const member of child.children) {
						if (member.type === "method_definition" || member.type === "public_field_definition") {
							const mName = getName(member);
							chunks.push({ name: `${name}.${mName}`, text: member.text, start: member.startPosition.row + 1, end: member.endPosition.row + 1 });
						}
					}
				}
			}
			return;
		}
		for (const child of node.children) walk(child, className);
	}

	walk(root);
	return chunks;
}

export async function chunkTypeScript(content: string, filePath: string): Promise<Omit<ChunkInsert, "kb_id">[]> {
	const Parser = (await import("tree-sitter")).default;
	const TS = await import("tree-sitter-typescript");
	const lang = filePath.endsWith(".tsx") ? (TS.tsx ?? (TS as any).default?.tsx) : (TS.typescript ?? (TS as any).default?.typescript);

	const parser = new Parser();
	parser.setLanguage(lang);
	const tree = parser.parse(content);
	const fns = collectChunks(tree.rootNode as unknown as ASTNode);

	if (fns.length === 0) return [];

	return fns.map((fn) => ({
		content_hash: contentHash(fn.text),
		content: fn.text,
		content_tokenized: preTokenizeForFTS(fn.text),
		file_path: filePath,
		file_type: "typescript",
		start_line: fn.start,
		end_line: fn.end,
		metadata_json: JSON.stringify({ function_name: fn.name }),
	}));
}
