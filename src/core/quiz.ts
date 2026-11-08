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
		"Use only the terms, methods, examples and numbers that appear in the notes. Do not bring in related methods, models, losses or techniques the notes do not name, not even as an aside or a comparison.",
		"Prefer questions that make the student explain, compare, derive or compute over questions that only recall a term. Each question must be about a different point of the notes.",
		"Mix difficulty. Each answer is complete in two to five sentences (or the worked result), with the key terms the notes use. When a question asks for a calculation, the answer gives the steps and the result once, without hedging.",
		`Output exactly ${count} questions in this format and nothing else:`,
		"Q: <question>",
		"A: <answer>",
		"Separate pairs with a blank line. Do not number them, do not add headings, introductions or closing remarks.",
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

/** List numbering or bullet in front of a label: `1. `, `1) `, `(1) `, `#1 `, `- `, `* `. */
const LIST_PREFIX = /^\s*(?:\(?\d+[.):]\)?\s+|#\d+\s+)?(?:[-*+]\s+)?/;
const BOLD = "(?:\\*\\*|__)?";
/** `Q:` / `Q1.` / `**Question 2:**` / `Question` alone on a line; group 1 is the text after the label. */
const Q_LABEL = new RegExp(`^${BOLD}\\s*(?:Q|Question)\\s*#?\\d*\\s*${BOLD}\\s*(?:[:.)—–-]|$)\\s*${BOLD}\\s*(.*)$`, "i");
const A_LABEL = new RegExp(`^${BOLD}\\s*(?:A|Answer)\\s*#?\\d*\\s*${BOLD}\\s*(?:[:.)—–-]|$)\\s*${BOLD}\\s*(.*)$`, "i");
/** `A:` further along a line that started with `Q:` (both on one line). */
const INLINE_A = new RegExp(`^(.*?\\S)\\s+${BOLD}(?:A|Answer)\\s*\\d*\\s*${BOLD}\\s*:\\s*${BOLD}\\s*(.+)$`, "i");
/** A numbered question without a `Q` label: `3. Why does ...?` */
const NUMBERED_QUESTION = /^\(?\d+[.)]\s+(.+\?)\s*$/;
/** A closing remark after the last answer, once a blank line separates it. */
const COMMENTARY = /^(?:these|those|the above|this set|i hope|let me know|note:|good luck|feel free|all (?:\d+|five|three|ten) questions|the questions|happy studying|each (?:question|answer))/i;
const STRUCTURAL = /^(?:#{1,6}\s|(?:-{3,}|\*{3,}|_{3,})\s*$)/;

function stripBold(s: string): string {
	return s.replace(/^(?:\*\*|__)\s*/, "").replace(/\s*(?:\*\*|__)$/, "").trim();
}

/**
 * Parses `Q:`/`A:` pairs from a model reply. Tolerates numbering (`1.`, `1)`, `(1)`, `#1`,
 * bullets), bold labels, "Question"/"Answer", `Q1.`/`Q1)`, a label alone on its line, Q and A
 * on one line, numbered questions without a label, think tags, headings or rules between
 * pairs, and closing commentary. Code fences inside answers are kept verbatim (no `**`
 * stripping, blank lines kept); list numbering inside answers is kept. Models sometimes write
 * one more pair than asked; `max` keeps the first ones.
 */
export function parseQuiz(text: string, max = Infinity): { question: string; answer: string }[] {
	const clean = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "");
	const out: { question: string; answer: string }[] = [];
	const st: { cur: { question: string; answer: string } | null; mode: "q" | "a" | null } = { cur: null, mode: null };
	let inFence = false;
	let paragraphBreak = false;
	const finish = () => {
		if (st.cur?.question) out.push(st.cur);
		st.cur = null;
	};
	const startQuestion = (q: string) => {
		finish();
		const inline = INLINE_A.exec(q);
		if (inline) {
			st.cur = { question: stripBold(inline[1]), answer: stripBold(inline[2]) };
			st.mode = "a";
		} else {
			st.cur = { question: stripBold(q), answer: "" };
			st.mode = "q";
		}
		paragraphBreak = false;
	};
	for (const raw of clean.split(/\r?\n/)) {
		const trimmed = raw.trim();
		if (/^(```|~~~)/.test(trimmed)) {
			inFence = !inFence;
			if (st.cur && st.mode === "a") st.cur.answer += (st.cur.answer ? "\n" : "") + trimmed;
			continue;
		}
		if (inFence) {
			if (st.cur && st.mode === "a") st.cur.answer += "\n" + raw.replace(/\s+$/, "");
			continue;
		}
		const line = trimmed.replace(LIST_PREFIX, "");
		const q = Q_LABEL.exec(line);
		if (q) {
			startQuestion(q[1]);
			continue;
		}
		const a = A_LABEL.exec(line);
		if (a && st.cur) {
			st.cur.answer = stripBold(a[1]);
			st.mode = "a";
			paragraphBreak = false;
			continue;
		}
		if (!trimmed) {
			paragraphBreak = true;
			continue;
		}
		if (STRUCTURAL.test(trimmed)) {
			// A heading or rule between pairs: nothing after it continues the previous answer.
			if (st.mode === "a") finish();
			st.mode = null;
			continue;
		}
		const numbered = NUMBERED_QUESTION.exec(trimmed);
		if (numbered && (st.mode === null || (st.mode === "a" && st.cur?.answer))) {
			startQuestion(numbered[1]);
			continue;
		}
		if (st.mode === "q" && st.cur) st.cur.question += (st.cur.question ? " " : "") + trimmed;
		else if (st.mode === "a" && st.cur) {
			if (paragraphBreak && COMMENTARY.test(trimmed)) {
				finish();
				st.mode = null;
				continue;
			}
			st.cur.answer += (st.cur.answer ? "\n" : "") + trimmed;
		}
		paragraphBreak = false;
	}
	finish();
	return out
		.filter((p) => p.question && p.answer)
		.map((p) => ({ question: p.question.trim(), answer: p.answer.trim() }))
		.slice(0, Math.max(0, max));
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
