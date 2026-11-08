import { isIsoDate } from "./dates";
import { buildSchedule, PlanError, planNoteName, renderPlanNote, type Plan } from "./planner";
import { extractTopics, type NoteContent } from "./topics";
import { notesInFolder, type VaultAccess } from "./vault";

/** Everything "Plan an exam" needs from the user. */
export interface ExamRequest {
	courseFolder: string;
	/** Shown in the plan title; defaults to the folder's last segment. */
	course?: string;
	exam: string;
	examDate: string;
	startDate: string;
	minutesPerDay: number;
}

export function courseNameFor(folder: string): string {
	const trimmed = folder.replace(/^\/+|\/+$/g, "");
	return trimmed.split("/").pop() || "Course";
}

/** `todayDate` (YYYY-MM-DD), when given, rejects an exam that is today or already over. */
export function validateRequest(r: ExamRequest, todayDate?: string): string | null {
	if (!r.exam.trim()) return "Give the exam a name (e.g. Midterm 2).";
	if (!isIsoDate(r.examDate)) return "The exam date must be a real date, YYYY-MM-DD.";
	if (!isIsoDate(r.startDate)) return "The start date must be a real date, YYYY-MM-DD.";
	if (todayDate && r.examDate <= todayDate) return `The exam date must be after today (${todayDate}).`;
	if (r.examDate <= r.startDate) return "The exam date must be after the start date.";
	if (!Number.isFinite(r.minutesPerDay) || r.minutesPerDay < 10) return "Minutes per day must be at least 10.";
	return null;
}

/** Reads the course folder, extracts topics, schedules, and renders the plan note. */
export async function createPlan(vault: VaultAccess, r: ExamRequest): Promise<{ plan: Plan; content: string; fileName: string }> {
	const problem = validateRequest(r);
	if (problem) throw new PlanError(problem);
	const notes = notesInFolder(vault, r.courseFolder);
	if (notes.length === 0) throw new PlanError(`No notes found under "${r.courseFolder || "/"}".`);
	const contents: NoteContent[] = [];
	for (const n of notes) contents.push({ path: n.path, content: await vault.read(n.path) });
	const topics = extractTopics(contents);
	const course = (r.course ?? "").trim() || courseNameFor(r.courseFolder);
	const days = buildSchedule(topics, r.startDate, r.examDate, r.minutesPerDay);
	const plan: Plan = {
		meta: { exam: r.exam.trim(), course, courseFolder: r.courseFolder.replace(/^\/+|\/+$/g, ""), date: r.examDate, startDate: r.startDate, minutesPerDay: r.minutesPerDay, weakTopics: [] },
		days,
		topics,
	};
	return { plan, content: renderPlanNote(plan), fileName: planNoteName(course, plan.meta.exam, r.examDate) };
}

/** Re-reads the plan's course folder so quiz prompts get the topics' current text. */
export async function loadTopics(vault: VaultAccess, courseFolder: string) {
	const notes = notesInFolder(vault, courseFolder);
	const contents: NoteContent[] = [];
	for (const n of notes) contents.push({ path: n.path, content: await vault.read(n.path) });
	return extractTopics(contents);
}
