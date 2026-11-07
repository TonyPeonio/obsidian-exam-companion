/**
 * Everything the core needs from the vault, so the planner and quiz code run without
 * Obsidian (the plugin layer implements it over `app.vault`; tests use an in-memory fake).
 */

export interface NoteInfo {
	/** Vault-relative path including `.md`. */
	path: string;
	/** File name without the extension. */
	basename: string;
	/** Parent folder, "" for the vault root. */
	folder: string;
	mtime: number;
}

export interface VaultAccess {
	listNotes(): NoteInfo[];
	/** Every folder path in the vault ("" for the root is not included). */
	listFolders(): string[];
	exists(path: string): boolean;
	read(path: string): Promise<string>;
	create(path: string, content: string): Promise<void>;
	modify(path: string, content: string): Promise<void>;
}

/** Notes inside `folder` (recursive); the vault root when `folder` is "". */
export function notesInFolder(vault: VaultAccess, folder: string): NoteInfo[] {
	const prefix = folder.replace(/^\/+|\/+$/g, "");
	return vault
		.listNotes()
		.filter((n) => (prefix ? n.path.startsWith(prefix + "/") : true))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** Creates or overwrites. */
export async function writeNote(vault: VaultAccess, path: string, content: string): Promise<void> {
	if (vault.exists(path)) await vault.modify(path, content);
	else await vault.create(path, content);
}
