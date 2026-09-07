#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { buildVersion } from "./version-info.mjs";

const root = new URL("../", import.meta.url);
const info = buildVersion(root, process.env.ODW_RELEASE_TAG || "");
mkdirSync(new URL("src/", root), { recursive: true });
writeFileSync(new URL("src/version.generated.ts", root),
  "// Generated from package.json and the build checkout. Do not edit.\n" +
  `export const VERSION = ${JSON.stringify(info.version)};\n` +
  `export const BUILD_INFO = ${JSON.stringify(info)} as const;\n`);
console.error(`version: ${info.version}`);
