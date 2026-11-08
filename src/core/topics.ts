/**
 * Topics are what a study plan schedules: one per `## heading` section of each note in the
 * course folder, or the whole note when it has no `##` headings or when it is a Lecture
 * Companion lecture note (`## Slides`, `## Summary`, `## Transcript`, `## My notes` are the
 * note's structure, not topics; the Summary is the quiz text). Lecture Companion's other layout,
 * one `## YYYY-MM-DD` section per class with a `### Summary` under it, is one topic per section.
 */

export interface Topic {
	/** Stable id: `<note path>#<heading>` or `<note path>` for a whole note. */
	id: string;
	title: string;
	/** Vault path of the note, with `.md`. */
	note: string;
	/** Heading text (without `#`) when the topic is one section. */
	heading?: string;
	/** Text used for quizzes: the `### Summary` when there is one, else the section body. */
	text: string;
	/** Words in the whole section; the planner's weight. */
	words: number;
	/** Sort key: a date found in the heading, the note name or the frontmatter. */
	date?: string;
}

export interface NoteContent {
	path: string;
	content: string;
}

const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

function basename(path: string): string {
	return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

export function countWords(text: string): number {
	return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function stripFrontmatter(content: string): { body: string; date?: string; title?: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!m) return { body: content };
	const date = /^date:\s*"?(\d{4}-\d{2}-\d{2})"?/m.exec(m[1])?.[1];
	const rawTitle = /^title:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
	const title = rawTitle ? rawTitle.replace(/^(["'])(.*)\1$/, "$2").replace(/\\"/g, '"').trim() || undefined : undefined;
	return { body: content.slice(m[0].length), date, title };
}

/** Lecture Companion's per-lecture layout: the `##` sections are Slides/Summary/Transcript/My notes. */
const LECTURE_SECTIONS = new Set(["slides", "summary", "transcript", "my notes"]);

function isLectureNote(level2: Section[]): boolean {
	const names = level2.map((s) => s.heading.toLowerCase());
	return names.includes("summary") && names.some((n) => n !== "summary" && LECTURE_SECTIONS.has(n));
}

interface Section {
	heading: string;
	level: number;
	start: number;
	end: number;
}

function sections(lines: string[]): Section[] {
	const out: Section[] = [];
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
		if (inFence) continue;
		const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
		if (m) out.push({ heading: m[2].trim(), level: m[1].length, start: i, end: lines.length });
	}
	for (let k = 0; k < out.length; k++) {
		for (let j = k + 1; j < out.length; j++) {
			if (out[j].level <= out[k].level) {
				out[k].end = out[j].start;
				break;
			}
		}
	}
	return out;
}

/** The link target Obsidian resolves for a topic: path without `.md`, plus `#Heading`. */
export function topicLink(t: Pick<Topic, "note" | "heading">): string {
	const base = t.note.replace(/\.md$/i, "");
	return t.heading ? `[[${base}#${t.heading}]]` : `[[${base}]]`;
}

export function extractTopics(notes: NoteContent[]): Topic[] {
	const topics: Topic[] = [];
	for (const note of notes) {
		const { body, date: fmDate, title: fmTitle } = stripFrontmatter(note.content);
		const lines = body.split("\n");
		const all = sections(lines);
		const level2 = all.filter((s) => s.level === 2);
		const name = basename(note.path);
		const noteDate = fmDate ?? DATE_RE.exec(name)?.[1];
		if (isLectureNote(level2)) {
			// One topic per lecture: the Summary is the quiz text, the whole note the weight.
			const words = countWords(lines.filter((l) => !/^#{1,2}\s/.test(l)).join("\n"));
			if (words === 0) continue;
			const summary = level2.find((s) => s.heading.toLowerCase() === "summary")!;
			const summaryText = lines.slice(summary.start + 1, summary.end).join("\n").trim();
			const rest = lines.filter((l, i) => !/^##\s/.test(l) && (i <= summary.start || i >= summary.end)).join("\n").trim();
			const text = summaryText && !/^_No summary yet\._$/.test(summaryText) ? summaryText : rest;
			if (!countWords(text)) continue;
			const title = fmTitle ? (noteDate && !fmTitle.includes(noteDate) ? `${fmTitle} (${noteDate})` : fmTitle) : name;
			topics.push({ id: note.path, title, note: note.path, text, words, date: noteDate });
			continue;
		}
		if (level2.length === 0) {
			const text = lines
				.filter((l) => !/^#\s/.test(l))
				.join("\n")
				.trim();
			const words = countWords(text);
			if (words === 0) continue;
			topics.push({ id: note.path, title: name, note: note.path, text, words, date: noteDate });
			continue;
		}
		for (const s of level2) {
			const sectionLines = lines.slice(s.start + 1, s.end);
			const sectionText = sectionLines.join("\n").trim();
			const words = countWords(sectionText);
			if (words === 0) continue;
			const summary = all.find((x) => x.level === 3 && x.start > s.start && x.start < s.end && /^summary\b/i.test(x.heading));
			const text = summary ? lines.slice(summary.start + 1, summary.end).join("\n").trim() || sectionText : sectionText;
			const headingDate = DATE_RE.exec(s.heading)?.[1];
			// A dated lecture section is titled by its topic line when it has one, else by the note.
			let title = s.heading;
			if (headingDate) {
				const topicLine = /^\*\*Topic:?\*\*:?\s*(.+)$/im.exec(sectionText)?.[1]?.trim();
				title = topicLine ? `${topicLine} (${headingDate})` : `${name} ${headingDate}`;
			}
			topics.push({ id: `${note.path}#${s.heading}`, title, note: note.path, heading: s.heading, text, words, date: headingDate ?? noteDate });
		}
	}
	// Lecture order: by date when known, then by note path and position.
	return topics
		.map((t, i) => ({ t, i }))
		.sort((a, b) => {
			const da = a.t.date ?? "";
			const db = b.t.date ?? "";
			if (da && db && da !== db) return da.localeCompare(db);
			if (da && !db) return -1;
			if (!da && db) return 1;
			return a.i - b.i;
		})
		.map((x) => x.t);
}
