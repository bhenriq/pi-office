#!/usr/bin/env node
/**
 * Link pi's own packages into ./node_modules so that `npm run typecheck` and
 * `node scripts/preview.ts` resolve `@earendil-works/pi-tui` and friends.
 *
 * pi loads extensions with its own resolver, so the extension itself does not
 * need these. Local tooling does, and linking the installed versions keeps the
 * types honest instead of pinning a copy in package.json.
 *
 * Runs automatically via `npm run prepare`; safe to run repeatedly.
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TARGET = join(ROOT, "node_modules", "@earendil-works");

/** Managed layout: <agent>/install/current-version → install/releases/<v>/node_modules */
function managedPackagesDir() {
  const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const versionFile = join(agentDir, "install", "current-version");
  if (!existsSync(versionFile)) return undefined;

  const version = readFileSync(versionFile, "utf8").trim();
  if (!version) return undefined;

  const dir = join(agentDir, "install", "releases", version, "node_modules", "@earendil-works");
  return existsSync(dir) ? dir : undefined;
}

/** Fallback: walk up from the `pi` executable looking for node_modules. */
function packagesDirNearBinary() {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@earendil-works/pi-coding-agent", {
      paths: [process.env.PI_BIN_DIR ?? process.cwd(), process.execPath],
    });
    let dir = resolve(entry);
    while (dir !== "/" && dir !== ".") {
      const candidate = join(dir, "node_modules", "@earendil-works");
      if (existsSync(candidate)) return candidate;
      dir = resolve(dir, "..");
    }
  } catch {
    /* not resolvable from here */
  }
  return undefined;
}

const source = managedPackagesDir() ?? packagesDirNearBinary();

if (!source) {
  console.warn(
    "link-pi: could not find pi's @earendil-works packages.\n" +
      "  Set PI_AGENT_DIR to your pi agent directory, or skip this: the extension\n" +
      "  does not need it. Only `npm run typecheck` and `node scripts/preview.ts` do.",
  );
  process.exit(0);
}

mkdirSync(TARGET, { recursive: true });

let linked = 0;
for (const entry of readdirSync(source)) {
  if (!existsSync(join(source, entry, "package.json"))) continue;
  const link = join(TARGET, entry);
  rmSync(link, { force: true, recursive: false });
  symlinkSync(join(source, entry), link, "dir");
  linked++;
}

console.log(`link-pi: linked ${linked} packages from ${source}`);
