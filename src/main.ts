import {
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
} from "obsidian";
import { BeeminderApi } from "./beeminder-api";
import {
  BeeminderSyncSettingTab,
  type BeeminderSyncSettings,
  type SyncedDatapoint,
  DEFAULT_SETTINGS,
} from "./settings";
import { BeeminderSuggest } from "./suggest";

// Regex to match the 🐝 annotation in a task line
// Matches: 🐝 goalname or 🐝 goalname=number
const BEE_REGEX = /🐝\s+(\S+?)(?:=(\d+(?:\.\d+)?))?(?:\s|$)/;

// Matches a task checkbox line
const TASK_LINE_REGEX = /^(\s*)([-*+]|\d+[.)]) \[([^\]])\]\s+(.*)$/u;

// Tasks plugin trailing metadata — used to insert 🐝 before these
const TASKS_TRAILING_METADATA_REGEX =
  /\s(?=(?:#\S+|(?:🔺|⏫|🔼|🔽|⏬|🛫|➕|⏳|📅|✅|❌|🔁|🏁|⛔|🆔)\b))/u;

interface ParsedTask {
  lineNumber: number;
  line: string;
  isDone: boolean;
  goalSlug: string | null;
  value: number;
}

interface FileSnapshot {
  tasks: Map<number, ParsedTask>;
}

function parseTaskLine(line: string, lineNumber: number): ParsedTask | null {
  const match = line.match(TASK_LINE_REGEX);
  if (!match) return null;

  const status = match[3];
  const content = match[4];
  const beeMatch = content.match(BEE_REGEX);

  return {
    lineNumber,
    line,
    isDone: status.toLowerCase() === "x",
    goalSlug: beeMatch ? beeMatch[1] : null,
    value: beeMatch?.[2] ? parseFloat(beeMatch[2]) : 1,
  };
}

function buildSnapshot(content: string): FileSnapshot {
  const lines = content.split("\n");
  const tasks = new Map<number, ParsedTask>();
  lines.forEach((line, i) => {
    const parsed = parseTaskLine(line, i);
    if (parsed) tasks.set(i, parsed);
  });
  return { tasks };
}

function buildTaskIdentity(task: ParsedTask): string {
  return JSON.stringify({
    line: task.line,
    isDone: task.isDone,
    goalSlug: task.goalSlug,
    value: task.value,
  });
}

/**
 * Insert a beeminder marker before any Tasks plugin trailing metadata,
 * so it doesn't confuse the Tasks parser.
 */
export function insertBeeminderMarker(line: string, markerText: string): string {
  if (line.includes("🐝")) return line;

  const match = line.match(TASKS_TRAILING_METADATA_REGEX);
  if (!match || match.index === undefined) {
    return `${line} ${markerText}`;
  }
  return `${line.slice(0, match.index)} ${markerText}${line.slice(match.index)}`;
}

export default class BeeminderSyncPlugin extends Plugin {
  settings: BeeminderSyncSettings = DEFAULT_SETTINGS;
  api: BeeminderApi = new BeeminderApi(() => this.getToken());
  private fileSnapshots = new Map<string, FileSnapshot>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerEditorSuggest(new BeeminderSuggest(this));
    this.addSettingTab(new BeeminderSyncSettingTab(this.app, this));

    // Capture initial snapshots of all markdown files
    await this.captureInitialSnapshots();

    // Primary detection: vault modify event (works across all editing modes)
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (file instanceof TFile && file.extension === "md") {
          this.handleFileModify(file);
        }
      })
    );

    // Handle file renames — migrate synced datapoint keys
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          const prev = this.fileSnapshots.get(oldPath);
          this.fileSnapshots.delete(oldPath);
          if (prev) this.fileSnapshots.set(file.path, prev);
          this.migrateSyncKeysForRename(oldPath, file.path);
        }
      })
    );

    // Handle file deletes — clean up synced datapoint keys
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.fileSnapshots.delete(file.path);
          this.removeSyncKeysForFile(file.path);
        }
      })
    );

    this.addCommand({
      id: "insert-beeminder-marker",
      name: "Insert Beeminder marker on current task",
      editorCallback: (editor) => {
        const lineNumber = editor.getCursor().line;
        const line = editor.getLine(lineNumber);
        if (!TASK_LINE_REGEX.test(line)) {
          new Notice("Cursor must be on a task line.");
          return;
        }
        if (line.includes("🐝")) {
          new Notice("This task already has a Beeminder marker.");
          return;
        }
        const goalSlug = this.settings.cachedGoals[0]?.slug ?? "goal";
        const updated = insertBeeminderMarker(line, `🐝 ${goalSlug}`);
        editor.replaceRange(updated, { line: lineNumber, ch: 0 }, { line: lineNumber, ch: line.length });
      },
    });

    this.addCommand({
      id: "refresh-beeminder-goals",
      name: "Refresh Beeminder goals",
      callback: async () => {
        await this.validateAndRefreshGoals();
        new Notice("Beeminder goals refreshed");
      },
    });
  }

  onunload(): void {
    this.fileSnapshots.clear();
  }

  // --- Token storage ---

  async getToken(): Promise<string | null> {
    if (!this.settings.tokenSecretId) return null;
    return this.app.secretStorage.getSecret(this.settings.tokenSecretId);
  }

  // --- Goal management ---

  async validateAndRefreshGoals(): Promise<void> {
    const user = await this.api.getUser();
    this.settings.username = user.username;
    this.settings.cachedGoals = (await this.api.getGoals(user.username)).map(
      (g) => ({ slug: g.slug, title: g.title })
    );
    await this.saveSettings();
  }

  // --- Snapshot management ---

  private async captureInitialSnapshots(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    await Promise.all(
      files.map(async (file) => {
        try {
          const content = await this.app.vault.cachedRead(file);
          this.fileSnapshots.set(file.path, buildSnapshot(content));
        } catch {
          // Ignore unreadable files during startup
        }
      })
    );
  }

  // --- File modification handling ---

  private async handleFileModify(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    const currentSnapshot = buildSnapshot(content);
    const previousSnapshot = this.fileSnapshots.get(file.path);
    this.fileSnapshots.set(file.path, currentSnapshot);

    if (!previousSnapshot) return;

    const { unmatchedPreviousTasks, unmatchedCurrentTasks } = await this.migrateSyncKeysForMovedTasks(
      file.path,
      previousSnapshot,
      currentSnapshot
    );

    for (const prevTask of unmatchedPreviousTasks) {
      if (!prevTask.goalSlug || !prevTask.isDone) continue;
      await this.undoTaskCompletion(file, prevTask);
    }

    for (const currentTask of unmatchedCurrentTasks) {
      if (!currentTask.goalSlug || !currentTask.isDone) continue;
      await this.syncTaskCompletion(file, currentTask);
    }
  }

  private async syncTaskCompletion(file: TFile, task: ParsedTask): Promise<void> {
    if (!this.settings.username) {
      new Notice("Beeminder: Validate your token in settings before syncing.");
      return;
    }

    const syncKey = this.buildSyncKey(file.path, task.lineNumber, task.line);
    if (this.settings.syncedDatapoints[syncKey]) return; // Already synced

    const comment = `via obsidian file ${file.basename}: ${task.line.trim()}`;
    const requestId = `obsidian-tasks:${syncKey}`.slice(0, 250);

    try {
      const datapointId = await this.api.createDatapoint(
        this.settings.username,
        task.goalSlug!,
        { value: task.value, comment, requestid: requestId }
      );
      this.settings.syncedDatapoints[syncKey] = {
        goalSlug: task.goalSlug!,
        datapointId,
        requestId,
      };
      await this.saveSettings();

      if (this.settings.showNotifications) {
        new Notice(`🐝 Synced +${task.value} to ${task.goalSlug}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      new Notice(`🐝 Sync failed: ${msg}`);
      console.error("Beeminder sync failed", { error: e, file: file.path, task });
    }
  }

  private async undoTaskCompletion(file: TFile, task: ParsedTask): Promise<void> {
    if (!this.settings.username || !task.goalSlug) return;

    const syncKey = this.buildSyncKey(file.path, task.lineNumber, task.line);
    const synced = this.settings.syncedDatapoints[syncKey];
    if (!synced) return;

    try {
      await this.api.deleteDatapoint(this.settings.username, synced.goalSlug, synced.datapointId);
      delete this.settings.syncedDatapoints[syncKey];
      await this.saveSettings();

      if (this.settings.showNotifications) {
        new Notice(`🐝 Removed datapoint from ${synced.goalSlug}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      new Notice(`🐝 Undo failed: ${msg}`);
      console.error("Beeminder undo failed", { error: e, file: file.path, task });
    }
  }

  // --- Sync key management ---

  private buildSyncKey(filePath: string, lineNumber: number, line: string): string {
    return JSON.stringify({ filePath, lineNumber, line });
  }

  private parseSyncKey(key: string): { filePath: string; lineNumber: number; line: string } | null {
    try {
      const p = JSON.parse(key);
      if (typeof p.filePath === "string" && typeof p.lineNumber === "number" && typeof p.line === "string") {
        return p;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async migrateSyncKeysForMovedTasks(
    filePath: string,
    previousSnapshot: FileSnapshot,
    currentSnapshot: FileSnapshot
  ): Promise<{ unmatchedPreviousTasks: ParsedTask[]; unmatchedCurrentTasks: ParsedTask[] }> {
    const previousByIdentity = new Map<string, ParsedTask[]>();
    const previousTasks = Array.from(previousSnapshot.tasks.values());
    const currentTasks = Array.from(currentSnapshot.tasks.values());

    for (const task of previousTasks) {
      const identity = buildTaskIdentity(task);
      const matches = previousByIdentity.get(identity) ?? [];
      matches.push(task);
      previousByIdentity.set(identity, matches);
    }

    const matchedPreviousTasks = new Set<ParsedTask>();
    const matchedCurrentTasks = new Set<ParsedTask>();
    let changed = false;
    const migrated = { ...this.settings.syncedDatapoints };

    for (const currentTask of currentTasks) {
      const identity = buildTaskIdentity(currentTask);
      const matches = previousByIdentity.get(identity);
      if (!matches?.length) continue;

      const previousTask = matches.shift()!;
      matchedPreviousTasks.add(previousTask);
      matchedCurrentTasks.add(currentTask);

      if (previousTask.lineNumber === currentTask.lineNumber) continue;

      const oldKey = this.buildSyncKey(filePath, previousTask.lineNumber, previousTask.line);
      const newKey = this.buildSyncKey(filePath, currentTask.lineNumber, currentTask.line);
      const synced = migrated[oldKey];
      if (!synced || migrated[newKey]) continue;

      migrated[newKey] = {
        ...synced,
        requestId: `obsidian-tasks:${newKey}`.slice(0, 250),
      };
      delete migrated[oldKey];
      changed = true;
    }

    if (changed) {
      this.settings.syncedDatapoints = migrated;
      await this.saveSettings();
    }

    return {
      unmatchedPreviousTasks: previousTasks.filter((task) => !matchedPreviousTasks.has(task)),
      unmatchedCurrentTasks: currentTasks.filter((task) => !matchedCurrentTasks.has(task)),
    };
  }

  private async migrateSyncKeysForRename(oldPath: string, newPath: string): Promise<void> {
    let changed = false;
    const migrated: Record<string, SyncedDatapoint> = {};

    for (const [key, value] of Object.entries(this.settings.syncedDatapoints)) {
      const parsed = this.parseSyncKey(key);
      if (parsed?.filePath === oldPath) {
        const newKey = this.buildSyncKey(newPath, parsed.lineNumber, parsed.line);
        migrated[newKey] = { ...value, requestId: `obsidian-tasks:${newKey}`.slice(0, 250) };
        changed = true;
      } else {
        migrated[key] = value;
      }
    }

    if (changed) {
      this.settings.syncedDatapoints = migrated;
      await this.saveSettings();
    }
  }

  private async removeSyncKeysForFile(filePath: string): Promise<void> {
    let changed = false;
    const remaining: Record<string, SyncedDatapoint> = {};

    for (const [key, value] of Object.entries(this.settings.syncedDatapoints)) {
      const parsed = this.parseSyncKey(key);
      if (parsed?.filePath === filePath) {
        changed = true;
      } else {
        remaining[key] = value;
      }
    }

    if (changed) {
      this.settings.syncedDatapoints = remaining;
      await this.saveSettings();
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Number.isInteger(this.settings.autocompleteMinMatchLength) || this.settings.autocompleteMinMatchLength < 0) {
      this.settings.autocompleteMinMatchLength = DEFAULT_SETTINGS.autocompleteMinMatchLength;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
