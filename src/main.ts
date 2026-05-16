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
  normalizeSettings,
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
  /** Index among tasks with identical line content in the same file (0-based). */
  ordinal: number;
}

interface FileSnapshot {
  tasks: Map<number, ParsedTask>;
}

function parseTaskLine(line: string, lineNumber: number): Omit<ParsedTask, "ordinal"> | null {
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
  const ordinalByLine = new Map<string, number>();
  lines.forEach((line, i) => {
    const parsed = parseTaskLine(line, i);
    if (!parsed) return;
    const ordinal = ordinalByLine.get(parsed.line) ?? 0;
    ordinalByLine.set(parsed.line, ordinal + 1);
    tasks.set(i, { ...parsed, ordinal });
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

function diffSnapshots(
  previousSnapshot: FileSnapshot,
  currentSnapshot: FileSnapshot
): { unmatchedPreviousTasks: ParsedTask[]; unmatchedCurrentTasks: ParsedTask[] } {
  const previousByIdentity = new Map<string, ParsedTask[]>();
  for (const task of previousSnapshot.tasks.values()) {
    const id = buildTaskIdentity(task);
    const list = previousByIdentity.get(id) ?? [];
    list.push(task);
    previousByIdentity.set(id, list);
  }

  const matchedPrevious = new Set<ParsedTask>();
  const matchedCurrent = new Set<ParsedTask>();

  for (const current of currentSnapshot.tasks.values()) {
    const id = buildTaskIdentity(current);
    const matches = previousByIdentity.get(id);
    if (!matches?.length) continue;
    matchedPrevious.add(matches.shift()!);
    matchedCurrent.add(current);
  }

  return {
    unmatchedPreviousTasks: [...previousSnapshot.tasks.values()].filter((t) => !matchedPrevious.has(t)),
    unmatchedCurrentTasks: [...currentSnapshot.tasks.values()].filter((t) => !matchedCurrent.has(t)),
  };
}

function parseLegacySyncKey(
  key: string
): { filePath: string; lineNumber: number; line: string } | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!parsed || typeof parsed !== "object") return null;
    const c = parsed as Record<string, unknown>;
    if (
      typeof c.filePath === "string" &&
      typeof c.lineNumber === "number" &&
      typeof c.line === "string"
    ) {
      return { filePath: c.filePath, lineNumber: c.lineNumber, line: c.line };
    }
    return null;
  } catch {
    return null;
  }
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
    // Convert any legacy {filePath, lineNumber, line} syncKeys to the
    // content-based {filePath, line, ordinal} shape.
    await this.migrateLegacySyncKeys();

    // Primary detection: vault modify event (works across all editing modes)
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (file instanceof TFile && file.extension === "md") {
          void this.handleFileModify(file);
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
          void this.migrateSyncKeysForRename(oldPath, file.path);
        }
      })
    );

    // Handle file deletes — clean up synced datapoint keys
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.fileSnapshots.delete(file.path);
          void this.removeSyncKeysForFile(file.path);
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
        new Notice("Beeminder goals refreshed.");
      },
    });
  }

  onunload(): void {
    this.fileSnapshots.clear();
  }

  // --- Token storage ---

  getToken(): Promise<string | null> {
    if (!this.settings.tokenSecretId) return Promise.resolve(null);
    return Promise.resolve(this.app.secretStorage.getSecret(this.settings.tokenSecretId));
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

    const { unmatchedPreviousTasks, unmatchedCurrentTasks } = diffSnapshots(
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
      new Notice("Validate your Beeminder token in settings before syncing.");
      return;
    }

    const syncKey = this.buildSyncKey(file.path, task.line, task.ordinal);
    if (this.settings.syncedDatapoints[syncKey]) return; // Already synced

    const comment = `via obsidian file ${file.basename}: ${task.line.trim()}`;
    const requestId = this.buildRequestId(syncKey);

    try {
      const { id: datapointId, alreadyExisted } = await this.api.createDatapoint(
        this.settings.username,
        task.goalSlug!,
        { value: task.value, comment, requestid: requestId }
      );
      this.settings.syncedDatapoints[syncKey] = {
        goalSlug: task.goalSlug!,
        datapointId,
      };
      await this.saveSettings();

      // Suppress notice when Beeminder returned an existing datapoint — this is
      // another device's sync arriving via file sync, not the local user's action.
      if (this.settings.showNotifications && !alreadyExisted) {
        new Notice(`🐝 Synced +${task.value} to ${task.goalSlug}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      new Notice(`🐝 Sync failed: ${msg}`);
      console.error("Beeminder sync failed", { error: e, file: file.path, task });
    }
  }

  private async undoTaskCompletion(file: TFile, task: ParsedTask): Promise<void> {
    if (!this.settings.username || !task.goalSlug) return;

    const syncKey = this.buildSyncKey(file.path, task.line, task.ordinal);
    const synced = this.settings.syncedDatapoints[syncKey];
    if (!synced) return;

    try {
      await this.api.deleteDatapoint(this.settings.username, synced.goalSlug, synced.datapointId);
      delete this.settings.syncedDatapoints[syncKey];
      await this.saveSettings();

      if (this.settings.showNotifications) {
        new Notice(`🐝 Removed datapoint from ${synced.goalSlug}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      new Notice(`🐝 Undo failed: ${msg}`);
      console.error("Beeminder undo failed", { error: e, file: file.path, task });
    }
  }

  // --- Sync key management ---

  private buildSyncKey(filePath: string, line: string, ordinal: number): string {
    return JSON.stringify({ filePath, line, ordinal });
  }

  private buildRequestId(syncKey: string): string {
    return `obsidian-tasks:${syncKey}`.slice(0, 250);
  }

  private parseSyncKey(key: string): { filePath: string; line: string; ordinal: number } | null {
    try {
      const parsed: unknown = JSON.parse(key);
      if (!parsed || typeof parsed !== "object") return null;

      const c = parsed as Record<string, unknown>;
      if (
        typeof c.filePath === "string" &&
        typeof c.line === "string" &&
        typeof c.ordinal === "number"
      ) {
        return { filePath: c.filePath, line: c.line, ordinal: c.ordinal };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Migrate legacy line-number-based syncKeys to the content-based shape.
   * Legacy keys were {filePath, lineNumber, line}; new keys are
   * {filePath, line, ordinal}. We use the current file snapshots to
   * resolve ordinals. Entries we can't resolve (file gone, line gone)
   * are dropped — the catch-up flow will recover them via the 422 path
   * the next time the task is touched.
   */
  private async migrateLegacySyncKeys(): Promise<void> {
    interface LegacyEntry {
      key: string;
      lineNumber: number;
      line: string;
      value: SyncedDatapoint;
    }

    const migrated: Record<string, SyncedDatapoint> = {};
    const legacyByFile = new Map<string, LegacyEntry[]>();
    let changed = false;

    for (const [key, value] of Object.entries(this.settings.syncedDatapoints)) {
      if (this.parseSyncKey(key)) {
        // Already current format.
        migrated[key] = value;
        continue;
      }
      const legacy = parseLegacySyncKey(key);
      if (!legacy) {
        // Unparseable — drop it.
        changed = true;
        continue;
      }
      const list = legacyByFile.get(legacy.filePath) ?? [];
      list.push({ key, lineNumber: legacy.lineNumber, line: legacy.line, value });
      legacyByFile.set(legacy.filePath, list);
      changed = true;
    }

    for (const [filePath, entries] of legacyByFile) {
      const snapshot = this.fileSnapshots.get(filePath);
      if (!snapshot) continue; // file gone — drop entries

      // Group current tasks by line content so we can claim them in file order.
      const tasksByLine = new Map<string, ParsedTask[]>();
      for (const task of snapshot.tasks.values()) {
        const list = tasksByLine.get(task.line) ?? [];
        list.push(task);
        tasksByLine.set(task.line, list);
      }

      // Prefer exact lineNumber matches first so identical lines map predictably.
      const ordered = [...entries].sort((a, b) => a.lineNumber - b.lineNumber);
      for (const entry of ordered) {
        const candidates = tasksByLine.get(entry.line);
        if (!candidates?.length) continue; // line gone — drop
        const task = candidates.shift()!;
        const newKey = this.buildSyncKey(filePath, task.line, task.ordinal);
        if (!migrated[newKey]) {
          migrated[newKey] = entry.value;
        }
      }
    }

    if (changed) {
      this.settings.syncedDatapoints = migrated;
      await this.saveSettings();
    }
  }

  private async migrateSyncKeysForRename(oldPath: string, newPath: string): Promise<void> {
    let changed = false;
    const migrated: Record<string, SyncedDatapoint> = {};

    for (const [key, value] of Object.entries(this.settings.syncedDatapoints)) {
      const parsed = this.parseSyncKey(key);
      if (parsed?.filePath === oldPath) {
        const newKey = this.buildSyncKey(newPath, parsed.line, parsed.ordinal);
        migrated[newKey] = value;
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
    this.settings = normalizeSettings(await this.loadData());
    if (!Number.isInteger(this.settings.autocompleteMinMatchLength) || this.settings.autocompleteMinMatchLength < 0) {
      this.settings.autocompleteMinMatchLength = DEFAULT_SETTINGS.autocompleteMinMatchLength;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
