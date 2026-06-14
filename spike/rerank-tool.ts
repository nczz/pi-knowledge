import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "spike_rerank",
    label: "Spike Rerank",
    description: "Test cross-encoder reranking",
    parameters: Type.Object({}),
    async execute() {
      const { pipeline, env } = await import("file:///Users/chun/.nvm/versions/node/v24.15.0/lib/node_modules/@huggingface/transformers/dist/transformers.node.mjs");
      env.cacheDir = "/tmp/pi-knowledge-spike-models";
      const classifier = await pipeline("text-classification", "Xenova/ms-marco-MiniLM-L-4-v2");
      const r1 = await classifier({ text: "authentication flow", text_pair: "OAuth token refresh mechanism" });
      const r2 = await classifier({ text: "authentication flow", text_pair: "React useState manages state" });
      await classifier.dispose();
      return { content: [{ type: "text", text: `Relevant: ${JSON.stringify(r1)}\nIrrelevant: ${JSON.stringify(r2)}` }] };
    },
  });
}
