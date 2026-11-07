import { addDays, daysBetween, dateRange, weekday } from "./dates";
import { parseFrontmatter, renderFrontmatter, type FrontmatterValue } from "./frontmatter";
import { topicLink, type Topic } from "./topics";

/**
 * The study plan: deterministic scheduling of topics over the days before an exam, the plan
 * note's markdown, and parsing it back so the plan can be rebuilt from today onward.
 */

export type ItemKind = "learn" | "review" | "final";

export interface PlanItem {
	topicId: string;
	title: string;
	minutes: number;
	kind: ItemKind;
	/** `[[Note#Heading]]` */
	link: string;
	done: boolean;
}

export interface PlanDay {
	date: string;
	items: PlanItem[];
}

export interface PlanMeta {
	exam: string;
	course: string;
	courseFolder: string;
	/** Exam date, YYYY-MM-DD. */
	date: string;
	startDate: string;
	minutesPerDay: number;
	weakTopics: string[];
}

export interface Plan {
	meta: PlanMeta;
	days: PlanDay[];
	topics: Topic[];
}

export const MIN_SLOT = 10;
export const REVIEW_GAP = [3, 4, 5];
export const FINAL_DAYS = 2;

export class PlanError extends Error {}

interface Budget {
	date: string;
	left: number;
	items: PlanItem[];
}

function minutesFor(topic: Topic, totalWords: number, budget: number, cap: number): number {
	const share = totalWords > 0 ? topic.words / totalWords : 1;
	return Math.max(MIN_SLOT, Math.min(cap, Math.round(share * budget)));
}

/** Puts `item` on the first day from `fromIndex` with room, else the least loaded one in range. */
function place(days: Budget[], fromIndex: number, toIndex: number, item: PlanItem): void {
	const lo = Math.max(0, Math.min(fromIndex, days.length - 1));
	const hi = Math.max(lo, Math.min(toIndex, days.length - 1));
	for (let i = lo; i <= hi; i++) {
		if (days[i].left >= item.minutes) {
			days[i].items.push(item);
			days[i].left -= item.minutes;
			return;
		}
	}
	let best = lo;
	for (let i = lo; i <= hi; i++) if (days[i].left > days[best].left) best = i;
	days[best].items.push(item);
	days[best].left -= item.minutes;
}

export interface ScheduleOptions {
	/** Topics already covered in a first pass (their learn slot is in the past). */
	learned?: Set<string>;
	/** Topics whose review already happened. */
	reviewed?: Set<string>;
	weakTopics?: string[];
}

/**
 * Schedules `topics` over the days from `start` to the day before `examDate`. Every topic
 * gets a first pass and a review 3–5 days later; the last two days are mixed review of the
 * weakest and heaviest topics. Deterministic.
 */
export function buildSchedule(topics: Topic[], start: string, examDate: string, minutesPerDay: number, opts: ScheduleOptions = {}): PlanDay[] {
	const dates = dateRange(start, addDays(examDate, -1));
	if (dates.length === 0) throw new PlanError("The exam date must be after the start date.");
	if (topics.length === 0) throw new PlanError("No topics found: the course folder has no notes with content.");
	const cap = Math.max(MIN_SLOT, minutesPerDay);
	const days: Budget[] = dates.map((date) => ({ date, left: cap, items: [] }));
	const finalCount = dates.length >= 4 ? FINAL_DAYS : dates.length >= 2 ? 1 : 0;
	const studyDays = days.slice(0, days.length - finalCount);
	const finalDays = days.slice(days.length - finalCount);
	const learned = opts.learned ?? new Set<string>();
	const reviewed = opts.reviewed ?? new Set<string>();
	const weak = new Set(opts.weakTopics ?? []);

	const toLearn = topics.filter((t) => !learned.has(t.id));
	const totalWords = toLearn.reduce((n, t) => n + t.words, 0);
	// Half the study time goes to first passes, the rest to reviews and slack.
	const learnBudget = Math.max(studyDays.length, 1) * cap * 0.5;
	const learnedOn = new Map<string, number>();
	let cursor = 0;
	for (const t of toLearn) {
		const minutes = minutesFor(t, totalWords, learnBudget, cap);
		const item: PlanItem = { topicId: t.id, title: t.title, minutes, kind: "learn", link: topicLink(t), done: false };
		const target = studyDays.length ? studyDays : days;
		// Fill days in order; a topic that does not fit moves to the next day.
		while (cursor < target.length - 1 && target[cursor].left < minutes && target[cursor].items.length > 0) cursor++;
		target[cursor].items.push(item);
		target[cursor].left -= minutes;
		learnedOn.set(t.id, cursor);
	}
	// Reviews: 3–5 days after the first pass; topics learned before this plan get one early.
	for (const t of topics) {
		if (reviewed.has(t.id)) continue;
		const base = learnedOn.get(t.id);
		const minutes = Math.max(MIN_SLOT, Math.round(minutesFor(t, totalWords || t.words, learnBudget, cap) / 2));
		const item: PlanItem = { topicId: t.id, title: t.title, minutes, kind: "review", link: topicLink(t), done: false };
		const target = studyDays.length ? studyDays : days;
		if (base === undefined) place(target, 0, Math.min(2, target.length - 1), item);
		else if (base + REVIEW_GAP[0] <= target.length - 1) place(target, base + REVIEW_GAP[0], base + REVIEW_GAP[2], item);
		else if (finalDays.length) place(finalDays, 0, finalDays.length - 1, item);
		else place(target, base, target.length - 1, item);
	}
	// Weak topics get one more review as soon as there is room.
	for (const t of topics) {
		if (!weak.has(t.id) && !weak.has(t.title)) continue;
		const minutes = Math.max(MIN_SLOT, Math.round(minutesFor(t, totalWords || t.words, learnBudget, cap) / 2));
		const item: PlanItem = { topicId: t.id, title: `${t.title}`, minutes, kind: "review", link: topicLink(t), done: false };
		const target = studyDays.length ? studyDays : days;
		place(target, 0, target.length - 1, item);
	}
	// Final days: mixed review, weakest then heaviest first.
	if (finalDays.length) {
		const ranked = topics.slice().sort((a, b) => {
			const wa = weak.has(a.id) || weak.has(a.title) ? 1 : 0;
			const wb = weak.has(b.id) || weak.has(b.title) ? 1 : 0;
			return wb - wa || b.words - a.words || a.title.localeCompare(b.title);
		});
		const perDay = Math.max(1, Math.min(ranked.length, Math.floor(cap / MIN_SLOT)));
		for (let d = 0; d < finalDays.length; d++) {
			const picks: Topic[] = [];
			for (let k = 0; k < perDay; k++) picks.push(ranked[(d * perDay + k) % ranked.length]);
			const unique = picks.filter((t, i) => picks.findIndex((x) => x.id === t.id) === i);
			const minutes = Math.max(MIN_SLOT, Math.floor(cap / unique.length));
			for (const t of unique) finalDays[d].items.push({ topicId: t.id, title: t.title, minutes, kind: "final", link: topicLink(t), done: false });
		}
	}
	return days.map((d) => ({ date: d.date, items: d.items }));
}

const KIND_PREFIX: Record<ItemKind, string> = { learn: "", review: "Review: ", final: "Final review: " };

export function renderItem(item: PlanItem): string {
	return `- [${item.done ? "x" : " "}] ${KIND_PREFIX[item.kind]}${item.title} — ${item.minutes} min — ${item.link}`;
}

export function renderDays(days: PlanDay[]): string {
	const out: string[] = [];
	for (const day of days) {
		out.push(`### ${day.date} (${weekday(day.date)})`, "");
		if (day.items.length === 0) out.push("- Rest day", "");
		else {
			for (const item of day.items) out.push(renderItem(item));
			out.push("");
		}
	}
	return out.join("\n").trimEnd() + "\n";
}

export function renderPlanNote(plan: Plan): string {
	const fm: Record<string, FrontmatterValue> = {
		exam: plan.meta.exam,
		course: plan.meta.course,
		course_folder: plan.meta.courseFolder,
		date: plan.meta.date,
		start_date: plan.meta.startDate,
		minutes_per_day: String(plan.meta.minutesPerDay),
		weak_topics: plan.meta.weakTopics,
	};
	const total = plan.days.reduce((n, d) => n + d.items.reduce((m, i) => m + i.minutes, 0), 0);
	const lines = [
		renderFrontmatter(fm).trimEnd(),
		`# ${plan.meta.course} – ${plan.meta.exam}`,
		"",
		`Exam on ${plan.meta.date} (${weekday(plan.meta.date)}). ${plan.topics.length} topics over ${plan.days.length} days, about ${Math.round(total / Math.max(1, plan.days.length))} minutes a day. Tick items as you go; run *Today's quiz* for questions on today's topics and *Record quiz results* to add weak topics to the plan.`,
		"",
		"## Plan",
		"",
		renderDays(plan.days).trimEnd(),
		"",
		"## Topics",
		"",
		...plan.topics.map((t) => `- ${t.title} (${t.words} words) — ${topicLink(t)}`),
		"",
	];
	return lines.join("\n");
}

const ITEM_RE = /^- \[( |x|X)\] (Final review: |Review: )?(.+?) — (\d+) min — (\[\[[^\]]+\]\])\s*$/;
const TOPIC_RE = /^- (.+?) \((\d+) words\) — (\[\[[^\]]+\]\])\s*$/;

/** The topic id a link denotes: the path with `.md` plus `#heading`. */
export function topicIdFromLink(link: string): string {
	const inner = link.replace(/^\[\[|\]\]$/g, "");
	const [path, heading] = inner.split("#");
	const withExt = /\.md$/i.test(path) ? path : `${path}.md`;
	return heading ? `${withExt}#${heading}` : withExt;
}

/** Splits a body into `## ` sections, keeping text before the first heading under "". */
export function splitSections(body: string): { heading: string; text: string }[] {
	const out: { heading: string; text: string }[] = [];
	let heading = "";
	let lines: string[] = [];
	let inFence = false;
	for (const line of body.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		const m = !inFence && /^## (.+?)\s*$/.exec(line);
		if (m) {
			out.push({ heading, text: lines.join("\n") });
			heading = m[1];
			lines = [];
			continue;
		}
		lines.push(line);
	}
	out.push({ heading, text: lines.join("\n") });
	return out;
}

export function parsePlanNote(content: string): Plan {
	const fm = parseFrontmatter(content);
	const str = (k: string) => {
		const v = fm.data[k];
		return typeof v === "string" ? v : "";
	};
	const list = (k: string) => {
		const v = fm.data[k];
		return Array.isArray(v) ? v : [];
	};
	if (!str("date") || !str("exam")) throw new PlanError("This note is not an Exam Companion plan (no exam/date in its frontmatter).");
	const secs = splitSections(fm.body);
	const planSec = secs.find((s) => s.heading === "Plan");
	const topicsSec = secs.find((s) => s.heading === "Topics");
	const days: PlanDay[] = [];
	let day: PlanDay | null = null;
	for (const line of (planSec?.text ?? "").split("\n")) {
		const d = /^### (\d{4}-\d{2}-\d{2})/.exec(line);
		if (d) {
			day = { date: d[1], items: [] };
			days.push(day);
			continue;
		}
		const it = ITEM_RE.exec(line);
		if (it && day) {
			const kind: ItemKind = it[2] === "Final review: " ? "final" : it[2] === "Review: " ? "review" : "learn";
			day.items.push({ done: it[1] !== " ", kind, title: it[3], minutes: Number(it[4]), link: it[5], topicId: topicIdFromLink(it[5]) });
		}
	}
	const topics: Topic[] = [];
	for (const line of (topicsSec?.text ?? "").split("\n")) {
		const m = TOPIC_RE.exec(line);
		if (!m) continue;
		const id = topicIdFromLink(m[3]);
		const [note, heading] = id.split("#");
		topics.push({ id, title: m[1], note, heading, text: "", words: Number(m[2]) });
	}
	return {
		meta: {
			exam: str("exam"),
			course: str("course"),
			courseFolder: str("course_folder"),
			date: str("date"),
			startDate: str("start_date") || days[0]?.date || str("date"),
			minutesPerDay: Number(str("minutes_per_day")) || 45,
			weakTopics: list("weak_topics"),
		},
		days,
		topics,
	};
}

/**
 * Rebuilds the plan from `todayDate` onward: days before today are kept as written (ticks
 * included); what was learned or reviewed on those days is not scheduled again; weak topics
 * get an extra review. Everything after `## Plan` in the note is left untouched.
 */
export function rebuildPlan(content: string, todayDate: string): string {
	const plan = parsePlanNote(content);
	if (daysBetween(todayDate, plan.meta.date) <= 0) return content;
	const past = plan.days.filter((d) => d.date < todayDate);
	const learned = new Set<string>();
	const reviewed = new Set<string>();
	for (const d of past) {
		for (const i of d.items) {
			if (i.kind === "learn") learned.add(i.topicId);
			else reviewed.add(i.topicId);
		}
	}
	const start = plan.days.length && plan.days[0].date > todayDate ? plan.days[0].date : todayDate;
	const future = buildSchedule(plan.topics, start, plan.meta.date, plan.meta.minutesPerDay, { learned, reviewed, weakTopics: plan.meta.weakTopics });
	const days = [...past, ...future];
	const fm = parseFrontmatter(content);
	fm.data.weak_topics = plan.meta.weakTopics;
	const secs = splitSections(fm.body);
	const rebuilt = secs
		.map((s) => {
			if (s.heading === "") return s.text;
			if (s.heading === "Plan") return `## Plan\n\n${renderDays(days).trimEnd()}\n`;
			return `## ${s.heading}\n${s.text}`;
		})
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
	return renderFrontmatter(fm.data) + rebuilt.replace(/^\n+/, "");
}

/** Adds titles to the plan's weak topics (frontmatter) and returns the updated content. */
export function addWeakTopics(content: string, titles: string[]): string {
	const fm = parseFrontmatter(content);
	const existing = Array.isArray(fm.data.weak_topics) ? fm.data.weak_topics : [];
	const merged = Array.from(new Set([...existing, ...titles.map((t) => t.trim()).filter(Boolean)]));
	fm.data.weak_topics = merged;
	return renderFrontmatter(fm.data) + fm.body.replace(/^\n+/, "");
}

/** The items planned for `date`, with the topics they refer to. */
export function itemsOn(plan: Plan, date: string): PlanItem[] {
	return plan.days.find((d) => d.date === date)?.items ?? [];
}

/** The plan note name for a course and exam. */
export function planNoteName(course: string, exam: string, examDate: string): string {
	const safe = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim();
	return `${safe(course)} – ${safe(exam)} ${examDate}.md`;
}
