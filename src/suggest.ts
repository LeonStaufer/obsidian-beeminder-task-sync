import {
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  TFile,
} from "obsidian";
import type BeeminderSyncPlugin from "./main";
import { insertBeeminderMarker } from "./main";

interface BeeminderSuggestion {
  label: string;
  insertText: string;
}

const TASK_LINE_REGEX = /^(\s*)([-*+]|\d+[.)]) \[([^\]])\]\s+(.*)$/u;
const UNFILTERED_QUERIES = new Set(["", "b", "be", "bee", "beem", "beemi", "beemin", "beemind", "beeminde", "beeminder", "goal", "🐝"]);

export class BeeminderSuggest extends EditorSuggest<BeeminderSuggestion> {
  private plugin: BeeminderSyncPlugin;

  // eslint-disable-next-line obsidianmd/prefer-active-doc
  constructor(plugin: BeeminderSyncPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    _file: TFile | null
  ): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);

    // Only trigger on task lines
    if (!TASK_LINE_REGEX.test(line)) return null;

    const textUpToCursor = line.slice(0, cursor.ch);

    // Match the last word being typed
    const wordMatch = textUpToCursor.match(/(?:^|\s)([^\s]*)$/u);
    const query = wordMatch?.[1] ?? "";
    const queryStart = cursor.ch - query.length;

    // Suppress autocomplete if the line already has a Beeminder marker
    // somewhere other than the trigger token currently being typed.
    const existingMarkerIndex = line.indexOf("🐝");
    if (existingMarkerIndex !== -1 && existingMarkerIndex !== queryStart) {
      return null;
    }

    const minMatchLength = this.plugin.settings.autocompleteMinMatchLength;

    // Trigger on 🐝 emoji immediately, or on text triggers once the configured minimum is met.
    const lowerQuery = query.toLowerCase();
    const isTrigger =
      query.startsWith("🐝") ||
      (query.length >= minMatchLength &&
        (
          (query.length === 0) ||
          ("beeminder".startsWith(lowerQuery) && lowerQuery.startsWith("b")) ||
          lowerQuery === "goal"
        ));

    if (!isTrigger) return null;

    return {
      start: { line: cursor.line, ch: cursor.ch - query.length },
      end: cursor,
      query,
    };
  }

  getSuggestions(context: EditorSuggestContext): BeeminderSuggestion[] {
    const goals = this.plugin.settings.cachedGoals;
    const normalizedQuery = context.query.toLowerCase().replace(/^🐝\s*/, "").trim();
    const shouldFilter = !UNFILTERED_QUERIES.has(context.query.toLowerCase()) && normalizedQuery.length > 0;

    const goalSuggestions = goals
      .filter((goal) => {
        if (!shouldFilter) return true;
        const haystack = `${goal.slug} ${goal.title ?? ""}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .slice(0, 8)
      .map((goal) => ({
        label: `🐝 ${goal.slug}`,
        insertText: `🐝 ${goal.slug}`,
      }));

    return [
      { label: "🐝 Beeminder (custom)", insertText: "🐝 goal=1" },
      ...goalSuggestions,
    ];
  }

  renderSuggestion(suggestion: BeeminderSuggestion, el: HTMLElement): void {
    el.setText(suggestion.label);
  }

  selectSuggestion(
    suggestion: BeeminderSuggestion,
    _evt: MouseEvent | KeyboardEvent
  ): void {
    if (!this.context) return;

    const { editor, start, end } = this.context;
    const line = editor.getLine(start.line);

    // Remove the typed query and insert marker in the right position
    const replaced = line.slice(0, start.ch) + line.slice(end.ch);
    const updatedLine = insertBeeminderMarker(replaced.trimEnd(), suggestion.insertText);

    editor.replaceRange(
      updatedLine,
      { line: start.line, ch: 0 },
      { line: start.line, ch: line.length }
    );

    this.close();
  }
}
