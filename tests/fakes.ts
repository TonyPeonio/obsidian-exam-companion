import type { NoteInfo, VaultAccess } from "../src/core/vault";

/** In-memory vault for tests. */
export class FakeVault implements VaultAccess {
	private files = new Map<string, string>();
	private clock = 1_700_000_000_000;

	constructor(initial: Record<string, string> = {}) {
		for (const [p, c] of Object.entries(initial)) this.files.set(p, c);
	}

	listNotes(): NoteInfo[] {
		return Array.from(this.files.keys()).map((path) => ({
			path,
			basename: (path.split("/").pop() ?? path).replace(/\.md$/, ""),
			folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
			mtime: (this.clock += 1000),
		}));
	}

	listFolders(): string[] {
		const out = new Set<string>();
		for (const path of this.files.keys()) {
			const parts = path.split("/");
			for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
		}
		return Array.from(out).sort();
	}

	exists(path: string): boolean {
		return this.files.has(path);
	}

	async read(path: string): Promise<string> {
		const c = this.files.get(path);
		if (c === undefined) throw new Error(`Note not found: ${path}`);
		return c;
	}

	async create(path: string, content: string): Promise<void> {
		if (this.files.has(path)) throw new Error(`Already exists: ${path}`);
		this.files.set(path, content);
	}

	async modify(path: string, content: string): Promise<void> {
		if (!this.files.has(path)) throw new Error(`Note not found: ${path}`);
		this.files.set(path, content);
	}
}

/** A Lecture Companion-style course: one note per lecture with a Summary. */
export function lectureVault(): FakeVault {
	const lecture = (date: string, topic: string, words: number) =>
		`# ${date}\n\n## ${date}\n\n**Topic:** ${topic}\n\n![[Recording ${date}.m4a]]\n\n### Summary\n\n${Array.from({ length: words }, (_, i) => `word${i}`).join(" ")}\n\n### Transcript\n\n[00:00] lots of speech ${"blah ".repeat(50)}\n`;
	return new FakeVault({
		"Courses/CSCI 470/2026-09-11.md": lecture("2026-09-11", "Isolation forests", 120),
		"Courses/CSCI 470/2026-09-18.md": lecture("2026-09-18", "Gradient boosting", 300),
		"Courses/CSCI 470/2026-09-25.md": lecture("2026-09-25", "Neural networks", 200),
		"Courses/CSCI 470/2026-10-02.md": lecture("2026-10-02", "Backpropagation", 90),
		"Courses/CSCI 470/Cheat sheet.md": "# Cheat sheet\n\nBias–variance: more flexible models have lower bias and higher variance. Regularisation trades one for the other.\n",
		"Courses/CSCI 470/Templates.md": "",
		"Other/Unrelated.md": "# Not a course\n\nstuff\n",
	});
}
