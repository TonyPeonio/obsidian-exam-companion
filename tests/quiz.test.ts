import { describe, expect, it } from "vitest";
import { createPlan } from "../src/core/exam";
import { itemsOn, parsePlanNote } from "../src/core/planner";
import { attachTopics, buildQuizUserMessage, flashcards, latestQuiz, mergeFlashcards, parseQuiz, parseQuizSections, quizSystemPrompt, quizTopicsFor, renderQuizSection, weakTopicTitles } from "../src/core/quiz";
import { lectureVault } from "./fakes";

describe("parseQuiz", () => {
	it("reads clean Q:/A: pairs", () => {
		expect(parseQuiz("Q: What is X?\nA: X is Y.\n\nQ: Why Z?\nA: Because W.\nSecond line.")).toEqual([
			{ question: "What is X?", answer: "X is Y." },
			{ question: "Why Z?", answer: "Because W.\nSecond line." },
		]);
	});
	it("tolerates numbering, bold, Question/Answer labels, think tags and preamble", () => {
		const text = "<think>plan</think>Here are your questions:\n\n1. **Q1:** Explain A\n   and B.\n   **A1:** Because C.\n\n2) Question: Compare D and E.\nAnswer: D is faster; E is simpler.\n- Q: Compute F for n=3\n- A: 9";
		expect(parseQuiz(text)).toEqual([
			{ question: "Explain A and B.", answer: "Because C." },
			{ question: "Compare D and E.", answer: "D is faster; E is simpler." },
			{ question: "Compute F for n=3", answer: "9" },
		]);
	});
	it("drops pairs without an answer", () => {
		expect(parseQuiz("Q: Lonely question\n\nQ: Full\nA: yes")).toEqual([{ question: "Full", answer: "yes" }]);
		expect(parseQuiz("no questions here")).toEqual([]);
	});
});

describe("quiz prompt", () => {
	it("budgets topic text to the context window and says how many questions", () => {
		const long = { title: "Big", text: "x ".repeat(50_000), link: "[[B]]" };
		const small = { title: "Small", text: "short", link: "[[S]]" };
		const { message, truncated } = buildQuizUserMessage([long, small], 5, 4096);
		expect(truncated).toBe(true);
		expect(message.length).toBeLessThan(4096 * 3.2);
		expect(message).toContain("## Big");
		expect(message).toContain("(… truncated)");
		expect(message).toContain("## Small\n\nshort");
		expect(message.startsWith("Write 5 questions covering these 2 topics")).toBe(true);
		expect(quizSystemPrompt(5)).toContain("Output exactly 5 questions");
		expect(buildQuizUserMessage([small], 3, 16384).truncated).toBe(false);
	});
});

describe("quiz section", () => {
	const questions = attachTopics(
		[
			{ question: "Explain isolation forests.", answer: "Random splits isolate anomalies\nfaster." },
			{ question: "What does boosting optimise?", answer: "The residuals." },
		],
		[
			{ title: "Isolation forests (2026-09-11)", text: "", link: "[[Courses/CSCI 470/2026-09-11#2026-09-11]]" },
			{ title: "Gradient boosting (2026-09-18)", text: "", link: "[[Courses/CSCI 470/2026-09-18#2026-09-18]]" },
		],
	);

	it("attaches topics by mention, else round-robin", () => {
		expect(questions[0].link).toBe("[[Courses/CSCI 470/2026-09-11#2026-09-11]]");
		expect(questions[1].link).toBe("[[Courses/CSCI 470/2026-09-18#2026-09-18]]");
	});

	it("renders checkboxes with collapsed answer callouts and parses them back with tick state", () => {
		const md = renderQuizSection("2026-11-08", questions);
		expect(md).toBe(
			"## Quiz 2026-11-08\n\n- [ ] Explain isolation forests.\n    > [!answer]- Answer\n    > Random splits isolate anomalies\n    > faster.\n    > Source: [[Courses/CSCI 470/2026-09-11#2026-09-11]]\n\n- [ ] What does boosting optimise?\n    > [!answer]- Answer\n    > The residuals.\n    > Source: [[Courses/CSCI 470/2026-09-18#2026-09-18]]\n",
		);
		const note = "---\nexam: X\ndate: 2026-12-01\n---\n# X\n\n## Plan\n\n## Topics\n\n" + md.replace("- [ ] Explain", "- [x] Explain") + "\n## Quiz 2026-11-09\n\n- [ ] Later question\n    > [!answer]- Answer\n    > later\n    > Source: [[A#B]]\n";
		const all = parseQuizSections(note);
		expect(all).toHaveLength(3);
		expect(all[0]).toEqual({ date: "2026-11-08", question: "Explain isolation forests.", answer: "Random splits isolate anomalies\nfaster.", link: "[[Courses/CSCI 470/2026-09-11#2026-09-11]]", correct: true });
		expect(all[1].correct).toBe(false);
		expect(latestQuiz(note).map((r) => r.question)).toEqual(["Later question"]);
	});

	it("names weak topics from wrong answers and exports deduplicated flashcards", () => {
		const items = [
			{ topicId: "a", title: "Isolation forests (2026-09-11)", minutes: 10, kind: "learn" as const, link: "[[Courses/CSCI 470/2026-09-11#2026-09-11]]", done: false },
			{ topicId: "b", title: "Gradient boosting (2026-09-18)", minutes: 10, kind: "learn" as const, link: "[[Courses/CSCI 470/2026-09-18#2026-09-18]]", done: false },
		];
		const results = parseQuizSections("## Quiz 2026-11-08\n\n" + renderQuizSection("2026-11-08", questions).split("\n").slice(2).join("\n").replace("- [ ] What", "- [x] What"));
		expect(weakTopicTitles(results, items)).toEqual(["Isolation forests (2026-09-11)"]);
		const cards = flashcards(renderQuizSection("2026-11-08", questions) + "\n" + renderQuizSection("2026-11-09", [questions[0]]));
		expect(cards).toEqual(["Explain isolation forests.::Random splits isolate anomalies<br>faster.", "What does boosting optimise?::The residuals."]);
		const merged = mergeFlashcards("Explain isolation forests.::old answer\n", cards);
		expect(merged).toBe("Explain isolation forests.::old answer\n\nWhat does boosting optimise?::The residuals.\n");
		expect(mergeFlashcards(merged, cards)).toBe(merged);
	});

	it("builds today's quiz topics from the plan items with the topics' text", async () => {
		const vault = lectureVault();
		const { plan, content } = await createPlan(vault, { courseFolder: "Courses/CSCI 470", exam: "Midterm", examDate: "2026-11-22", startDate: "2026-11-08", minutesPerDay: 45 });
		const items = itemsOn(parsePlanNote(content), "2026-11-08");
		const qt = quizTopicsFor(items, plan.topics);
		expect(qt.length).toBeGreaterThan(0);
		expect(qt[0].title).toBe("Isolation forests (2026-09-11)");
		expect(qt[0].text.startsWith("word0")).toBe(true);
		expect(qt[0].link).toBe("[[Courses/CSCI 470/2026-09-11#2026-09-11]]");
	});
});
