import { App, Modal, Setting } from "obsidian";
import { today } from "./core/dates";
import { courseNameFor, validateRequest, type ExamRequest } from "./core/exam";

/** Asks for the course folder, exam name, dates and daily minutes. Resolves null when cancelled. */
export class PlanModal extends Modal {
	private resolve!: (r: ExamRequest | null) => void;
	readonly result: Promise<ExamRequest | null>;
	private done = false;
	private req: ExamRequest;
	private errorEl: HTMLElement | null = null;

	constructor(
		app: App,
		private folders: string[],
		initial: { courseFolder: string; minutesPerDay: number },
	) {
		super(app);
		this.req = { courseFolder: initial.courseFolder, exam: "", examDate: "", startDate: today(), minutesPerDay: initial.minutesPerDay };
		this.result = new Promise((res) => (this.resolve = res));
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("exam-modal");
		titleEl.setText("Plan an exam");
		contentEl.createEl("p", {
			cls: "exam-modal-help",
			text: "Every ## section of the notes in the course folder becomes a topic (a Lecture Companion lecture note is one topic). Each topic gets a first pass and a review a few days later; the last two days are mixed review. The plan is written as a checklist note you can edit.",
		});

		const listId = "exam-companion-folders";
		const datalist = contentEl.createEl("datalist", { attr: { id: listId } });
		for (const f of this.folders) datalist.createEl("option", { value: f });

		new Setting(contentEl)
			.setName("Course folder")
			.setDesc("Folder with the course notes (Lecture Companion's course folder works as is).")
			.addText((t) => {
				t.setPlaceholder("Courses/CSCI 470").setValue(this.req.courseFolder).onChange((v) => (this.req.courseFolder = v.trim()));
				t.inputEl.setAttribute("list", listId);
				t.inputEl.addClass("exam-modal-wide");
			});

		new Setting(contentEl)
			.setName("Exam name")
			.addText((t) => t.setPlaceholder("Midterm 2").onChange((v) => (this.req.exam = v)));

		new Setting(contentEl)
			.setName("Exam date")
			.setDesc("YYYY-MM-DD")
			.addText((t) => {
				t.inputEl.type = "date";
				t.onChange((v) => (this.req.examDate = v));
			});

		new Setting(contentEl)
			.setName("Start date")
			.setDesc("Defaults to today.")
			.addText((t) => {
				t.inputEl.type = "date";
				t.setValue(this.req.startDate).onChange((v) => (this.req.startDate = v || today()));
			});

		new Setting(contentEl)
			.setName("Minutes per day")
			.addSlider((s) =>
				s
					.setLimits(10, 240, 5)
					.setValue(this.req.minutesPerDay)
					.onChange((v) => (this.req.minutesPerDay = v)),
			);

		this.errorEl = contentEl.createEl("p", { cls: "exam-modal-error" });

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)))
			.addButton((b) =>
				b
					.setButtonText("Create plan")
					.setCta()
					.onClick(() => {
						const problem = validateRequest(this.req, today());
						if (problem) {
							this.errorEl?.setText(problem);
							return;
						}
						this.req.course = courseNameFor(this.req.courseFolder);
						this.finish(this.req);
					}),
			);
	}

	private finish(r: ExamRequest | null): void {
		if (this.done) return;
		this.done = true;
		this.resolve(r);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(null);
	}
}
