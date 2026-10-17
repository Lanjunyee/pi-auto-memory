import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

export function registerLifecycleProvider(pi: ExtensionAPI, supportsMidConvoSystemMessages: boolean, requests: Record<string, any>[]) {
  pi.registerProvider("lifecycle-test", {
    baseUrl: "https://never-contact.invalid/v1", apiKey: "synthetic-test-only", api: "lifecycle-test-api",
    models: [{ id: "fake", name: "Lifecycle fake", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
      compat: { supportsMidConvoSystemMessages, supportsMidConvoToolAdditions: supportsMidConvoSystemMessages } }],
    streamSimple: (model, context, options) => streamSimple({ ...model, api: "openai-completions" }, context, {
      ...options, apiKey: "synthetic-test-only", fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        const chunk = { id: "fake-response", object: "chat.completion.chunk", created: 1, model: "fake",
          choices: [{ index: 0, delta: { role: "assistant", content: "normal task completed" }, finish_reason: null }] };
        const stop = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`, {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      },
    }),
  });
}
