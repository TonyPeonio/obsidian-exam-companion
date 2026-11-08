import { describe, expect, it } from "vitest";
import { addDays, dateRange, daysBetween, isIsoDate, weekday } from "../src/core/dates";
import { createPlan, validateRequest } from "../src/core/exam";
import { parseFrontmatter, renderFrontmatter } from "../src/core/frontmatter";
import { MIN_SLOT, PlanError, addWeakTopics, buildSchedule, itemsOn, parsePlanNote, planNoteName, rebuildPlan, renderPlanNote, topicIdFromLink, type Plan } from "../src/core/planner";
import { attachTopics, latestQuiz, quizTopicsFor, renderQuizSection, weakTopicTitles } from "../src/core/quiz";
import type { Topic } from "../src/core/topics";
import { lectureVault } from "./fakes";

const topic = (i: number, words: number): Topic => ({ id: `C/N${i}.md#H${i}`, title: `Topic ${i}`, note: `C/N${i}.md`, heading: `H${i}`, text: "t", words });
const topics = [topic(1, 400), topic(2, 100), topic(3, 250), topic(4, 150), topic(5, 50)];

describe("dates", () => {
	it("adds, diffs and ranges in UTC", () => {
		expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
		expect(daysBetween("2026-11-08", "2026-12-01")).toBe(23);
		expect(dateRange("2026-11-08", "2026-11-10")).toEqual(["2026-11-08", "2026-11-09", "2026-11-10"]);
		expect(dateRange("2026-11-10", "2026-11-09")).toEqual([]);
		expect(weekday("2026-11-08")).toBe("Sun");
		expect(isIsoDate("2026-02-28")).toBe(true);
		expect(isIsoDate("2028-02-29")).toBe(true);
		expect(isIsoDate("2026-02-30")).toBe(false);
		expect(isIsoDate("2026-02-29")).toBe(false);
		expect(isIsoDate("2026-13-01")).toBe(false);
		expect(isIsoDate("8 Nov")).toBe(false);
	});
});

describe("frontmatter", () => {
	it("round-trips scalars and lists", () => {
		const text = renderFrontmatter({ exam: "Midterm 2: part B", date: "2026-12-01", minutes_per_day: "45", weak_topics: ["Vectors", "Matrices: intro"], empty: [] });
		const fm = parseFrontmatter(text + "# Title\n");
		expect(fm.present).toBe(true);
		expect(fm.data).toEqual({ exam: "Midterm 2: part B", date: "2026-12-01", minutes_per_day: "45", weak_topics: ["Vectors", "Matrices: intro"], empty: [] });
		expect(fm.body).toBe("# Title\n");
		expect(parseFrontmatter("no frontmatter").present).toBe(false);
	});
});

describe("buildSchedule", () => {
	it("gives every topic a first pass and a later review, keeps days within budget, and ends with mixed review", () => {
		const days = buildSchedule(topics, "2026-11-08", "2026-11-22", 45);
		expect(days).toHaveLength(14);
		expect(days[0].date).toBe("2026-11-08");
		expect(days[13].date).toBe("2026-11-21");
		for (const t of topics) {
			const learn = days.findIndex((d) => d.items.some((i) => i.topicId === t.id && i.kind === "learn"));
			const review = days.findIndex((d) => d.items.some((i) => i.topicId === t.id && i.kind === "review"));
			expect(learn).toBeGreaterThanOrEqual(0);
			expect(review).toBeGreaterThan(learn);
			expect(review - learn).toBeGreaterThanOrEqual(3);
			expect(review - learn).toBeLessThanOrEqual(5);
		}
		for (const d of days) {
			const minutes = d.items.reduce((n, i) => n + i.minutes, 0);
			expect(minutes).toBeLessThanOrEqual(45);
			for (const i of d.items) expect(i.minutes).toBeGreaterThanOrEqual(MIN_SLOT);
		}
		expect(days[12].items.every((i) => i.kind === "final")).toBe(true);
		expect(days[13].items.every((i) => i.kind === "final")).toBe(true);
		expect(days[12].items.length).toBeGreaterThan(0);
		// Heavier topics get more minutes.
		const minutesOf = (id: string) => days.flatMap((d) => d.items).find((i) => i.topicId === id && i.kind === "learn")!.minutes;
		expect(minutesOf(topics[0].id)).toBeGreaterThan(minutesOf(topics[4].id));
	});

	it("is deterministic", () => {
		const a = JSON.stringify(buildSchedule(topics, "2026-11-08", "2026-11-22", 45));
		const b = JSON.stringify(buildSchedule(topics, "2026-11-08", "2026-11-22", 45));
		expect(a).toBe(b);
	});

	it("copes with very short runways and rejects impossible ones", () => {
		const two = buildSchedule(topics, "2026-11-08", "2026-11-10", 60);
		expect(two).toHaveLength(2);
		expect(two.flatMap((d) => d.items).filter((i) => i.kind === "learn")).toHaveLength(5);
		expect(two[1].items.every((i) => i.kind === "final" || i.kind === "review")).toBe(true);
		expect(() => buildSchedule(topics, "2026-11-08", "2026-11-08", 45)).toThrow(PlanError);
		expect(() => buildSchedule([], "2026-11-08", "2026-11-20", 45)).toThrow(/No topics/);
	});

	it("spreads first passes over the study days when the runway is too short for everything", () => {
		const many = Array.from({ length: 30 }, (_, i) => topic(i + 1, 100 + (i % 5) * 50));
		const days = buildSchedule(many, "2026-11-08", "2026-11-13", 45);
		expect(days).toHaveLength(5);
		const learnPerDay = days.map((d) => d.items.filter((i) => i.kind === "learn").length);
		expect(learnPerDay.reduce((n, c) => n + c, 0)).toBe(30);
		// Three study days, ten first passes each, not 2 + 2 + 26.
		expect(learnPerDay.slice(0, 3)).toEqual([10, 10, 10]);
		expect(learnPerDay.slice(3)).toEqual([0, 0]);
		for (const t of many) expect(days.flatMap((d) => d.items).some((i) => i.topicId === t.id && i.kind === "learn")).toBe(true);
	});

	it("keeps reviews proportional and within budget when everything is already learned", () => {
		const days = buildSchedule(topics, "2026-11-12", "2026-11-22", 45, { learned: new Set(topics.map((t) => t.id)) });
		const reviews = days.flatMap((d) => d.items).filter((i) => i.kind === "review");
		expect(reviews.map((r) => r.topicId).sort()).toEqual(topics.map((t) => t.id).sort());
		const minutesOf = (id: string) => reviews.find((r) => r.topicId === id)!.minutes;
		// The 400-word topic gets a longer review than the 50-word one; none is half a day.
		expect(minutesOf(topics[0].id)).toBeGreaterThan(minutesOf(topics[4].id));
		expect(Math.max(...reviews.map((r) => r.minutes))).toBeLessThan(45 / 2 + 1);
		for (const d of days) expect(d.items.reduce((n, i) => n + i.minutes, 0)).toBeLessThanOrEqual(45);
		// Early reviews spill forward instead of overloading the first three days.
		expect(days.slice(0, 2).every((d) => d.items.length > 0)).toBe(true);
	});

	it("works for a folder with a single note and for one day before the exam", () => {
		const one = buildSchedule([topic(1, 120)], "2026-11-08", "2026-11-15", 30);
		const all = one.flatMap((d) => d.items);
		expect(all.filter((i) => i.kind === "learn")).toHaveLength(1);
		expect(all.filter((i) => i.kind === "review")).toHaveLength(1);
		expect(all.filter((i) => i.kind === "final")).toHaveLength(2);
		for (const d of one) expect(d.items.reduce((n, i) => n + i.minutes, 0)).toBeLessThanOrEqual(30);
		const lastMinute = buildSchedule(topics, "2026-11-08", "2026-11-09", 45);
		expect(lastMinute).toHaveLength(1);
		expect(lastMinute[0].items.filter((i) => i.kind === "learn")).toHaveLength(5);
		expect(lastMinute[0].items.filter((i) => i.kind === "final")).toHaveLength(0);
	});

	it("skips first passes for topics already learned and puts weak topics first in the final days", () => {
		const days = buildSchedule(topics, "2026-11-12", "2026-11-22", 45, { learned: new Set([topics[0].id, topics[1].id]), reviewed: new Set([topics[0].id]), weakTopics: ["Topic 5"] });
		const all = days.flatMap((d) => d.items);
		expect(all.some((i) => i.topicId === topics[0].id && i.kind === "learn")).toBe(false);
		expect(all.some((i) => i.topicId === topics[0].id && i.kind === "review")).toBe(false);
		// Learned but not reviewed: an early review.
		const t2review = days.findIndex((d) => d.items.some((i) => i.topicId === topics[1].id && i.kind === "review"));
		expect(t2review).toBeLessThanOrEqual(2);
		// Weak topic: an extra review plus first place in the final review.
		expect(all.filter((i) => i.topicId === topics[4].id && i.kind === "review").length).toBeGreaterThanOrEqual(2);
		expect(days[days.length - 2].items[0].topicId).toBe(topics[4].id);
	});
});

describe("plan note", () => {
	it("renders, parses back identically, and names the file safely", async () => {
		const vault = lectureVault();
		const { plan, content, fileName } = await createPlan(vault, { courseFolder: "Courses/CSCI 470", exam: "Midterm 2", examDate: "2026-11-22", startDate: "2026-11-08", minutesPerDay: 45 });
		expect(fileName).toBe("CSCI 470 – Midterm 2 2026-11-22.md");
		expect(content).toMatch(/^---\nexam: Midterm 2\ncourse: CSCI 470\ncourse_folder: Courses\/CSCI 470\ndate: 2026-11-22\nstart_date: 2026-11-08\nminutes_per_day: 45\nweak_topics: \[\]\n---\n# CSCI 470 – Midterm 2\n/);
		expect(content).toContain("## Plan\n\n### 2026-11-08 (Sun)\n\n- [ ] Isolation forests (2026-09-11) — ");
		expect(content).toContain("## Topics\n\n- Isolation forests (2026-09-11) (");
		const parsed = parsePlanNote(content);
		expect(parsed.meta).toEqual({ exam: "Midterm 2", course: "CSCI 470", courseFolder: "Courses/CSCI 470", date: "2026-11-22", startDate: "2026-11-08", minutesPerDay: 45, weakTopics: [] });
		expect(parsed.days.map((d) => d.date)).toEqual(plan.days.map((d) => d.date));
		expect(parsed.days.map((d) => d.items.map((i) => [i.topicId, i.kind, i.minutes]))).toEqual(plan.days.map((d) => d.items.map((i) => [i.topicId, i.kind, i.minutes])));
		expect(parsed.topics.map((t) => t.id)).toEqual(plan.topics.map((t) => t.id));
		expect(renderPlanNote({ ...parsed, topics: plan.topics })).toBe(content);
		expect(planNoteName('A/B: "C"', "Final?", "2026-12-15")).toBe("AB C – Final 2026-12-15.md");
		expect(topicIdFromLink("[[Courses/X#2026-09-11]]")).toBe("Courses/X.md#2026-09-11");
		expect(topicIdFromLink("[[Courses/Y]]")).toBe("Courses/Y.md");
	});

	it("round-trips a heading that itself contains #", () => {
		expect(topicIdFromLink("[[Courses/Langs#C# basics]]")).toBe("Courses/Langs.md#C# basics");
		const t: Topic = { id: "Courses/Langs.md#C# basics", title: "C# basics", note: "Courses/Langs.md", heading: "C# basics", text: "t", words: 80 };
		const plan = { meta: { exam: "Final", course: "Langs", courseFolder: "Courses", date: "2026-11-12", startDate: "2026-11-08", minutesPerDay: 30, weakTopics: [] }, days: buildSchedule([t], "2026-11-08", "2026-11-12", 30), topics: [t] };
		const parsed = parsePlanNote(renderPlanNote(plan));
		expect(parsed.topics[0]).toMatchObject({ id: t.id, note: "Courses/Langs.md", heading: "C# basics" });
		expect(parsed.days[0].items[0].topicId).toBe(t.id);
	});

	it("validates the request", () => {
		expect(validateRequest({ courseFolder: "C", exam: "", examDate: "2026-12-01", startDate: "2026-11-08", minutesPerDay: 45 })).toMatch(/name/);
		expect(validateRequest({ courseFolder: "C", exam: "X", examDate: "Dec 1", startDate: "2026-11-08", minutesPerDay: 45 })).toMatch(/YYYY-MM-DD/);
		expect(validateRequest({ courseFolder: "C", exam: "X", examDate: "2026-02-30", startDate: "2026-11-08", minutesPerDay: 45 })).toMatch(/real date/);
		expect(validateRequest({ courseFolder: "C", exam: "X", examDate: "2026-11-08", startDate: "2026-11-08", minutesPerDay: 45 })).toMatch(/after/);
		expect(validateRequest({ courseFolder: "C", exam: "X", examDate: "2026-12-01", startDate: "2026-11-08", minutesPerDay: 5 })).toMatch(/at least 10/);
		expect(validateRequest({ courseFolder: "C", exam: "X", examDate: "2026-12-01", startDate: "2026-11-08", minutesPerDay: 45 })).toBeNull();
		// With today known: an exam that is over, or today, cannot be planned; a past start date can.
		expect(validateRequest({ courseFolder: "C", exam: "X", examDate: "2026-10-01", startDate: "2026-09-01", minutesPerDay: 45 }, "2026-11-07")).toMatch(/after today/);
		expect(validateRequest({ courseFolder: "C", exam: "X", examDate: "2026-11-07", startDate: "2026-11-01", minutesPerDay: 45 }, "2026-11-07")).toMatch(/after today/);
		expect(validateRequest({ courseFolder: "C", exam: "X", examDate: "2026-11-08", startDate: "2026-11-01", minutesPerDay: 45 }, "2026-11-07")).toBeNull();
	});
});

describe("rebuildPlan", () => {
	it("keeps past days with their ticks, reschedules from today, adds weak-topic reviews, and is idempotent", async () => {
		const vault = lectureVault();
		const { content } = await createPlan(vault, { courseFolder: "Courses/CSCI 470", exam: "Midterm 2", examDate: "2026-11-22", startDate: "2026-11-08", minutesPerDay: 45 });
		// The student ticked the first day and wrote a quiz section.
		const ticked = content.replace("### 2026-11-08 (Sun)\n\n- [ ] ", "### 2026-11-08 (Sun)\n\n- [x] ") + "\n## Quiz 2026-11-08\n\n- [x] What is an isolation forest?\n    > [!answer]- Answer\n    > A tree ensemble.\n";
		const weak = addWeakTopics(ticked, ["Gradient boosting (2026-09-18)"]);
		expect(parsePlanNote(weak).meta.weakTopics).toEqual(["Gradient boosting (2026-09-18)"]);
		const rebuilt = rebuildPlan(weak, "2026-11-10");
		const plan = parsePlanNote(rebuilt);
		// Past days untouched (tick kept), future days regenerated from today.
		expect(rebuilt).toContain("### 2026-11-08 (Sun)\n\n- [x] ");
		expect(plan.days[0].date).toBe("2026-11-08");
		expect(plan.days[2].date).toBe("2026-11-10");
		const future = plan.days.filter((d) => d.date >= "2026-11-10").flatMap((d) => d.items);
		const learnedBefore = plan.days.filter((d) => d.date < "2026-11-10").flatMap((d) => d.items.filter((i) => i.kind === "learn")).map((i) => i.topicId);
		for (const id of learnedBefore) expect(future.some((i) => i.topicId === id && i.kind === "learn")).toBe(false);
		expect(future.filter((i) => i.title === "Gradient boosting (2026-09-18)" && i.kind === "review").length).toBeGreaterThanOrEqual(2);
		// The quiz section and the Topics section survive.
		expect(rebuilt).toContain("## Quiz 2026-11-08\n\n- [x] What is an isolation forest?");
		expect(rebuilt).toContain("## Topics\n\n- Isolation forests (2026-09-11)");
		expect(rebuildPlan(rebuilt, "2026-11-10")).toBe(rebuilt);
		expect(addWeakTopics(rebuilt, ["Gradient boosting (2026-09-18)"])).toBe(rebuilt);
	});

	it("gives topics answered wrong a larger share of the remaining plan and drops no topic", async () => {
		const vault = lectureVault();
		const { plan, content } = await createPlan(vault, { courseFolder: "Courses/CSCI 470", exam: "Midterm 2", examDate: "2026-11-22", startDate: "2026-11-08", minutesPerDay: 45 });
		const todayDate = "2026-11-11";
		// A quiz on the topics planned for the day before: Gradient boosting wrong, the rest right.
		const items = itemsOn(plan, "2026-11-10");
		const quizTopics = quizTopicsFor(items, plan.topics);
		expect(quizTopics.length).toBeGreaterThan(0);
		const questions = attachTopics(
			quizTopics.map((t, i) => ({ question: `Explain ${t.title.replace(/\s*\(.*\)$/, "").toLowerCase()} (${i})?`, answer: "Because." })),
			quizTopics,
		);
		const gb = plan.topics.find((t) => t.title.startsWith("Gradient boosting"))!;
		const gbQuestion = attachTopics([{ question: "Explain gradient boosting in one line?", answer: "Residuals." }], [{ title: gb.title, text: gb.text, link: `[[${gb.note.replace(/\.md$/, "")}#${gb.heading}]]` }]);
		const section = renderQuizSection("2026-11-10", [...questions, ...gbQuestion]);
		const ticked = section.replace(/- \[ \] (Explain (?!gradient))/g, "- [x] $1");
		const withQuiz = content + "\n" + ticked;
		const results = latestQuiz(withQuiz);
		expect(results.some((r) => !r.correct)).toBe(true);
		const weak = weakTopicTitles(results, parsePlanNote(withQuiz).days.flatMap((d) => d.items));
		expect(weak).toEqual([gb.title]);

		const before = parsePlanNote(rebuildPlan(withQuiz, todayDate));
		const after = parsePlanNote(rebuildPlan(addWeakTopics(withQuiz, weak), todayDate));
		expect(after.meta.weakTopics).toEqual([gb.title]);
		const futureMinutes = (p: Plan, id: string) => p.days.filter((d) => d.date >= todayDate).flatMap((d) => d.items).filter((i) => i.topicId === id).reduce((n, i) => n + i.minutes, 0);
		const futureTotal = (p: Plan) => p.days.filter((d) => d.date >= todayDate).flatMap((d) => d.items).reduce((n, i) => n + i.minutes, 0);
		expect(futureMinutes(after, gb.id)).toBeGreaterThan(futureMinutes(before, gb.id));
		expect(futureMinutes(after, gb.id) / futureTotal(after)).toBeGreaterThan(futureMinutes(before, gb.id) / futureTotal(before));
		// Weak topic first in the final mixed review.
		expect(after.days[after.days.length - 2].items[0].topicId).toBe(gb.id);
		// Every topic that still had work ahead keeps at least one item; nothing vanishes.
		const futureIds = (p: Plan) => new Set(p.days.filter((d) => d.date >= todayDate).flatMap((d) => d.items).map((i) => i.topicId));
		for (const id of futureIds(before)) expect(futureIds(after).has(id)).toBe(true);
		for (const t of plan.topics) expect(after.days.flatMap((d) => d.items).some((i) => i.topicId === t.id)).toBe(true);
		// Recording the same quiz again changes nothing more.
		const again = rebuildPlan(addWeakTopics(rebuildPlan(addWeakTopics(withQuiz, weak), todayDate), weak), todayDate);
		expect(again).toBe(rebuildPlan(addWeakTopics(withQuiz, weak), todayDate));
	});

	it("leaves a plan alone once the exam day has arrived", async () => {
		const vault = lectureVault();
		const { content } = await createPlan(vault, { courseFolder: "Courses/CSCI 470", exam: "Final", examDate: "2026-11-10", startDate: "2026-11-08", minutesPerDay: 45 });
		expect(rebuildPlan(content, "2026-11-10")).toBe(content);
	});
});
