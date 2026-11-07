import { describe, expect, it } from "vitest";
import { OllamaClient, explainOllamaError, ndjson } from "../src/core/ollama";

function streamOf(lines: object[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
	return new ReadableStream({
		start(controller) {
			controller.enqueue(enc.encode(text.slice(0, 9)));
			controller.enqueue(enc.encode(text.slice(9)));
			controller.close();
		},
	});
}

const fakeFetch = (handler: (url: string, init?: RequestInit) => Response) => ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as typeof fetch;

describe("OllamaClient", () => {
	it("streams chat content and lists models", async () => {
		let body = "";
		const client = new OllamaClient(
			() => "http://x/",
			fakeFetch((url, init) => {
				if (url.endsWith("/api/chat")) {
					body = String(init?.body);
					return new Response(streamOf([{ message: { content: "Q: a" } }, { message: { content: "\nA: b" } }, { done: true }]));
				}
				if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen3.5:9b", size: 1, capabilities: ["tools"] }] }));
				return new Response("{}", { status: 404 });
			}),
		);
		const deltas: string[] = [];
		const text = await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }], think: false, options: { num_ctx: 8192 }, onDelta: (d) => deltas.push(d) });
		expect(text).toBe("Q: a\nA: b");
		expect(deltas).toEqual(["Q: a", "\nA: b"]);
		expect(JSON.parse(body)).toMatchObject({ model: "m", stream: true, think: false, options: { num_ctx: 8192 } });
		expect(await client.listModels()).toEqual([{ name: "qwen3.5:9b", size: 1, capabilities: ["tools"] }]);
	});

	it("falls back to the non-streaming poster and explains errors", async () => {
		const client = new OllamaClient(
			() => "http://x",
			fakeFetch(() => {
				throw new TypeError("Failed to fetch");
			}),
			async () => ({ status: 200, text: JSON.stringify({ message: { content: "Q: a\nA: b" } }) }),
		);
		expect(await client.chat({ model: "m", messages: [] })).toBe("Q: a\nA: b");
		const down = new OllamaClient(
			() => "http://x",
			fakeFetch(() => {
				throw new TypeError("Failed to fetch");
			}),
		);
		await expect(down.chat({ model: "m", messages: [] })).rejects.toThrow(/Cannot reach Ollama/);
		expect(explainOllamaError(new Error('model "qwen3.5:9b" not found, try pulling it first'), "qwen3.5:9b", "http://x")).toMatch(/ollama pull qwen3.5:9b/);
		expect(explainOllamaError(new Error("Cannot reach Ollama at http://x"), "m", "http://x")).toMatch(/Start Ollama/);
	});

	it("parses ndjson across chunk boundaries", async () => {
		const out = [];
		for await (const o of ndjson(streamOf([{ a: 1 }, { b: 2 }]))) out.push(o);
		expect(out).toEqual([{ a: 1 }, { b: 2 }]);
	});
});
