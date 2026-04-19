# Beeminder Task Sync for Obsidian

Automatically sync task completions to [Beeminder](https://www.beeminder.com) goals. Add a 🐝 marker to any checklist item, and when you check it off, the plugin sends a datapoint to Beeminder. Uncheck it, and the datapoint is removed.

Works with plain markdown checkboxes. Compatible with the [Tasks](https://publish.obsidian.md/tasks/) plugin but does not require it.

## Setup

1. Install the plugin and enable it in **Settings > Community plugins**.
2. Go to **Settings > Beeminder Task Sync**.
3. Click **Open** to get your auth token from Beeminder.
4. Paste the token into the **Auth token** field.
5. Click **Validate** — this confirms the connection and caches your goal list for autocomplete.

The token is stored in Obsidian's secret storage when available, with a localStorage fallback on older versions.

## Usage

Add a `🐝 goalname` marker to any task:

```md
- [ ] Read chapter 5 🐝 reading
- [ ] Run 5km 🐝 exercise=5
- [ ] Write blog post 🐝 words=500 📅 2026-04-10
```

- `🐝 reading` — sends +1 to the "reading" goal when completed
- `🐝 exercise=5` — sends +5 to the "exercise" goal
- If `=value` is omitted, it defaults to 1

### Autocomplete

Type `bee`, `goal`, or `🐝` on a task line to get a dropdown of your Beeminder goals. You can also use the command **Insert Beeminder marker on current task** from the command palette.

If you're using the Tasks plugin, place the `🐝` marker before Tasks metadata (due dates, priorities, etc.) so it doesn't interfere with Tasks' parser. The autocomplete handles this automatically.

Autocomplete has a configurable minimum text trigger length in the plugin settings. By default it is `1`, which means text-based suggestions can appear after the first typed character on a task line, while typing `🐝` always triggers suggestions immediately. Set it to `0` if you want suggestions to appear on empty task lines before typing anything.

If you also use the Tasks plugin, both plugins can compete for the same suggestion slot on task lines. A lower Beeminder trigger length makes Beeminder suggestions appear more aggressively, while a higher value gives Tasks more room to show its own suggestions first.

### Undo

Unchecking a task deletes the synced datapoint from Beeminder. This works across sessions — the plugin stores the Beeminder datapoint ID locally so it can reverse the sync later.

If a task is heavily edited or moved between files before being unchecked, the plugin may not match it to the stored datapoint. In that case, delete it manually on Beeminder.

## Commands

| Command | Description |
|---|---|
| **Insert Beeminder marker on current task** | Adds a `🐝 goal` marker to the task at your cursor |
| **Refresh Beeminder goals** | Re-fetches your goal list from Beeminder |

## Building from source

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/beeminder-sync/` in your vault.

To build and install directly into a vault:

```bash
npm run install:vault -- /path/to/YourVault
```

## Releasing

To publish an Obsidian-compatible GitHub release:

1. Update `manifest.json` with the new plugin version in `x.y.z` format.
2. Commit the change.
3. Create and push a Git tag with exactly the same version string.

```bash
git tag 1.0.1
git push origin 1.0.1
```

When that tag is pushed, GitHub Actions builds the plugin and creates a release that attaches:

- `main.js`
- `manifest.json`
- `styles.css`

The workflow fails if the tag does not exactly match `manifest.json`'s `version`, which is the release format Obsidian expects.
