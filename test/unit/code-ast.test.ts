import { describe, expect, it } from "vitest";
import { analyzeIndexableContent, buildChunkEmbeddingText } from "../../src/indexer/chunker.ts";
import { analyzeCodeWithAST, chunkWithAST, parseCodeStructure } from "../../src/indexer/chunkers/code-ast.ts";

function metadata(chunk: { metadata_json: string }) {
	return JSON.parse(chunk.metadata_json) as Record<string, unknown>;
}

describe("AST code analysis", () => {
	it("uses chunk identity that includes file path and line metadata", async () => {
		const code = "export function same(): number { return 1; }";
		const [first] = await chunkWithAST(code, "src/a.ts", "typescript");
		const [second] = await chunkWithAST(code, "src/b.ts", "typescript");
		const [shifted] = await chunkWithAST(`\n${code}`, "src/a.ts", "typescript");

		expect(first.content).toBe(second.content);
		expect(first.content_hash).not.toBe(second.content_hash);
		expect(first.content).toBe(shifted.content);
		expect(metadata(shifted).start_line).toBe(2);
		expect(first.content_hash).not.toBe(shifted.content_hash);
	});

	it("keeps a small class coherent while retaining method symbols", async () => {
		const code = [
			"export class AuthenticationService {",
			"  authenticate(): boolean { return true; }",
			"  refreshToken(): string { return 'token'; }",
			"}",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/auth.ts", "typescript");
		const chunkMetadata = metadata(analysis.chunks[0]);

		expect(analysis.chunks).toHaveLength(1);
		expect(chunkMetadata.symbol).toBe("AuthenticationService");
		expect(chunkMetadata.symbol_kind).toBe("class");
		expect(analysis.symbols.map((symbol) => symbol.name)).toEqual([
			"AuthenticationService",
			"authenticate",
			"refreshToken",
		]);
		expect(analysis.symbols.find((symbol) => symbol.name === "refreshToken")?.container_name).toBe(
			"AuthenticationService",
		);
	});

	it("recursively splits oversized classes, packs small siblings, and bounds oversized leaves", async () => {
		const hugeBody = `return "${"x".repeat(7_000)}";`;
		const code = [
			"class LargeService {",
			`  hugeMethod(): string { ${hugeBody} }`,
			"  methodA(): number { return 1; }",
			"  methodB(): number { return 2; }",
			"  methodC(): number { return 3; }",
			"}",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/large.ts", "typescript");
		const allMetadata = analysis.chunks.map(metadata);

		expect(allMetadata.some((item) => item.symbol_kind === "class")).toBe(false);
		expect(allMetadata.filter((item) => item.symbol === "hugeMethod")).toHaveLength(2);
		expect(analysis.chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
		expect(allMetadata.some((item) => item.symbol_kind === "group" && Array.isArray(item.symbols))).toBe(true);
	});

	it("normalizes exported arrows, decorators, and class field methods", async () => {
		const code = [
			"@sealed",
			"export class DecoratedService {",
			"  run = async () => 'ok';",
			"}",
			"export const runUpdate = async () => 1;",
		].join("\n");

		const structure = await parseCodeStructure(code, "typescript");
		const analysis = await analyzeCodeWithAST(code, "src/decorated.ts", "typescript");
		const names = analysis.symbols.map((symbol) => symbol.name);
		const classNode = structure.children.find((node) => node.name === "DecoratedService");

		expect(names).toContain("DecoratedService");
		expect(names).toContain("run");
		expect(names).toContain("runUpdate");
		expect(classNode?.exported).toBe(true);
		expect(classNode?.decorators).toEqual(["@sealed"]);
		expect(analysis.chunks.some((chunk) => metadata(chunk).symbol === "runUpdate")).toBe(true);
	});

	it("adds structural context to embedding text without changing returned content", async () => {
		const code = "class Auth { refreshToken(token: string): string { return token; } }";
		const analysis = await analyzeCodeWithAST(code, "src/auth.ts", "typescript");
		const chunk = analysis.chunks[0];
		const embeddingText = buildChunkEmbeddingText(chunk);

		expect(chunk.content).toBe(code);
		expect(embeddingText).toContain("Language: typescript");
		expect(embeddingText).toContain("Scope: Auth");
		expect(embeddingText).toContain("Kind: class");
		expect(embeddingText).toContain("Symbol: Auth");
	});

	it("extracts Bash function chunks and symbols", async () => {
		const code = [
			"build_package() {",
			'  local name="$1"',
			'  if [[ -n "$name" ]]; then',
			'    echo "$name"',
			"  fi",
			"}",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "scripts/build.sh", "bash");
		const chunkMetadata = metadata(analysis.chunks[0]);

		expect(analysis.chunks).toHaveLength(1);
		expect(analysis.chunks[0].content).toBe(code);
		expect(analysis.symbols.map((symbol) => symbol.name)).toContain("build_package");
		expect(chunkMetadata.language).toBe("bash");
		expect(chunkMetadata.symbol).toBe("build_package");
		expect(chunkMetadata.symbol_kind).toBe("function");
		expect(chunkMetadata.signature).toBe("build_package()");
	});

	it("detects .sh files as Bash AST code", async () => {
		const analysis = await analyzeIndexableContent("run_service() { echo ok; }\n", "scripts/service.sh");

		expect(analysis.chunks[0].file_type).toBe("bash");
		expect(metadata(analysis.chunks[0]).language).toBe("bash");
		expect(analysis.symbols.map((symbol) => symbol.name)).toContain("run_service");
	});

	it("supports Bash function keyword declarations", async () => {
		const code = [
			"function deploy {",
			"  source ./env.sh",
			"  for target in prod; do",
			'    echo "$target"',
			"  done",
			"}",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "scripts/deploy.bash", "bash");

		expect(analysis.symbols.map((symbol) => symbol.name)).toContain("deploy");
		expect(metadata(analysis.chunks[0]).symbol).toBe("deploy");
	});

	it("bounds oversized Bash function fallback chunks", async () => {
		const code = ["build_package() {", `  echo "${"x".repeat(7_000)}"`, "}"].join("\n");
		const analysis = await analyzeCodeWithAST(code, "scripts/build.sh", "bash");
		const allMetadata = analysis.chunks.map(metadata);

		expect(analysis.chunks.length).toBeGreaterThan(1);
		expect(analysis.chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
		expect(allMetadata.every((item) => item.symbol === "build_package")).toBe(true);
		expect(allMetadata.some((item) => item.chunk_part === 1)).toBe(true);
	});

	it("falls back to text chunks for malformed Bash", async () => {
		const code = 'broken() {\n  if [[ -n "$name" ]]; then\n    echo "$name"\n';
		const analysis = await analyzeIndexableContent(code, "scripts/broken.sh");

		expect(analysis.chunks.length).toBeGreaterThan(0);
		expect(analysis.chunks[0].file_type).toBe("bash");
		expect(metadata(analysis.chunks[0]).language).toBeUndefined();
	});

	it("extracts GNU C functions, types, enums, typedefs, and macros", async () => {
		const code = [
			"#define MAX_ITEMS 16",
			"",
			"typedef struct wl_connection {",
			"  int fd;",
			"  unsigned flags;",
			"} wl_connection;",
			"",
			"enum state { STATE_INIT, STATE_READY };",
			"",
			"static int handle_event(struct wl_connection *conn, int event) {",
			"  if (__builtin_expect(event > 0, 1)) {",
			"    return conn->fd + event;",
			"  }",
			"  return -1;",
			"}",
			"",
			"int initialize(struct wl_connection *conn);",
		].join("\n");
		const analysis = await analyzeCodeWithAST(code, "src/protocol.c", "c");
		const names = analysis.symbols.map((symbol) => symbol.name);
		const handleEvent = analysis.symbols.find((symbol) => symbol.name === "handle_event");
		const handleMetadata = handleEvent ? metadata(handleEvent) : {};

		expect(names).toContain("MAX_ITEMS");
		expect(names).toContain("wl_connection");
		expect(names).toContain("state");
		expect(names).toContain("handle_event");
		expect(names).toContain("initialize");
		expect(handleEvent?.kind).toBe("function");
		expect(handleMetadata.static).toBe(true);
		expect(analysis.chunks.some((chunk) => metadata(chunk).language === "c")).toBe(true);
	});

	it("detects .c files while leaving ambiguous .h headers conservative", async () => {
		const cAnalysis = await analyzeIndexableContent("int initialize(void) { return 0; }\n", "src/init.c");
		const headerAnalysis = await analyzeIndexableContent("int initialize(void);\n", "include/init.h");

		expect(cAnalysis.chunks[0].file_type).toBe("c");
		expect(cAnalysis.symbols.map((symbol) => symbol.name)).toContain("initialize");
		expect(headerAnalysis.chunks[0].file_type).toBe("text");
		expect(metadata(headerAnalysis.chunks[0]).language).toBeUndefined();
	});

	it("bounds oversized C function fallback chunks", async () => {
		const code = ["int handle_event(void) {", `  return ${"1 + ".repeat(2_000)}0;`, "}"].join("\n");
		const analysis = await analyzeCodeWithAST(code, "src/protocol.c", "c");
		const allMetadata = analysis.chunks.map(metadata);

		expect(analysis.chunks.length).toBeGreaterThan(1);
		expect(analysis.chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
		expect(allMetadata.every((item) => item.symbol === "handle_event")).toBe(true);
	});

	it("falls back to text chunks for malformed C", async () => {
		const code = "int handle_event(void) {\n  if (\n";
		const analysis = await analyzeIndexableContent(code, "src/broken.c");

		expect(analysis.chunks.length).toBeGreaterThan(0);
		expect(analysis.chunks[0].file_type).toBe("c");
		expect(metadata(analysis.chunks[0]).language).toBeUndefined();
	});

	it("extracts C++ namespaces, classes, methods, templates, enums, and implementations", async () => {
		const code = [
			"namespace App {",
			"class MainWindow {",
			"public:",
			"  MainWindow();",
			"  ~MainWindow();",
			"  void openFile();",
			"};",
			"",
			"enum Mode { Read, Write };",
			"",
			"template <typename T>",
			"T identity(T value) { return value; }",
			"",
			"MainWindow::MainWindow() {}",
			"MainWindow::~MainWindow() {}",
			"void MainWindow::openFile() {}",
			"void handle_event(int event) {}",
			"}",
		].join("\n");
		const analysis = await analyzeCodeWithAST(code, "src/main.cpp", "cpp");
		const names = analysis.symbols.map((symbol) => symbol.name);
		const openFile = analysis.symbols.find((symbol) => symbol.name === "openFile");
		const implementation = analysis.symbols.find((symbol) => symbol.name === "MainWindow::openFile");
		const classChunk = analysis.chunks.find((chunk) => metadata(chunk).symbol === "MainWindow");

		expect(names).toContain("App");
		expect(names).toContain("MainWindow");
		expect(names).toContain("~MainWindow");
		expect(names).toContain("openFile");
		expect(names).toContain("MainWindow::MainWindow");
		expect(names).toContain("MainWindow::~MainWindow");
		expect(names).toContain("MainWindow::openFile");
		expect(names).toContain("Mode");
		expect(names).toContain("identity");
		expect(names).toContain("handle_event");
		expect(metadata(openFile ?? { metadata_json: "{}" }).visibility).toBe("public");
		expect(metadata(implementation ?? { metadata_json: "{}" }).parent_symbol).toBe("MainWindow");
		expect(classChunk).toBeDefined();
		expect(metadata(classChunk ?? { metadata_json: "{}" }).language).toBe("cpp");
	});

	it("detects C++ source and header extensions while keeping .h conservative", async () => {
		const sourceAnalysis = await analyzeIndexableContent("void run_service() {}\n", "src/service.cc");
		const headerAnalysis = await analyzeIndexableContent("class Service { void run(); };\n", "include/service.hpp");
		const ambiguousHeader = await analyzeIndexableContent("void run_service(void);\n", "include/service.h");

		expect(sourceAnalysis.chunks[0].file_type).toBe("cpp");
		expect(sourceAnalysis.symbols.map((symbol) => symbol.name)).toContain("run_service");
		expect(headerAnalysis.chunks[0].file_type).toBe("cpp");
		expect(headerAnalysis.symbols.map((symbol) => symbol.name)).toContain("Service");
		expect(ambiguousHeader.chunks[0].file_type).toBe("text");
	});

	it("recursively splits oversized C++ classes into methods", async () => {
		const code = [
			"class LargeService {",
			"public:",
			`  int hugeMethod() { return ${"1 + ".repeat(2_000)}0; }`,
			"  int smallMethod() { return 1; }",
			"};",
		].join("\n");
		const analysis = await analyzeCodeWithAST(code, "src/large.cpp", "cpp");
		const allMetadata = analysis.chunks.map(metadata);

		expect(allMetadata.some((item) => item.symbol_kind === "class")).toBe(false);
		expect(allMetadata.some((item) => item.symbol === "hugeMethod")).toBe(true);
		expect(allMetadata.some((item) => item.symbol === "smallMethod")).toBe(true);
		expect(analysis.chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
	});

	it("falls back to text chunks for Qt macro C++ parser errors", async () => {
		const code = [
			"class MainWindow : public QWidget {",
			"  Q_OBJECT",
			"public:",
			"  MainWindow();",
			"signals:",
			"  void opened(QString path);",
			"private slots:",
			"  void onWaylandEvent(int event);",
			"};",
		].join("\n");
		const analysis = await analyzeIndexableContent(code, "include/MainWindow.hpp");

		expect(analysis.chunks.length).toBeGreaterThan(0);
		expect(analysis.chunks[0].file_type).toBe("cpp");
		expect(metadata(analysis.chunks[0]).language).toBeUndefined();
	});

	it("extracts QML component hierarchy, properties, signals, handlers, ids, imports, and functions", async () => {
		const code = [
			"import QtQuick 2.15",
			"ApplicationWindow {",
			"  id: root",
			"  property bool sidebarVisible: true",
			"  signal opened(string path)",
			"  ListView {",
			"    id: documentList",
			"    delegate: Item {",
			"      property string title: model.title",
			"      function openDocument(path) {",
			"        root.opened(path)",
			"      }",
			"      onVisibleChanged: console.log(visible)",
			"    }",
			"  }",
			"}",
		].join("\n");
		const analysis = await analyzeCodeWithAST(code, "ui/Main.qml", "qml");
		const names = analysis.symbols.map((symbol) => symbol.name);
		const openDocument = analysis.symbols.find((symbol) => symbol.name === "openDocument");
		const handler = analysis.symbols.find((symbol) => symbol.name === "onVisibleChanged");

		expect(names).toContain("QtQuick");
		expect(names).toContain("ApplicationWindow");
		expect(names).toContain("root");
		expect(names).toContain("sidebarVisible");
		expect(names).toContain("opened");
		expect(names).toContain("ListView");
		expect(names).toContain("documentList");
		expect(names).toContain("delegate");
		expect(names).toContain("Item");
		expect(names).toContain("title");
		expect(names).toContain("openDocument");
		expect(names).toContain("onVisibleChanged");
		expect(metadata(openDocument ?? { metadata_json: "{}" }).parent_symbol).toBe("Item");
		expect(metadata(handler ?? { metadata_json: "{}" }).symbol_kind).toBe("handler");
		expect(metadata(analysis.chunks[0]).language).toBe("qml");
	});

	it("detects .qml files as QML AST code", async () => {
		const analysis = await analyzeIndexableContent("Item { id: root; property string title: 'Demo' }\n", "ui/Item.qml");

		expect(analysis.chunks[0].file_type).toBe("qml");
		expect(analysis.symbols.map((symbol) => symbol.name)).toContain("root");
		expect(analysis.symbols.map((symbol) => symbol.name)).toContain("title");
	});

	it("recursively splits oversized QML components", async () => {
		const code = [
			"ApplicationWindow {",
			"  Item {",
			`    property string hugeText: "${"x".repeat(7_000)}"`,
			"  }",
			"  function openDocument(path) { return path }",
			"}",
		].join("\n");
		const analysis = await analyzeCodeWithAST(code, "ui/Large.qml", "qml");
		const allMetadata = analysis.chunks.map(metadata);

		expect(allMetadata.some((item) => item.symbol === "ApplicationWindow")).toBe(false);
		expect(allMetadata.some((item) => item.symbol === "hugeText")).toBe(true);
		expect(allMetadata.some((item) => item.symbol === "openDocument")).toBe(true);
		expect(analysis.chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
	});

	it("falls back to text chunks for malformed QML", async () => {
		const code = "ApplicationWindow {\n  property bool visible:\n";
		const analysis = await analyzeIndexableContent(code, "ui/Broken.qml");

		expect(analysis.chunks.length).toBeGreaterThan(0);
		expect(analysis.chunks[0].file_type).toBe("qml");
		expect(metadata(analysis.chunks[0]).language).toBeUndefined();
	});

	it("loads the tree-sitter baseline for every supported AST language", async () => {
		const cases = [
			{
				language: "typescript",
				filePath: "src/service.ts",
				code: "export class Service { run(): number { return 1; } }",
				symbols: ["Service", "run"],
			},
			{
				language: "javascript",
				filePath: "src/service.js",
				code: "export class Service { run() { return 1; } }",
				symbols: ["Service", "run"],
			},
			{
				language: "python",
				filePath: "service.py",
				code: "class Service:\n    def run(self):\n        return 1\n",
				symbols: ["Service", "run"],
			},
			{
				language: "go",
				filePath: "service.go",
				code: "package service\nfunc Run() int { return 1 }\n",
				symbols: ["Run"],
			},
			{
				language: "rust",
				filePath: "service.rs",
				code: "pub fn run() -> i32 { 1 }\n",
				symbols: ["run"],
			},
			{
				language: "java",
				filePath: "Service.java",
				code: "class Service { int run() { return 1; } }",
				symbols: ["Service", "run"],
			},
			{
				language: "bash",
				filePath: "scripts/service.sh",
				code: "run_service() { echo ok; }\n",
				symbols: ["run_service"],
			},
			{
				language: "c",
				filePath: "src/service.c",
				code: "int run_service(void) { return 0; }\n",
				symbols: ["run_service"],
			},
			{
				language: "cpp",
				filePath: "src/service.cpp",
				code: "class Service { public: void run() {} };\n",
				symbols: ["Service", "run"],
			},
			{
				language: "qml",
				filePath: "ui/Service.qml",
				code: "Item { id: root; function run() { return 1 } }\n",
				symbols: ["Item", "root", "run"],
			},
		];

		for (const item of cases) {
			const analysis = await analyzeCodeWithAST(item.code, item.filePath, item.language);
			const names = analysis.symbols.map((symbol) => symbol.name);

			expect(analysis.chunks.length, item.language).toBeGreaterThan(0);
			for (const symbol of item.symbols) expect(names, item.language).toContain(symbol);
			expect(metadata(analysis.chunks[0]).language).toBe(item.language);
		}
	});
});
