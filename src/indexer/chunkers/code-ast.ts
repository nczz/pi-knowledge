import type { ChunkInsert, KnowledgeSymbolInsert } from "../../storage/sqlite.ts";
import { buildChunkEmbeddingText, chunkIdentityHash, preTokenizeForFTS } from "../chunker.ts";

interface ASTPoint {
	row: number;
	column?: number;
}

interface ASTNode {
	type: string;
	text: string;
	startPosition: ASTPoint;
	endPosition: ASTPoint;
	startIndex: number;
	endIndex: number;
	children: ASTNode[];
	namedChildren?: ASTNode[];
	childForFieldName(name: string): ASTNode | null;
}

type JsonMetadata = Record<string, string | number | boolean | string[] | number[] | boolean[] | null | undefined>;

type StructureKind = "module" | "class" | "interface" | "type" | "function" | "method" | "constructor" | "variable";

export interface CodeStructureNode {
	kind: StructureKind;
	astType: string;
	name?: string;
	signature?: string;
	language: string;
	startLine: number;
	endLine: number;
	startByte: number;
	endByte: number;
	exported: boolean;
	decorators: string[];
	parentSymbol?: string;
	scope: string[];
	astPath: string[];
	children: CodeStructureNode[];
}

export interface CodeAnalysisResult {
	chunks: Omit<ChunkInsert, "kb_id">[];
	symbols: KnowledgeSymbolInsert[];
	structure: CodeStructureNode;
}

type LangConfig = {
	grammar: () => Promise<unknown>;
	fileType: string;
	fallbackOnParseError?: boolean;
};

function moduleField(moduleValue: unknown, field: string): unknown {
	if (typeof moduleValue !== "object" || moduleValue === null) return undefined;
	return (moduleValue as Record<string, unknown>)[field];
}

function moduleDefault(moduleValue: unknown): unknown {
	return moduleField(moduleValue, "default");
}

const LANGS: Record<string, LangConfig> = {
	typescript: {
		grammar: async () => {
			const m = await import("tree-sitter-typescript");
			return moduleField(m, "typescript") ?? moduleField(moduleDefault(m), "typescript");
		},
		fileType: "typescript",
	},
	javascript: {
		grammar: async () => {
			const m = await import("tree-sitter-javascript");
			return moduleDefault(m) ?? m;
		},
		fileType: "javascript",
	},
	python: {
		grammar: async () => {
			const m = await import("tree-sitter-python");
			return moduleDefault(m) ?? m;
		},
		fileType: "python",
	},
	go: {
		grammar: async () => {
			const m = await import("tree-sitter-go");
			return moduleDefault(m) ?? m;
		},
		fileType: "go",
	},
	rust: {
		grammar: async () => {
			const m = await import("tree-sitter-rust");
			return moduleDefault(m) ?? m;
		},
		fileType: "rust",
	},
	java: {
		grammar: async () => {
			const m = await import("tree-sitter-java");
			return moduleDefault(m) ?? m;
		},
		fileType: "java",
	},
	bash: {
		grammar: async () => {
			const m = await import("tree-sitter-bash");
			return moduleDefault(m) ?? m;
		},
		fileType: "bash",
		fallbackOnParseError: true,
	},
};

const CLASS_TYPES = new Set([
	"abstract_class_declaration",
	"class_declaration",
	"class_definition",
	"enum_declaration",
]);
const INTERFACE_TYPES = new Set(["interface_declaration"]);
const TYPE_TYPES = new Set([
	"annotation_type_declaration",
	"enum_item",
	"struct_item",
	"trait_item",
	"type_alias_declaration",
	"type_declaration",
]);
const FUNCTION_TYPES = new Set([
	"function_declaration",
	"function_definition",
	"function_item",
	"generator_function_declaration",
	"method_declaration",
]);
const METHOD_TYPES = new Set(["method_definition"]);
const CONSTRUCTOR_TYPES = new Set(["constructor_declaration"]);
const DECLARATION_WRAPPERS = new Set(["export_statement", "decorated_definition"]);
const VARIABLE_DECLARATOR_TYPES = new Set(["variable_declarator"]);
const FIELD_DEFINITION_TYPES = new Set(["public_field_definition", "field_definition", "property_declaration"]);
const FUNCTION_VALUE_TYPES = new Set([
	"arrow_function",
	"function",
	"function_expression",
	"function_declaration",
	"generator_function",
	"generator_function_declaration",
]);
const AST_TARGET_TOKENS = 900;
const AST_MAX_TOKENS = 1_800;
const MAX_AST_FALLBACK_CHARS = 6_000;

interface BuildContext {
	language: string;
	exported: boolean;
	decorators: string[];
	scope: string[];
	parentSymbol?: string;
	astPath: string[];
	spanNode?: ASTNode;
}

interface ByteIndexMap {
	content: string;
	byByte: Map<number, number>;
}

interface ChunkDraft {
	content: string;
	startLine: number;
	endLine: number;
	startByte: number;
	endByte: number;
	metadata: JsonMetadata;
	packable: boolean;
	packKey: string;
	symbols: string[];
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3);
}

function buildByteIndexMap(content: string): ByteIndexMap {
	const byByte = new Map<number, number>();
	let byteOffset = 0;
	for (let index = 0; index < content.length; ) {
		byByte.set(byteOffset, index);
		const codePoint = content.codePointAt(index);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		byteOffset += Buffer.byteLength(char);
		index += char.length;
	}
	byByte.set(byteOffset, content.length);
	return { content, byByte };
}

function stringIndexForByte(map: ByteIndexMap, byteOffset: number): number {
	const exact = map.byByte.get(byteOffset);
	if (exact !== undefined) return exact;
	let closestByte = 0;
	let closestIndex = 0;
	for (const [candidateByte, candidateIndex] of map.byByte) {
		if (candidateByte > byteOffset) break;
		closestByte = candidateByte;
		closestIndex = candidateIndex;
	}
	return closestByte === byteOffset ? closestIndex : closestIndex;
}

function sliceByBytes(map: ByteIndexMap, startByte: number, endByte: number): string {
	return map.content.slice(stringIndexForByte(map, startByte), stringIndexForByte(map, endByte));
}

function nodeChildren(node: ASTNode): ASTNode[] {
	return node.namedChildren && node.namedChildren.length > 0 ? node.namedChildren : node.children;
}

function getName(node: ASTNode): string | undefined {
	const name = node.childForFieldName("name")?.text ?? node.childForFieldName("type")?.text;
	if (name?.trim()) return name.trim();
	if (node.type === "constructor_declaration") return "constructor";
	return undefined;
}

function nodeHasFunctionValue(node: ASTNode): boolean {
	return nodeChildren(node).some((child) => FUNCTION_VALUE_TYPES.has(child.type) || nodeHasFunctionValue(child));
}

function firstStructuralChild(node: ASTNode): ASTNode | undefined {
	return nodeChildren(node).find((child) => isStructuralCandidate(child) || child.type === "lexical_declaration");
}

function decoratorsFor(node: ASTNode, inherited: string[] = []): string[] {
	const decorators = node.children.filter((child) => child.type === "decorator").map((child) => child.text.trim());
	return [...inherited, ...decorators].filter(Boolean);
}

function isStructuralCandidate(node: ASTNode): boolean {
	return (
		CLASS_TYPES.has(node.type) ||
		INTERFACE_TYPES.has(node.type) ||
		TYPE_TYPES.has(node.type) ||
		FUNCTION_TYPES.has(node.type) ||
		METHOD_TYPES.has(node.type) ||
		CONSTRUCTOR_TYPES.has(node.type)
	);
}

function kindForNode(node: ASTNode): StructureKind | undefined {
	if (CLASS_TYPES.has(node.type)) return "class";
	if (INTERFACE_TYPES.has(node.type)) return "interface";
	if (TYPE_TYPES.has(node.type)) return "type";
	if (METHOD_TYPES.has(node.type) || node.type === "method_declaration") return "method";
	if (CONSTRUCTOR_TYPES.has(node.type)) return "constructor";
	if (FUNCTION_TYPES.has(node.type)) return "function";
	return undefined;
}

function signatureFromText(text: string, kind: StructureKind): string | undefined {
	const normalized = text.trim();
	if (!normalized) return undefined;
	const bodyMarkers =
		kind === "function" || kind === "method" || kind === "constructor"
			? normalized.startsWith("def ") || normalized.startsWith("async def ")
				? [":"]
				: ["{", "=>"]
			: ["{"];
	let end = normalized.length;
	for (const marker of bodyMarkers) {
		const index = normalized.indexOf(marker);
		if (index > 0) end = Math.min(end, marker === "=>" ? index + marker.length : index);
	}
	const firstLine = normalized.slice(0, end).replace(/\s+/g, " ").trim();
	return firstLine.length > 280 ? `${firstLine.slice(0, 277)}...` : firstLine;
}

function createStructureNode(
	node: ASTNode,
	kind: StructureKind,
	name: string | undefined,
	context: BuildContext,
	map: ByteIndexMap,
): CodeStructureNode {
	const span = context.spanNode ?? node;
	const scope = name ? [...context.scope, name] : [...context.scope];
	const text = sliceByBytes(map, span.startIndex, span.endIndex);
	const astPath = [...context.astPath, node.type];
	return {
		kind,
		astType: node.type,
		name,
		signature: signatureFromText(text, kind),
		language: context.language,
		startLine: span.startPosition.row + 1,
		endLine: span.endPosition.row + 1,
		startByte: span.startIndex,
		endByte: span.endIndex,
		exported: context.exported,
		decorators: decoratorsFor(span, context.decorators),
		parentSymbol: context.parentSymbol,
		scope,
		astPath,
		children: [],
	};
}

function childContext(parent: CodeStructureNode, context: BuildContext): BuildContext {
	return {
		language: context.language,
		exported: false,
		decorators: [],
		scope: parent.scope,
		parentSymbol: parent.name ?? context.parentSymbol,
		astPath: parent.astPath,
	};
}

function buildVariableFunctionNodes(node: ASTNode, context: BuildContext, map: ByteIndexMap): CodeStructureNode[] {
	const declarators = nodeChildren(node).filter((child) => VARIABLE_DECLARATOR_TYPES.has(child.type));
	const singleDeclarator = declarators.length === 1;
	const nodes: CodeStructureNode[] = [];
	for (const declarator of declarators) {
		if (!nodeHasFunctionValue(declarator)) continue;
		const name = getName(declarator);
		const spanNode = context.spanNode ?? (singleDeclarator ? node : declarator);
		const structural = createStructureNode(
			declarator,
			"function",
			name,
			{ ...context, spanNode, astPath: [...context.astPath, node.type] },
			map,
		);
		nodes.push(structural);
	}
	return nodes;
}

function buildFieldFunctionNode(
	node: ASTNode,
	context: BuildContext,
	map: ByteIndexMap,
): CodeStructureNode | undefined {
	if (!nodeHasFunctionValue(node)) return undefined;
	const structural = createStructureNode(
		node,
		context.parentSymbol ? "method" : "function",
		getName(node),
		context,
		map,
	);
	return structural;
}

function collectStructureNodes(node: ASTNode, context: BuildContext, map: ByteIndexMap): CodeStructureNode[] {
	if (node.type === "export_statement") {
		const structuralChild = firstStructuralChild(node);
		if (structuralChild) {
			return collectStructureNodes(structuralChild, { ...context, exported: true, spanNode: node }, map);
		}
	}
	if (node.type === "decorated_definition") {
		const structuralChild = firstStructuralChild(node);
		if (structuralChild) {
			return collectStructureNodes(
				structuralChild,
				{
					...context,
					decorators: decoratorsFor(node, context.decorators),
					spanNode: node,
				},
				map,
			);
		}
	}
	if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
		const variableNodes = buildVariableFunctionNodes(node, context, map);
		if (variableNodes.length > 0) return variableNodes;
	}
	if (VARIABLE_DECLARATOR_TYPES.has(node.type) && nodeHasFunctionValue(node)) {
		return [createStructureNode(node, "function", getName(node), context, map)];
	}
	if (FIELD_DEFINITION_TYPES.has(node.type)) {
		const field = buildFieldFunctionNode(node, context, map);
		if (field) return [field];
	}

	const kind = kindForNode(node);
	if (kind) {
		const structural = createStructureNode(node, kind, getName(node), context, map);
		const nested = scanChildren(node, childContext(structural, context), map);
		structural.children.push(
			...nested.filter((child) => child.startByte >= structural.startByte && child.endByte <= structural.endByte),
		);
		return [structural];
	}

	return scanChildren(node, context, map);
}

function scanChildren(node: ASTNode, context: BuildContext, map: ByteIndexMap): CodeStructureNode[] {
	const nodes: CodeStructureNode[] = [];
	for (const child of nodeChildren(node)) {
		if (
			DECLARATION_WRAPPERS.has(child.type) ||
			FIELD_DEFINITION_TYPES.has(child.type) ||
			isStructuralCandidate(child) ||
			child.type.includes("declaration")
		) {
			nodes.push(...collectStructureNodes(child, { ...context, spanNode: undefined }, map));
			continue;
		}
		if (child.type === "class_body" || child.type === "block" || child.type === "declaration_list") {
			nodes.push(...scanChildren(child, context, map));
		}
	}
	return nodes.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
}

function metadataForNode(node: CodeStructureNode): JsonMetadata {
	const symbol = node.name ?? node.kind;
	return {
		language: node.language,
		symbol,
		function_name: symbol,
		symbol_kind: node.kind,
		scope: node.scope,
		parent_symbol: node.parentSymbol ?? null,
		signature: node.signature ?? null,
		exported: node.exported,
		ast_depth: Math.max(0, node.scope.length - 1),
		ast_path: node.astPath.join("/"),
		decorators: node.decorators.length > 0 ? node.decorators : undefined,
		start_line: node.startLine,
		end_line: node.endLine,
	};
}

function makeChunk(
	content: string,
	filePath: string,
	fileType: string,
	startLine: number,
	endLine: number,
	metadata: JsonMetadata,
): Omit<ChunkInsert, "kb_id"> {
	const metadata_json = JSON.stringify(metadata);
	const chunk = {
		content_hash: chunkIdentityHash({ content, filePath, fileType, startLine, endLine, metadataJson: metadata_json }),
		content,
		content_tokenized: "",
		file_path: filePath,
		file_type: fileType,
		start_line: startLine,
		end_line: endLine,
		metadata_json,
	};
	return { ...chunk, content_tokenized: preTokenizeForFTS(buildChunkEmbeddingText(chunk)) };
}

function draftForNode(node: CodeStructureNode, map: ByteIndexMap): ChunkDraft {
	const text = sliceByBytes(map, node.startByte, node.endByte).trim();
	return {
		content: text,
		startLine: node.startLine,
		endLine: node.endLine,
		startByte: node.startByte,
		endByte: node.endByte,
		metadata: metadataForNode(node),
		packable:
			["function", "method", "constructor", "variable"].includes(node.kind) && estimateTokens(text) < AST_TARGET_TOKENS,
		packKey: node.parentSymbol ?? "module",
		symbols: node.name ? [node.name] : [],
	};
}

function fallbackDrafts(node: CodeStructureNode, map: ByteIndexMap): ChunkDraft[] {
	const text = sliceByBytes(map, node.startByte, node.endByte);
	const lines = text.split("\n");
	const drafts: ChunkDraft[] = [];
	let buffer: string[] = [];
	let bufferChars = 0;
	let startLine = node.startLine;
	let part = 1;
	function pushDraft(content: string, draftStartLine: number, draftEndLine: number): void {
		const trimmed = content.trim();
		if (!trimmed) return;
		drafts.push({
			content: trimmed,
			startLine: draftStartLine,
			endLine: draftEndLine,
			startByte: node.startByte,
			endByte: node.endByte,
			metadata: { ...metadataForNode(node), chunk_part: part, start_line: draftStartLine, end_line: draftEndLine },
			packable: false,
			packKey: `${node.parentSymbol ?? "module"}:${node.name ?? node.kind}`,
			symbols: node.name ? [node.name] : [],
		});
		part++;
	}
	function flush(endLine: number): void {
		pushDraft(buffer.join("\n"), startLine, endLine);
		buffer = [];
		bufferChars = 0;
	}
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const absoluteLine = node.startLine + index;
		if (line.length > MAX_AST_FALLBACK_CHARS) {
			if (buffer.length > 0) flush(absoluteLine - 1);
			for (let offset = 0; offset < line.length; offset += MAX_AST_FALLBACK_CHARS) {
				pushDraft(line.slice(offset, offset + MAX_AST_FALLBACK_CHARS), absoluteLine, absoluteLine);
			}
			startLine = absoluteLine + 1;
			continue;
		}
		if (buffer.length > 0 && bufferChars + line.length + 1 > MAX_AST_FALLBACK_CHARS) flush(absoluteLine - 1);
		if (buffer.length === 0) startLine = absoluteLine;
		buffer.push(line);
		bufferChars += line.length + 1;
	}
	if (buffer.length > 0) flush(node.endLine);
	return drafts;
}

function packDrafts(drafts: ChunkDraft[], map: ByteIndexMap): ChunkDraft[] {
	const packed: ChunkDraft[] = [];
	let buffer: ChunkDraft[] = [];
	let bufferTokens = 0;
	function flush(): void {
		if (buffer.length === 0) return;
		if (buffer.length === 1) {
			packed.push(buffer[0]);
		} else {
			const first = buffer[0];
			const last = buffer[buffer.length - 1];
			const symbols = buffer.flatMap((draft) => draft.symbols);
			const content = sliceByBytes(map, first.startByte, last.endByte).trim();
			packed.push({
				content,
				startLine: first.startLine,
				endLine: last.endLine,
				startByte: first.startByte,
				endByte: last.endByte,
				metadata: {
					...first.metadata,
					symbol: symbols.join(", "),
					function_name: symbols[0] ?? first.metadata.function_name,
					symbol_kind: "group",
					symbols,
					signature: null,
					start_line: first.startLine,
					end_line: last.endLine,
				},
				packable: false,
				packKey: first.packKey,
				symbols,
			});
		}
		buffer = [];
		bufferTokens = 0;
	}
	for (const draft of drafts) {
		const tokens = estimateTokens(draft.content);
		const compatible =
			draft.packable &&
			buffer.length > 0 &&
			buffer.every((item) => item.packable && item.packKey === draft.packKey) &&
			bufferTokens + tokens <= AST_TARGET_TOKENS;
		if (!draft.packable) {
			flush();
			packed.push(draft);
			continue;
		}
		if (!compatible && buffer.length > 0) flush();
		buffer.push(draft);
		bufferTokens += tokens;
	}
	flush();
	return packed;
}

function buildDrafts(nodes: CodeStructureNode[], map: ByteIndexMap): ChunkDraft[] {
	const drafts: ChunkDraft[] = [];
	for (const node of nodes.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte)) {
		const text = sliceByBytes(map, node.startByte, node.endByte).trim();
		if (!text) continue;
		if (estimateTokens(text) <= AST_MAX_TOKENS) {
			drafts.push(draftForNode(node, map));
			continue;
		}
		if (node.children.length > 0) {
			drafts.push(...buildDrafts(node.children, map));
			continue;
		}
		drafts.push(...fallbackDrafts(node, map));
	}
	return packDrafts(drafts, map);
}

function symbolKindForNode(node: CodeStructureNode): KnowledgeSymbolInsert["kind"] | undefined {
	if (!node.name) return undefined;
	if (node.kind === "class") return "class";
	if (node.kind === "interface") return "interface";
	if (node.kind === "type") return "type";
	if (node.kind === "variable") return "variable";
	if (node.kind === "function" || node.kind === "method" || node.kind === "constructor") return "function";
	return undefined;
}

function symbolMetadataForNode(node: CodeStructureNode): JsonMetadata {
	return {
		language: node.language,
		symbol_kind: node.kind,
		scope: node.scope,
		parent_symbol: node.parentSymbol ?? null,
		exported: node.exported,
		ast_depth: Math.max(0, node.scope.length - 1),
		ast_path: node.astPath.join("/"),
		decorators: node.decorators.length > 0 ? node.decorators : undefined,
	};
}

function collectSymbols(nodes: CodeStructureNode[], map: ByteIndexMap): KnowledgeSymbolInsert[] {
	const symbols: KnowledgeSymbolInsert[] = [];
	for (const node of nodes) {
		const kind = symbolKindForNode(node);
		if (kind && node.name) {
			const source = sliceByBytes(map, node.startByte, node.endByte).trim();
			symbols.push({
				name: node.name,
				kind,
				file_path: "",
				file_type: node.language,
				start_line: node.startLine,
				end_line: node.endLine,
				container_name: node.parentSymbol ?? null,
				signature: node.signature ?? null,
				text: node.signature ?? source.split("\n")[0]?.trim() ?? node.name,
				metadata_json: JSON.stringify(symbolMetadataForNode(node)),
			});
		}
		symbols.push(...collectSymbols(node.children, map));
	}
	return symbols;
}

function withSymbolLocation(
	symbols: KnowledgeSymbolInsert[],
	filePath: string,
	fileType: string,
): KnowledgeSymbolInsert[] {
	return symbols.map((symbol) => ({ ...symbol, file_path: filePath, file_type: fileType }));
}

function emptyStructure(language: string): CodeStructureNode {
	return {
		kind: "module",
		astType: "program",
		language,
		startLine: 1,
		endLine: 1,
		startByte: 0,
		endByte: 0,
		exported: false,
		decorators: [],
		scope: [],
		astPath: ["program"],
		children: [],
	};
}
async function parseStructure(
	content: string,
	language: string,
): Promise<{ root: CodeStructureNode; map: ByteIndexMap }> {
	const config = LANGS[language];
	if (!config) throw new Error(`Unsupported AST language: ${language}`);
	const Parser = (await import("tree-sitter")).default;
	const grammar = await config.grammar();
	const parser = new Parser();
	parser.setLanguage(grammar as Parameters<typeof parser.setLanguage>[0]);
	const tree = parser.parse(content);
	const rootNode = tree.rootNode as unknown as ASTNode & { hasError?: boolean };
	if (config.fallbackOnParseError && rootNode.hasError) throw new Error(`AST parse failed for ${language}`);
	const map = buildByteIndexMap(content);
	const root: CodeStructureNode = {
		kind: "module",
		astType: rootNode.type,
		language: config.fileType,
		startLine: 1,
		endLine: content.split("\n").length,
		startByte: rootNode.startIndex,
		endByte: rootNode.endIndex,
		exported: false,
		decorators: [],
		scope: [],
		astPath: [rootNode.type],
		children: [],
	};
	root.children.push(
		...scanChildren(
			rootNode,
			{ language: config.fileType, exported: false, decorators: [], scope: [], astPath: [rootNode.type] },
			map,
		),
	);
	return { root, map };
}

export async function parseCodeStructure(content: string, language: string): Promise<CodeStructureNode> {
	return (await parseStructure(content, language)).root;
}

export async function analyzeCodeWithAST(
	content: string,
	filePath: string,
	language: string,
): Promise<CodeAnalysisResult> {
	const config = LANGS[language];
	if (!config) return { chunks: [], symbols: [], structure: emptyStructure(language) };
	const { root, map } = await parseStructure(content, language);
	const drafts = buildDrafts(root.children, map);
	const chunks = drafts.map((draft) =>
		makeChunk(draft.content, filePath, config.fileType, draft.startLine, draft.endLine, draft.metadata),
	);
	const symbols = withSymbolLocation(collectSymbols(root.children, map), filePath, config.fileType);
	return { chunks, symbols, structure: root };
}

export async function chunkWithAST(
	content: string,
	filePath: string,
	language: string,
): Promise<Omit<ChunkInsert, "kb_id">[]> {
	const config = LANGS[language];
	if (!config) return [];
	return (await analyzeCodeWithAST(content, filePath, language)).chunks;
}

export const SUPPORTED_LANGUAGES = new Set(Object.keys(LANGS));
