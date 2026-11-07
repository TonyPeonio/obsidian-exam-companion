import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { NoteInfo, VaultAccess } from "./core/vault";

/** `VaultAccess` over the live Obsidian vault. */
export class ObsidianVault implements VaultAccess {
	constructor(private app: App) {}

	listNotes(): NoteInfo[] {
		return this.app.vault.getMarkdownFiles().map((f) => ({
			path: f.path,
			basename: f.basename,
			folder: f.parent?.path === "/" ? "" : (f.parent?.path ?? ""),
			mtime: f.stat.mtime,
		}));
	}

	listFolders(): string[] {
		const out: string[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					if (!child.path.startsWith(this.app.vault.configDir)) {
						out.push(child.path);
						walk(child);
					}
				}
			}
		};
		walk(this.app.vault.getRoot());
		return out.sort((a, b) => a.localeCompare(b));
	}

	private file(path: string): TFile | null {
		return this.app.vault.getFileByPath(normalizePath(path));
	}

	exists(path: string): boolean {
		return this.file(path) !== null;
	}

	async read(path: string): Promise<string> {
		const f = this.file(path);
		if (!f) throw new Error(`Note not found: ${path}`);
		return this.app.vault.cachedRead(f);
	}

	async create(path: string, content: string): Promise<void> {
		const normalized = normalizePath(path);
		const dir = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
		if (dir && !this.app.vault.getFolderByPath(dir)) await this.app.vault.createFolder(dir);
		await this.app.vault.create(normalized, content);
	}

	async modify(path: string, content: string): Promise<void> {
		const f = this.file(path);
		if (!f) throw new Error(`Note not found: ${path}`);
		await this.app.vault.modify(f, content);
	}
}
