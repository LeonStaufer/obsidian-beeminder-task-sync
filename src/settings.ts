import { Notice, PluginSettingTab, SecretComponent, Setting, type App } from "obsidian";
import type BeeminderSyncPlugin from "./main";

export interface SyncedDatapoint {
  goalSlug: string;
  datapointId: string;
  requestId: string;
}

export interface BeeminderSyncSettings {
  username: string;
  tokenSecretId: string;
  cachedGoals: { slug: string; title?: string }[];
  autocompleteMinMatchLength: number;
  showNotifications: boolean;
  syncedDatapoints: Record<string, SyncedDatapoint>;
}

function isSyncedDatapoint(value: unknown): value is SyncedDatapoint {
  if (!value || typeof value !== "object") {
    return false;
  }

  const datapoint = value as Record<string, unknown>;
  return (
    typeof datapoint.goalSlug === "string" &&
    typeof datapoint.datapointId === "string" &&
    typeof datapoint.requestId === "string"
  );
}

export function normalizeSettings(data: unknown): BeeminderSyncSettings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  if (!data || typeof data !== "object") {
    return settings;
  }

  const raw = data as Record<string, unknown>;

  if (typeof raw.username === "string") {
    settings.username = raw.username;
  }
  if (typeof raw.tokenSecretId === "string") {
    settings.tokenSecretId = raw.tokenSecretId;
  }
  if (Array.isArray(raw.cachedGoals)) {
    settings.cachedGoals = raw.cachedGoals
      .filter((goal): goal is { slug: string; title?: string } => {
        if (!goal || typeof goal !== "object") {
          return false;
        }

        const candidate = goal as Record<string, unknown>;
        return (
          typeof candidate.slug === "string" &&
          (candidate.title === undefined || typeof candidate.title === "string")
        );
      })
      .map((goal) => ({ slug: goal.slug, title: goal.title }));
  }
  if (typeof raw.autocompleteMinMatchLength === "number" && Number.isInteger(raw.autocompleteMinMatchLength)) {
    settings.autocompleteMinMatchLength = raw.autocompleteMinMatchLength;
  }
  if (typeof raw.showNotifications === "boolean") {
    settings.showNotifications = raw.showNotifications;
  }
  if (raw.syncedDatapoints && typeof raw.syncedDatapoints === "object") {
    settings.syncedDatapoints = Object.fromEntries(
      Object.entries(raw.syncedDatapoints).filter((entry): entry is [string, SyncedDatapoint] =>
        isSyncedDatapoint(entry[1])
      )
    );
  }

  return settings;
}

export const DEFAULT_SETTINGS: BeeminderSyncSettings = {
  username: "",
  tokenSecretId: "",
  cachedGoals: [],
  autocompleteMinMatchLength: 1,
  showNotifications: true,
  syncedDatapoints: {},
};

interface UsageTip {
  title: string;
  body: string;
  code?: string;
}

const USAGE_TIPS: UsageTip[] = [
  {
    title: "Basic",
    body: "Add a 🐝 annotation to any task to send a datapoint when that task is completed.",
    code: "- [ ] Read chapter 5 🐝 reading",
  },
  {
    title: "Custom value",
    body: "Use =number to send a custom value instead of the default +1.",
    code: "- [ ] Run 5km 🐝 exercise=5",
  },
  {
    title: "With Tasks metadata",
    body: "Place 🐝 before trailing Tasks metadata so the annotation is parsed correctly.",
    code: "- [ ] Write post 🐝 words=500 📅 2026-04-10",
  },
  {
    title: "Autocomplete",
    body: 'Type "🐝", "bee", or "goal" on a task line to get suggestions from your cached goals.',
  },
  {
    title: "Unsync",
    body: "Unchecking a synced task removes the corresponding datapoint from Beeminder.",
  },
];

export class BeeminderSyncSettingTab extends PluginSettingTab {
  plugin: BeeminderSyncPlugin;

  // eslint-disable-next-line obsidianmd/prefer-active-doc
  constructor(app: App, plugin: BeeminderSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setName("Open Beeminder")
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc("Get your auth token from Beeminder.")
      .addButton((btn) => {
        btn.setButtonText("Open").onClick(() => {
          activeWindow.open("https://www.beeminder.com/api/v1/auth_token.json", "_blank", "noopener,noreferrer");
        });
      });

    new Setting(containerEl)
      .setName("Auth token")
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc("Select or create a secret in Obsidian Keychain.")
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.tokenSecretId)
          .onChange(async (value) => {
            this.plugin.settings.tokenSecretId = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setName("Validate Beeminder token and refresh goals")
      .setDesc("Checks the token and caches your goal list for autocomplete.")
      .addButton((btn) => {
        btn.setButtonText("Validate").setCta().onClick(async () => {
          btn.setDisabled(true);
          try {
            await this.plugin.validateAndRefreshGoals();
            new Notice(`Connected as ${this.plugin.settings.username} (${this.plugin.settings.cachedGoals.length} goals)`);
            this.display();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : "Validation failed.");
          } finally {
            btn.setDisabled(false);
          }
        });
      });

    new Setting(containerEl)
      .setName("Autocomplete minimum match length")
      .setDesc("How many typed characters are required before text-based goal suggestions appear. Set to 0 to show suggestions immediately on task lines.")
      .addText((text) =>
        text
          .setPlaceholder("1")
          .setValue(String(this.plugin.settings.autocompleteMinMatchLength))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.autocompleteMinMatchLength =
              Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SETTINGS.autocompleteMinMatchLength;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show notifications")
      .setDesc("Show a notice when datapoints are synced or removed.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showNotifications)
          .onChange(async (value) => {
            this.plugin.settings.showNotifications = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Usage").setHeading();
    for (const tip of USAGE_TIPS) {
      const setting = new Setting(containerEl).setName(tip.title).setDesc(tip.body);
      if (tip.code) {
        setting.descEl.createEl("br");
        setting.descEl.createEl("code", { text: tip.code });
      }
    }
  }
}
