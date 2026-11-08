import { describe, expect, it } from "vitest";
import { createPlan } from "../src/core/exam";
import { itemsOn, parsePlanNote } from "../src/core/planner";
import { attachTopics, buildQuizUserMessage, flashcards, flashcardsHeader, latestQuiz, mergeFlashcards, parseQuiz, parseQuizSections, quizSystemPrompt, quizTopicsFor, renderQuizSection, weakTopicTitles } from "../src/core/quiz";
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
		expect(parseQuiz("<think>still thinking Q: not real\nA: not real")).toEqual([]);
	});

	it("keeps only the first `max` pairs when the model writes too many", () => {
		const six = Array.from({ length: 6 }, (_, i) => `Q: Question ${i + 1}?\nA: Answer ${i + 1}.`).join("\n\n");
		expect(parseQuiz(six)).toHaveLength(6);
		expect(parseQuiz(six, 5).map((p) => p.question)).toEqual(["Question 1?", "Question 2?", "Question 3?", "Question 4?", "Question 5?"]);
		expect(parseQuiz("Q: Only one?\nA: Yes.", 5)).toHaveLength(1);
	});

	it("reads Q and A on one line", () => {
		expect(parseQuiz("Q: What is X? A: It is Y.\n\nQ: Why Z? A: Because W.")).toEqual([
			{ question: "What is X?", answer: "It is Y." },
			{ question: "Why Z?", answer: "Because W." },
		]);
		expect(parseQuiz("**Q:** What is X? **Answer:** It is Y.")).toEqual([{ question: "What is X?", answer: "It is Y." }]);
	});

	it("accepts every numbering and label style", () => {
		expect(parseQuiz("(1) Q: Explain A.\n(1) A: Because B.\n\n(2) Q: Explain C.\n(2) A: Because D.")).toEqual([
			{ question: "Explain A.", answer: "Because B." },
			{ question: "Explain C.", answer: "Because D." },
		]);
		expect(parseQuiz("#1 Q: Explain A.\nA: B.\n#2 Q: Explain C.\nA: D.")).toEqual([
			{ question: "Explain A.", answer: "B." },
			{ question: "Explain C.", answer: "D." },
		]);
		expect(parseQuiz("Q1. Explain A\nA1. Because B\n\nQ2) Explain C\nA2) Because D")).toEqual([
			{ question: "Explain A", answer: "Because B" },
			{ question: "Explain C", answer: "Because D" },
		]);
		expect(parseQuiz("Q1 — Explain A\nA1 — Because B")).toEqual([{ question: "Explain A", answer: "Because B" }]);
		// Bold around the label, around label and colon, or around the whole line.
		expect(parseQuiz("**Q1**: Explain A.\n**A1**: Because B.\n\n**Question 2:** Compare C.\n**Answer 2:** D wins.\n\n**Q: Explain E.**\n**A: Because F.**")).toEqual([
			{ question: "Explain A.", answer: "Because B." },
			{ question: "Compare C.", answer: "D wins." },
			{ question: "Explain E.", answer: "Because F." },
		]);
		// A label alone on its line, text on the next.
		expect(parseQuiz("**Question 1**\nExplain A.\n**Answer**\nBecause B.")).toEqual([{ question: "Explain A.", answer: "Because B." }]);
		// Numbered questions with no Q label at all.
		expect(parseQuiz("1. Why are anomalies isolated quickly?\nA: Sparse regions.\n2. What does c(n) do?\nAnswer: Normalises.")).toEqual([
			{ question: "Why are anomalies isolated quickly?", answer: "Sparse regions." },
			{ question: "What does c(n) do?", answer: "Normalises." },
		]);
	});

	it("ignores preamble, headings, rules and closing commentary", () => {
		expect(parseQuiz("Here are your questions:\n\n## Isolation forests\n\nQ: Explain A.\nA: Because B.\n\n## Gradient boosting\n\nQ: Explain C.\nA: Because D.\n\n---\nNote: all questions come from the notes.")).toEqual([
			{ question: "Explain A.", answer: "Because B." },
			{ question: "Explain C.", answer: "Because D." },
		]);
		expect(parseQuiz("Q: Explain A.\nA: Because B.\n\nThese questions cover both topics. Good luck!")).toEqual([{ question: "Explain A.", answer: "Because B." }]);
		expect(parseQuiz("Q: Explain A.\nA: Because B.\n\nLet me know if you want more.")).toEqual([{ question: "Explain A.", answer: "Because B." }]);
		// A second paragraph of a real answer is kept.
		expect(parseQuiz("Q: Explain A.\nA: Because B.\n\nAlso because C.")).toEqual([{ question: "Explain A.", answer: "Because B.\nAlso because C." }]);
	});

	it("keeps code, ** and list numbering inside answers verbatim", () => {
		expect(parseQuiz("Q: Write the update.\nA: In NumPy:\n```python\nW = W - lr * d  # 2**3\n\nprint(W)\n```\nThat is it.")).toEqual([
			{ question: "Write the update.", answer: "In NumPy:\n```python\nW = W - lr * d  # 2**3\n\nprint(W)\n```\nThat is it." },
		]);
		expect(parseQuiz("Q: What does `2**3` give?\nA: 8, since ** is the power operator.")).toEqual([{ question: "What does `2**3` give?", answer: "8, since ** is the power operator." }]);
		expect(parseQuiz("Q: List the steps.\nA: Two steps:\n1. Pick a feature.\n2. Split at random.\n\nQ: Why?\nA: Because.")).toEqual([
			{ question: "List the steps.", answer: "Two steps:\n1. Pick a feature.\n2. Split at random." },
			{ question: "Why?", answer: "Because." },
		]);
		// A `Q:` inside a code fence is code, not a new question.
		expect(parseQuiz("Q: Show the format.\nA: Like this:\n```\nQ: sample\nA: sample\n```")).toEqual([{ question: "Show the format.", answer: "Like this:\n```\nQ: sample\nA: sample\n```" }]);
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

	it("writes single-line cards Spaced Repetition reads: tag header, one card per line, :: escaped, re-export adds nothing", () => {
		const header = flashcardsHeader("flashcards", "CSCI 470");
		expect(header).toBe("#flashcards/CSCI-470");
		expect(flashcardsHeader("#decks/", "Maths: Part 2!")).toBe("#decks/Maths-Part-2");
		expect(flashcardsHeader("", "")).toBe("#flashcards");
		const cards = flashcards(renderQuizSection("2026-11-08", questions) + "\n" + renderQuizSection("2026-11-09", [questions[0]]));
		const fresh = mergeFlashcards("", cards, header);
		expect(fresh).toBe("#flashcards/CSCI-470\n\nExplain isolation forests.::Random splits isolate anomalies<br>faster.\n\nWhat does boosting optimise?::The residuals.\n");
		// Every card is one line with exactly one `::`, and no blank line is inside a card.
		const cardLines = fresh.split("\n").filter((l) => l.includes("::"));
		expect(cardLines).toHaveLength(2);
		for (const l of cardLines) expect(l.split("::")).toHaveLength(2);
		// Spaced Repetition has reviewed the first card (scheduling comment on the next line, its default):
		const reviewed = fresh.replace("faster.\n", "faster.\n<!--SR:!2026-11-12,4,270-->\n");
		expect(mergeFlashcards(reviewed, cards, header)).toBe(reviewed);
		// A later quiz adds one card; existing cards and their scheduling survive, the header is not repeated.
		const later = flashcards(renderQuizSection("2026-11-10", attachTopics([{ question: "What is `std::vector`?", answer: "A sequence::container." }], [])));
		expect(later).toEqual(["What is `std&#58;:vector`?::A sequence&#58;:container."]);
		const grown = mergeFlashcards(reviewed, [...cards, ...later], header);
		expect(grown).toBe(reviewed.trimEnd() + "\n\nWhat is `std&#58;:vector`?::A sequence&#58;:container.\n");
		expect(grown.match(/#flashcards/g)).toHaveLength(1);
		expect(mergeFlashcards(grown, [...cards, ...later], header)).toBe(grown);
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
