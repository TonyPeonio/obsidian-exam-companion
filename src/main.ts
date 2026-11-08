import { Notice, Plugin, TFile, normalizePath, requestUrl } from "obsidian";
import { today } from "./core/dates";
import { createPlan, loadTopics } from "./core/exam";
import { OllamaClient, explainOllamaError } from "./core/ollama";
import { PlanError, addWeakTopics, itemsOn, parsePlanNote, rebuildPlan, type Plan } from "./core/planner";
import { attachTopics, buildQuizUserMessage, flashcards, flashcardsHeader, latestQuiz, mergeFlashcards, parseQuiz, quizSystemPrompt, quizTopicsFor, renderQuizSection, weakTopicTitles } from "./core/quiz";
import { writeNote } from "./core/vault";
import { ObsidianVault } from "./obsidian-vault";
import { PlanModal } from "./plan-modal";
import { DEFAULT_SETTINGS, type ExamCompanionSettings } from "./settings";
import { ExamCompanionSettingTab } from "./settings-tab";

export default class ExamCompanionPlugin extends Plugin {
	settings: ExamCompanionSettings = { ...DEFAULT_SETTINGS };
	client!: OllamaClient;
	vault!: ObsidianVault;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.vault = new ObsidianVault(this.app);
		this.client = new OllamaClient(
			() => this.settings.ollamaUrl,
			(...args) => fetch(...args),
			async (url, body, method) => {
				const res = await requestUrl(method === "GET" ? { url, method, throw: false } : { url, method, contentType: "application/json", body, throw: false });
				return { status: res.status, text: res.text };
			},
		);
		this.addSettingTab(new ExamCompanionSettingTab(this.app, this));

		this.addRibbonIcon("graduation-cap", "Plan an exam", () => void this.planExam());
		this.addCommand({ id: "plan-exam", name: "Plan an exam", callback: () => void this.planExam() });
		this.addCommand({ id: "todays-quiz", name: "Today's quiz", callback: () => void this.todaysQuiz() });
		this.addCommand({
			id: "record-quiz-results",
			name: "Record quiz results",
			checkCallback: (checking) => {
				const file = this.activePlanFile();
				if (!file) return false;
				if (!checking) void this.recordResults(file);
				return true;
			},
		});
		this.addCommand({
			id: "export-flashcards",
			name: "Export flashcards",
			checkCallback: (checking) => {
				const file = this.activePlanFile();
				if (!file) return false;
				if (!checking) void this.exportFlashcards(file);
				return true;
			},
		});
	}

	// ---------------------------------------------------------------- commands

	async planExam(): Promise<void> {
		const modal = new PlanModal(this.app, this.vault.listFolders(), { courseFolder: this.settings.lastCourseFolder, minutesPerDay: this.settings.minutesPerDay });
		modal.open();
		const req = await modal.result;
		if (!req) return;
		try {
			const { plan, content, fileName } = await createPlan(this.vault, req);
			const path = normalizePath(`${this.settings.examsFolder}/${fileName}`);
			await writeNote(this.vault, path, content);
			this.settings.lastCourseFolder = req.courseFolder;
			this.settings.minutesPerDay = req.minutesPerDay;
			await this.saveSettings();
			await this.app.workspace.openLinkText(path, "", false);
			new Notice(`Planned ${plan.topics.length} topics over ${plan.days.length} days.`);
		} catch (err) {
			new Notice(err instanceof PlanError ? err.message : `Could not create the plan: ${(err as Error).message}`, 8000);
		}
	}

	async todaysQuiz(): Promise<void> {
		const file = this.activePlanFile() ?? (await this.planForToday());
		if (!file) {
			new Notice("Open a plan note, or create one with Plan an exam.");
			return;
		}
		const content = await this.app.vault.cachedRead(file);
		let plan: Plan;
		try {
			plan = parsePlanNote(content);
		} catch (err) {
			new Notice((err as Error).message, 8000);
			return;
		}
		const date = today();
		const items = itemsOn(plan, date);
		if (items.length === 0) {
			new Notice(`Nothing planned for ${date} in this plan.`);
			return;
		}
		const topics = await loadTopics(this.vault, plan.meta.courseFolder);
		const quizTopics = quizTopicsFor(items, topics);
		const { message, truncated } = buildQuizUserMessage(quizTopics, this.settings.questionsPerQuiz, this.settings.numCtx);
		const notice = new Notice(`Writing today's quiz with ${this.settings.model}…`, 0);
		try {
			const reply = await this.client.chat({
				model: this.settings.model,
				messages: [
					{ role: "system", content: quizSystemPrompt(this.settings.questionsPerQuiz) },
					{ role: "user", content: message },
				],
				options: { num_ctx: this.settings.numCtx, temperature: this.settings.temperature, top_p: 0.9, top_k: 20 },
				keep_alive: "10m",
				think: this.settings.thinking ? true : false,
			});
			const pairs = parseQuiz(reply, this.settings.questionsPerQuiz);
			if (pairs.length === 0) throw new Error("The model's reply had no Q:/A: pairs. Try again or pick a larger model.");
			const questions = attachTopics(pairs, quizTopics);
			const section = renderQuizSection(date, questions);
			const current = await this.app.vault.read(file);
			const sep = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
			await this.app.vault.modify(file, current + sep + section);
			notice.hide();
			new Notice(`${questions.length} questions added under "Quiz ${date}"${truncated ? " (topic text was trimmed to fit the context window)" : ""}.`);
		} catch (err) {
			notice.hide();
			new Notice(explainOllamaError(err, this.settings.model, this.settings.ollamaUrl), 10000);
		}
	}

	async recordResults(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		let plan: Plan;
		try {
			plan = parsePlanNote(content);
		} catch (err) {
			new Notice((err as Error).message, 8000);
			return;
		}
		const results = latestQuiz(content);
		if (results.length === 0) {
			new Notice("No quiz in this plan yet. Run Today's quiz first, then tick the questions you got right.");
			return;
		}
		const items = plan.days.flatMap((d) => d.items);
		const weak = weakTopicTitles(results, items);
		const withWeak = addWeakTopics(content, weak);
		const rebuilt = rebuildPlan(withWeak, today());
		if (rebuilt !== content) await this.app.vault.modify(file, rebuilt);
		const right = results.filter((r) => r.correct).length;
		const outcome = !weak.length ? " No weak topics; plan unchanged." : rebuilt !== withWeak ? ` Weak topics added: ${weak.join(", ")}. Plan rebuilt from today.` : ` Weak topics added: ${weak.join(", ")}. No study days left to rebuild.`;
		new Notice(`${right}/${results.length} right.${outcome}`, 8000);
	}

	async exportFlashcards(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		let plan: Plan;
		try {
			plan = parsePlanNote(content);
		} catch (err) {
			new Notice((err as Error).message, 8000);
			return;
		}
		const cards = flashcards(content);
		if (cards.length === 0) {
			new Notice("No quiz questions to export yet.");
			return;
		}
		const path = normalizePath(`${this.settings.flashcardsFolder}/${plan.meta.course.replace(/[\\/:*?"<>|#^[\]]/g, "")}.md`);
		const existing = this.vault.exists(path) ? await this.vault.read(path) : "";
		const merged = mergeFlashcards(existing, cards, flashcardsHeader(this.settings.flashcardsTag, plan.meta.course));
		if (merged === existing) {
			new Notice("Flashcards are already up to date.");
			return;
		}
		await writeNote(this.vault, path, merged);
		new Notice(`Exported ${cards.length} cards to ${path}.`);
	}

	// ---------------------------------------------------------------- helpers

	/** The open note when it is a plan (frontmatter has exam and date). */
	private activePlanFile(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") return null;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return fm && typeof fm.exam === "string" && fm.date ? file : null;
	}

	/** The plan whose date range contains today, when exactly one does. */
	private async planForToday(): Promise<TFile | null> {
		const date = today();
		const candidates: TFile[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(`${this.settings.examsFolder}/`)) continue;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (!fm || typeof fm.exam !== "string" || !fm.date) continue;
			const start = typeof fm.start_date === "string" ? fm.start_date : "";
			const end = String(fm.date);
			if ((!start || start <= date) && date < end) candidates.push(f);
		}
		return candidates.length === 1 ? candidates[0] : null;
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<ExamCompanionSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
