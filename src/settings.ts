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

  constructor(app: App, plugin: BeeminderSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Open Beeminder")
      .setDesc("Get your auth token from Beeminder.")
      .addButton((btn) => {
        btn.setButtonText("Open").onClick(() => {
          window.open("https://www.beeminder.com/api/v1/auth_token.json", "_blank", "noopener,noreferrer");
        });
      });

    new Setting(containerEl)
      .setName("Auth token")
      .setDesc("Select or create a secret in Obsidian SecretStorage.")
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.tokenSecretId)
          .onChange(async (value) => {
            this.plugin.settings.tokenSecretId = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Validate token & refresh goals")
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
