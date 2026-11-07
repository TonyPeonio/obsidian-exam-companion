export interface ExamCompanionSettings {
	ollamaUrl: string;
	model: string;
	numCtx: number;
	/** Reasoning on thinking-capable models; off by default (quizzes are short and many). */
	thinking: boolean;
	temperature: number;
	questionsPerQuiz: number;
	examsFolder: string;
	flashcardsFolder: string;
	minutesPerDay: number;
	lastCourseFolder: string;
}

export const DEFAULT_SETTINGS: ExamCompanionSettings = {
	ollamaUrl: "http://localhost:11434",
	model: "qwen3.5:9b",
	numCtx: 16384,
	thinking: false,
	temperature: 0.6,
	questionsPerQuiz: 5,
	examsFolder: "Exams",
	flashcardsFolder: "Flashcards",
	minutesPerDay: 45,
	lastCourseFolder: "",
};
