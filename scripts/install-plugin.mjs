import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "manifest.json");

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const vaultPathArg = process.argv[2];
  if (!vaultPathArg) {
    console.error("Usage: npm run install:vault -- /path/to/ObsidianVault");
    process.exit(1);
  }

  const vaultPath = path.resolve(vaultPathArg);
  const obsidianDir = path.join(vaultPath, ".obsidian");

  if (!(await pathExists(obsidianDir))) {
    console.error(`Not an Obsidian vault: missing ${obsidianDir}`);
    process.exit(1);
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (!manifest.id || typeof manifest.id !== "string") {
    console.error("manifest.json is missing a valid plugin id.");
    process.exit(1);
  }

  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", manifest.id);
  const filesToCopy = ["main.js", "manifest.json", "styles.css"];

  await fs.mkdir(pluginDir, { recursive: true });

  for (const fileName of filesToCopy) {
    const sourcePath = path.join(repoRoot, fileName);
    if (!(await pathExists(sourcePath))) {
      console.error(`Missing build artifact: ${sourcePath}`);
      process.exit(1);
    }

    const destinationPath = path.join(pluginDir, fileName);
    await fs.copyFile(sourcePath, destinationPath);
  }

  console.log(`Installed ${manifest.id} to ${pluginDir}`);
}

await main();
