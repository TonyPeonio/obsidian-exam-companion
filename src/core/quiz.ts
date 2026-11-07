import { splitSections, type PlanItem } from "./planner";
import type { Topic } from "./topics";

/**
 * Daily quizzes: the prompt that asks a local model for questions on today's topics, a
 * tolerant parser for its reply, the markdown written under `## Quiz YYYY-MM-DD`, reading
 * the ticks back as results, and the flashcard export.
 */

export interface QuizQuestion {
	question: string;
	answer: string;
	/** `[[Note#Heading]]` of the topic the question came from. */
	link: string;
	title: string;
}

export interface QuizTopic {
	title: string;
	text: string;
	link: string;
}

const CHARS_PER_TOKEN = 3.2;
const ANSWER_TOKENS = 1500;

export function quizSystemPrompt(count: number): string {
	return [
		"You write exam-practice questions for a student from the student's own notes.",
		"Ask only what the given notes support; never invent facts, names or numbers that are not in them.",
		"Prefer questions that make the student explain, compare, derive or compute over questions that only recall a term.",
		"Mix difficulty. Each answer is complete in two to five sentences (or the worked result), with the key terms the notes use.",
		`Output exactly ${count} questions in this format and nothing else:`,
		"Q: <question>",
		"A: <answer>",
		"Separate pairs with a blank line. Do not number them, do not add headings or commentary.",
	].join("\n");
}

/** The user message: today's topics with their text, trimmed so everything fits `numCtx`. */
export function buildQuizUserMessage(topics: QuizTopic[], count: number, numCtx: number): { message: string; truncated: boolean } {
	const budget = Math.max(2000, Math.floor(numCtx * CHARS_PER_TOKEN) - ANSWER_TOKENS * Math.ceil(CHARS_PER_TOKEN) - 600);
	const perTopic = Math.max(400, Math.floor(budget / Math.max(1, topics.length)));
	let truncated = false;
	const parts = [`Write ${count} questions covering these ${topics.length === 1 ? "notes" : `${topics.length} topics`} (spread them across the topics).`, ""];
	for (const t of topics) {
		let text = t.text.trim();
		if (text.length > perTopic) {
			text = text.slice(0, perTopic).replace(/\s+\S*$/, "") + "\n(… truncated)";
			truncated = true;
		}
		parts.push(`## ${t.title}`, "", text || "(no text)", "");
	}
	return { message: parts.join("\n").trimEnd(), truncated };
}

/** Parses `Q:`/`A:` pairs; tolerates numbering, bold markers, "Question:"/"Answer:" and think tags. */
export function parseQuiz(text: string): { question: string; answer: string }[] {
	const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "");
	const out: { question: string; answer: string }[] = [];
	let current: { question: string; answer: string } | null = null;
	let mode: "q" | "a" | null = null;
	for (const raw of clean.split(/\r?\n/)) {
		const line = raw
			.replace(/\*\*/g, "")
			.replace(/^\s*(?:\d+[.)]\s+)?(?:[-*]\s+)?/, "")
			.trim();
		const q = /^(?:Q|Question)\s*\d*\s*[:.)]\s*(.*)$/i.exec(line);
		const a = /^(?:A|Answer)\s*\d*\s*[:.)]\s*(.*)$/i.exec(line);
		if (q) {
			if (current?.question) out.push(current);
			current = { question: q[1].trim(), answer: "" };
			mode = "q";
			continue;
		}
		if (a && current) {
			current.answer = a[1].trim();
			mode = "a";
			continue;
		}
		if (!line) continue;
		if (mode === "q" && current) current.question += (current.question ? " " : "") + line;
		else if (mode === "a" && current) current.answer += (current.answer ? "\n" : "") + line;
	}
	if (current?.question) out.push(current);
	return out.filter((p) => p.question && p.answer).map((p) => ({ question: p.question.trim(), answer: p.answer.trim() }));
}

/** Assigns questions to topics round-robin when the model did not say which topic each belongs to. */
export function attachTopics(pairs: { question: string; answer: string }[], topics: QuizTopic[]): QuizQuestion[] {
	return pairs.map((p, i) => {
		const t = topics[i % Math.max(1, topics.length)];
		const byMention = topics.find((x) => x.title && p.question.toLowerCase().includes(x.title.toLowerCase().replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, "")));
		const pick = byMention ?? t;
		return { question: p.question, answer: p.answer, link: pick?.link ?? "", title: pick?.title ?? "" };
	});
}

export function renderQuizSection(date: string, questions: QuizQuestion[]): string {
	const out = [`## Quiz ${date}`, ""];
	for (const q of questions) {
		out.push(`- [ ] ${q.question}`);
		out.push("    > [!answer]- Answer");
		for (const line of q.answer.split("\n")) out.push(`    > ${line}`);
		if (q.link) out.push(`    > Source: ${q.link}`);
		out.push("");
	}
	return out.join("\n").trimEnd() + "\n";
}

export interface QuizResult {
	date: string;
	question: string;
	answer: string;
	link: string;
	correct: boolean;
}

/** Every quiz section's questions with their tick state, oldest first. */
export function parseQuizSections(content: string): QuizResult[] {
	const out: QuizResult[] = [];
	for (const sec of splitSections(content)) {
		const m = /^Quiz (\d{4}-\d{2}-\d{2})$/.exec(sec.heading);
		if (!m) continue;
		let current: QuizResult | null = null;
		for (const line of sec.text.split("\n")) {
			const q = /^- \[( |x|X)\] (.+)$/.exec(line);
			if (q) {
				current = { date: m[1], question: q[2].trim(), answer: "", link: "", correct: q[1] !== " " };
				out.push(current);
				continue;
			}
			const quoted = /^\s+> ?(.*)$/.exec(line);
			if (quoted && current) {
				const body = quoted[1];
				if (/^\[!answer\]/.test(body)) continue;
				const src = /^Source:\s*(\[\[[^\]]+\]\])/.exec(body);
				if (src) current.link = src[1];
				else current.answer += (current.answer ? "\n" : "") + body;
			}
		}
	}
	return out;
}

/** The latest quiz's results. */
export function latestQuiz(content: string): QuizResult[] {
	const all = parseQuizSections(content);
	if (all.length === 0) return [];
	const last = all[all.length - 1].date;
	return all.filter((r) => r.date === last);
}

/** Titles of topics with at least one wrong answer in the latest quiz, resolved through the plan's items. */
export function weakTopicTitles(results: QuizResult[], items: PlanItem[]): string[] {
	const titles = new Set<string>();
	for (const r of results) {
		if (r.correct) continue;
		const item = items.find((i) => i.link === r.link);
		if (item) titles.add(item.title);
	}
	return Array.from(titles);
}

/** `Question::Answer` lines (the Spaced Repetition plugin's single-line format), deduplicated. */
export function flashcards(content: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of parseQuizSections(content)) {
		const key = r.question.toLowerCase();
		if (seen.has(key) || !r.answer) continue;
		seen.add(key);
		const answer = r.answer.split("\n").join("<br>");
		out.push(`${r.question}::${answer}`);
	}
	return out;
}

/** Merges new cards into an existing flashcards note without duplicating questions. */
export function mergeFlashcards(existing: string, cards: string[]): string {
	const have = new Set(
		existing
			.split("\n")
			.map((l) => l.split("::")[0].trim().toLowerCase())
			.filter(Boolean),
	);
	const add = cards.filter((c) => !have.has(c.split("::")[0].trim().toLowerCase()));
	if (add.length === 0) return existing;
	const base = existing.trimEnd();
	return (base ? base + "\n\n" : "") + add.join("\n\n") + "\n";
}

/** Today's quiz topics from today's plan items and the topics' full text. */
export function quizTopicsFor(items: PlanItem[], topics: Topic[]): QuizTopic[] {
	const out: QuizTopic[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (seen.has(item.topicId)) continue;
		seen.add(item.topicId);
		const t = topics.find((x) => x.id === item.topicId);
		out.push({ title: item.title, text: t?.text ?? "", link: item.link });
	}
	return out;
}
