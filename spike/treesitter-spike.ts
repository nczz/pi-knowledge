import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type TreeSitterModule = {
	typescript?: unknown;
	default?: { typescript?: unknown };
};

type TreeNode = {
	type: string;
	children: TreeNode[];
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "spike_treesitter",
		label: "Spike: Tree-sitter",
		description: "Test tree-sitter native binding in Pi extension",
		parameters: Type.Object({}),
		async execute() {
			const Parser = (await import("tree-sitter")).default;
			const TS = (await import("tree-sitter-typescript")) as TreeSitterModule;
			const TypeScript = TS.typescript ?? TS.default?.typescript;

			const parser = new Parser();
			parser.setLanguage(TypeScript);

			const code = `export function hello(name: string): string { return "Hello " + name; }\nexport class Greeter { greet(): string { return "hi"; } }`;
			const tree = parser.parse(code);
			const root = tree.rootNode as TreeNode;
			const types = root.children.map((c) => c.type);

			return { content: [{ type: "text", text: `Tree-sitter OK! Node types: ${JSON.stringify(types)}` }] };
		},
	});
}
