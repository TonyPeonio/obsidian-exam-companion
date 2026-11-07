import { describe, expect, it } from "vitest";
import { addDays, dateRange, daysBetween, isIsoDate, weekday } from "../src/core/dates";
import { createPlan, validateRequest } from "../src/core/exam";
import { parseFrontmatter, renderFrontmatter } from "../src/core/frontmatter";
import { MIN_SLOT, PlanError, addWeakTopics, buildSchedule, parsePlanNote, planNoteName, rebuildPlan, renderPlanNote, topicIdFromLink } from "../src/core/planner";
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
		expect(isIsoDate("2026-02-30")).toBe(true); // calendar validity is not checked, only the shape
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

	it("validates the request", () => {
		expect(validateRequest({ courseFolder: "C", exam: "", examDate: "2026-12-01", startDate: "2026-11-08", minutesPerDay: 45 })).toMatch(/name/);
		expect(validateRequest({ courseFolder: "C", exam: "X", examDate: "Dec 1", startDate: "2026-11-08", minutesPerDay: 45 })).toMatch(/YYYY-MM-DD/);
		expect(validateRequest({ courseFolder: "C", exam: "X", examDate: "2026-11-08", startDate: "2026-11-08", minutesPerDay: 45 })).toMatch(/after/);
		expect(validateRequest({ courseFolder: "C", exam: "X", examDate: "2026-12-01", startDate: "2026-11-08", minutesPerDay: 5 })).toMatch(/at least 10/);
		expect(validateRequest({ courseFolder: "C", exam: "X", examDate: "2026-12-01", startDate: "2026-11-08", minutesPerDay: 45 })).toBeNull();
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

	it("leaves a plan alone once the exam day has arrived", async () => {
		const vault = lectureVault();
		const { content } = await createPlan(vault, { courseFolder: "Courses/CSCI 470", exam: "Final", examDate: "2026-11-10", startDate: "2026-11-08", minutesPerDay: 45 });
		expect(rebuildPlan(content, "2026-11-10")).toBe(content);
	});
});
