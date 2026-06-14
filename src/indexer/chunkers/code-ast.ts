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

type LangConfig = {
	grammar: () => Promise<any>;
	fnTypes: Set<string>;
	classTypes: Set<string>;
	methodContainer?: string;
	classBody?: string;
	fileType: string;
};

const LANGS: Record<string, LangConfig> = {
	typescript: {
		grammar: async () => { const m = await import("tree-sitter-typescript"); return m.typescript ?? m.default?.typescript; },
		fnTypes: new Set(["function_declaration", "arrow_function", "generator_function_declaration"]),
		classTypes: new Set(["class_declaration", "interface_declaration"]),
		classBody: "class_body",
		fileType: "typescript",
	},
	javascript: {
		grammar: async () => { const m = await import("tree-sitter-typescript"); return m.typescript ?? m.default?.typescript; },
		fnTypes: new Set(["function_declaration", "arrow_function", "generator_function_declaration"]),
		classTypes: new Set(["class_declaration"]),
		classBody: "class_body",
		fileType: "javascript",
	},
	python: {
		grammar: async () => { const m = await import("tree-sitter-python"); return m.default ?? m; },
		fnTypes: new Set(["function_definition"]),
		classTypes: new Set(["class_definition"]),
		classBody: "block",
		fileType: "python",
	},
	go: {
		grammar: async () => { const m = await import("tree-sitter-go"); return m.default ?? m; },
		fnTypes: new Set(["function_declaration", "method_declaration"]),
		classTypes: new Set(["type_declaration"]),
		fileType: "go",
	},
	rust: {
		grammar: async () => { const m = await import("tree-sitter-rust"); return m.default ?? m; },
		fnTypes: new Set(["function_item"]),
		classTypes: new Set(["struct_item", "enum_item"]),
		methodContainer: "impl_item",
		fileType: "rust",
	},
	java: {
		grammar: async () => { const m = await import("tree-sitter-java"); return m.default ?? m; },
		fnTypes: new Set(["method_declaration", "constructor_declaration"]),
		classTypes: new Set(["class_declaration", "interface_declaration", "enum_declaration"]),
		classBody: "class_body",
		fileType: "java",
	},
};

function getName(node: ASTNode): string {
	return node.childForFieldName("name")?.text ?? node.childForFieldName("type")?.text ?? "anonymous";
}

function collectChunks(root: ASTNode, config: LangConfig): Array<{ name: string; text: string; start: number; end: number }> {
	const chunks: Array<{ name: string; text: string; start: number; end: number }> = [];

	function walk(node: ASTNode) {
		if (node.type === "export_statement") {
			for (const child of node.children) {
				if (config.fnTypes.has(child.type)) { chunks.push({ name: getName(child), text: node.text, start: node.startPosition.row + 1, end: node.endPosition.row + 1 }); return; }
				if (config.classTypes.has(child.type)) { walk(child); return; }
			}
		}
		if (node.type === "decorated_definition") {
			for (const child of node.children) {
				if (config.fnTypes.has(child.type) || config.classTypes.has(child.type)) {
					chunks.push({ name: getName(child), text: node.text, start: node.startPosition.row + 1, end: node.endPosition.row + 1 }); return;
				}
			}
		}
		if (config.fnTypes.has(node.type)) {
			chunks.push({ name: getName(node), text: node.text, start: node.startPosition.row + 1, end: node.endPosition.row + 1 }); return;
		}
		if (config.classTypes.has(node.type)) {
			const name = getName(node);
			let hasChildren = false;
			for (const child of node.children) {
				if (config.classBody && child.type === config.classBody) {
					for (const m of child.children) {
						if (config.fnTypes.has(m.type) || m.type === "method_definition") {
							hasChildren = true;
							chunks.push({ name: `${name}.${getName(m)}`, text: m.text, start: m.startPosition.row + 1, end: m.endPosition.row + 1 });
						}
					}
				}
			}
			if (!hasChildren) chunks.push({ name, text: node.text, start: node.startPosition.row + 1, end: node.endPosition.row + 1 });
			return;
		}
		if (config.methodContainer && node.type === config.methodContainer) {
			const typeName = getName(node);
			for (const child of node.children) {
				if (child.type === "declaration_list") {
					for (const m of child.children) {
						if (config.fnTypes.has(m.type)) chunks.push({ name: `${typeName}.${getName(m)}`, text: m.text, start: m.startPosition.row + 1, end: m.endPosition.row + 1 });
					}
				}
			}
			return;
		}
		for (const child of node.children) walk(child);
	}

	walk(root);
	return chunks;
}

export async function chunkWithAST(content: string, filePath: string, language: string): Promise<Omit<ChunkInsert, "kb_id">[]> {
	const config = LANGS[language];
	if (!config) return [];
	const Parser = (await import("tree-sitter")).default;
	const grammar = await config.grammar();
	const parser = new Parser();
	parser.setLanguage(grammar);
	const tree = parser.parse(content);
	const fns = collectChunks(tree.rootNode as unknown as ASTNode, config);
	if (fns.length === 0) return [];
	return fns.map((fn) => ({
		content_hash: contentHash(fn.text),
		content: fn.text,
		content_tokenized: preTokenizeForFTS(fn.text),
		file_path: filePath,
		file_type: config.fileType,
		start_line: fn.start,
		end_line: fn.end,
		metadata_json: JSON.stringify({ function_name: fn.name }),
	}));
}

export const SUPPORTED_LANGUAGES = new Set(Object.keys(LANGS));
