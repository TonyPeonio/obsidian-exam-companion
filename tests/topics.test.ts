import { describe, expect, it } from "vitest";
import { countWords, extractTopics, topicLink } from "../src/core/topics";
import { lectureVault } from "./fakes";
import { notesInFolder } from "../src/core/vault";

describe("extractTopics", () => {
	it("makes one topic per ## section, titled by the Topic line, with the Summary as quiz text", async () => {
		const vault = lectureVault();
		const notes = notesInFolder(vault, "Courses/CSCI 470");
		const contents = await Promise.all(notes.map(async (n) => ({ path: n.path, content: await vault.read(n.path) })));
		const topics = extractTopics(contents);
		const titles = topics.map((t) => t.title);
		expect(titles).toEqual(["Isolation forests (2026-09-11)", "Gradient boosting (2026-09-18)", "Neural networks (2026-09-25)", "Backpropagation (2026-10-02)", "Cheat sheet"]);
		const gb = topics[1];
		expect(gb.id).toBe("Courses/CSCI 470/2026-09-18.md#2026-09-18");
		expect(gb.heading).toBe("2026-09-18");
		expect(gb.text.startsWith("word0 word1")).toBe(true);
		expect(gb.text).not.toContain("Transcript");
		// Weight counts the whole section (summary + transcript), so longer lectures get more time.
		expect(gb.words).toBeGreaterThan(300);
		expect(topicLink(gb)).toBe("[[Courses/CSCI 470/2026-09-18#2026-09-18]]");
		// A note without ## headings is one topic; an empty note is none.
		const sheet = topics[4];
		expect(sheet.id).toBe("Courses/CSCI 470/Cheat sheet.md");
		expect(sheet.heading).toBeUndefined();
		expect(sheet.text).toMatch(/^Bias–variance/);
		expect(topics.some((t) => t.note.endsWith("Templates.md"))).toBe(false);
		expect(topics.some((t) => t.note.startsWith("Other/"))).toBe(false);
	});

	it("orders dated topics by date and uses the heading as title when there is no Topic line", () => {
		const topics = extractTopics([
			{ path: "C/Notes.md", content: "---\ndate: 2026-09-01\n---\n# Notes\n\n## Vectors\n\nsome words here\n\n## Matrices\n\nmore words here\n" },
			{ path: "C/2026-08-20.md", content: "## 2026-08-20\n\njust a dated section without a topic line\n" },
		]);
		expect(topics.map((t) => t.title)).toEqual(["2026-08-20 2026-08-20", "Vectors", "Matrices"]);
		expect(topics[1].date).toBe("2026-09-01");
	});

	it("treats a Lecture Companion lecture note (Slides/Summary/Transcript/My notes) as one topic", () => {
		const note = (date: string, title: string | null, summary: string) =>
			`---\ncourse: "CSCI 470"\ndate: ${date}\ntags:\n  - lecture\n${title ? `title: "${title}"\n` : ""}---\n\n## Slides\n\n_No slides yet._\n\n## Summary\n\n${summary}\n\n## Transcript\n\n**[00:00]** ${"spoken word ".repeat(40)}\n\n**[01:10]** more speech here\n\n## My notes\n\n- ask about the exam\n`;
		const topics = extractTopics([
			{ path: "Courses/CSCI 470/2026-09-11.md", content: note("2026-09-11", "Isolation forests", "### In one sentence\nHow random splits isolate anomalies. [01:10]\n\n### Questions to review\n- Why are anomalies isolated quickly?") },
			{ path: "Courses/CSCI 470/2026-09-18.md", content: note("2026-09-18", null, "### Key points\n- Boosting adds trees one at a time. [02:05]") },
			{ path: "Courses/CSCI 470/2026-09-25.md", content: note("2026-09-25", "Empty lecture", "_No summary yet._") },
		]);
		expect(topics.map((t) => [t.id, t.title, t.heading])).toEqual([
			["Courses/CSCI 470/2026-09-11.md", "Isolation forests (2026-09-11)", undefined],
			["Courses/CSCI 470/2026-09-18.md", "2026-09-18", undefined],
			["Courses/CSCI 470/2026-09-25.md", "Empty lecture (2026-09-25)", undefined],
		]);
		// Quiz text is the Summary only; the weight counts the whole note.
		expect(topics[0].text).toBe("### In one sentence\nHow random splits isolate anomalies. [01:10]\n\n### Questions to review\n- Why are anomalies isolated quickly?");
		expect(topics[0].text).not.toContain("spoken word");
		expect(topics[0].words).toBeGreaterThan(80);
		expect(topics[0].date).toBe("2026-09-11");
		expect(topicLink(topics[0])).toBe("[[Courses/CSCI 470/2026-09-11]]");
		// No summary yet: the transcript and notes stand in as quiz text.
		expect(topics[2].text).toContain("spoken word");
		expect(topics[2].text).toContain("ask about the exam");
		expect(topics[2].text).not.toContain("_No summary yet._");
	});

	it("ignores headings inside code fences and counts words sensibly", () => {
		const topics = extractTopics([{ path: "C/Code.md", content: "## Real\n\n```\n## not a heading\n```\n\nfour real words here\n" }]);
		expect(topics).toHaveLength(1);
		expect(topics[0].heading).toBe("Real");
		expect(countWords("one, two — three! 4")).toBe(4);
		expect(countWords("— … !!!")).toBe(0);
	});
});
