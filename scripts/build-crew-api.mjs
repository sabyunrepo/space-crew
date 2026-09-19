#!/usr/bin/env node
// Bundles supabase/functions/crew-api/sbp-entry.ts (handler + Postgres
// repository + shared engine/contracts/missions + zod + postgres.js) into a
// single dist-edge/crew-api/index.ts, and writes the deploy-ready file list
// to dist-edge/crew-api/files.json. Generalizes
// scripts/supabase-probe/build.mjs for the real crew-api function.
//
// Usage: CREW_PROJECT_ID=<project-uuid> node scripts/build-crew-api.mjs
//
// The self-hosted (sbp) platform forbids npm:/jsr:/https: imports and a
// deno.json import map, and the project UUID is not on its runtime env
// allowlist - see claudedocs/SUPABASE-BPRIME-PROBE.ko.md. Both constraints
// are why this script exists instead of deploying supabase/functions as-is.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const PG_VERSION = "3.4.9";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "supabase/functions/crew-api/sbp-entry.ts");
const OUT_DIR = path.join(ROOT, "dist-edge/crew-api");
const OUT_FILE = path.join(OUT_DIR, "index.ts");
const FILES_JSON = path.join(OUT_DIR, "files.json");

// Platform constraints (self-hosted sbp function deploy).
const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MiB per file
const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // 4 MiB total
const MAX_FILES = 128;
const PATH_RE = /^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*\.(ts|js|mjs|json)$/;
const FORBIDDEN_BASENAMES = new Set(["deno.json", "package.json", "import_map.json"]);

const NODE_BUILTINS = new Set(["os", "fs", "net", "tls", "crypto", "stream", "perf_hooks"]);
const forceNodePrefixPlugin = {
  name: "force-node-prefix",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (NODE_BUILTINS.has(args.path)) return { path: "node:" + args.path, external: true };
      return null;
    });
  },
};

function fetchPostgresSource() {
  const tmp = mkdtempSync(path.join(tmpdir(), "crew-api-pg-"));
  console.log(`[build] npm pack postgres@${PG_VERSION} -> ${tmp}`);
  execFileSync("npm", ["pack", `postgres@${PG_VERSION}`, "--pack-destination", tmp], { stdio: "inherit" });
  const tarball = path.join(tmp, `postgres-${PG_VERSION}.tgz`);
  execFileSync("tar", ["xzf", tarball, "-C", tmp]);
  return { tmpDir: tmp, entry: path.join(tmp, "package", "src", "index.js") };
}

async function bundlePostgres(entry, outfile) {
  console.log(`[build] esbuild bundling ${entry} -> ${outfile}`);
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile,
    plugins: [forceNodePrefixPlugin],
    // postgres.js reads the Node globals Buffer/process/setImmediate. Edge
    // Runtime 1.74 does not define a global Buffer, and a shim in the
    // importing module runs too late (imports evaluate first), so bind them
    // as module-scope imports inside the bundle itself.
    banner: {
      js: 'import { Buffer } from "node:buffer";\nimport process from "node:process";\nimport { setImmediate, clearImmediate } from "node:timers";',
    },
    legalComments: "none",
    logLevel: "info",
  });
  if (result.errors.length) throw new Error("esbuild reported errors bundling postgres.js");
}

/** Resolves the bare "postgres" import in sbp-entry.ts to the vendored
 * bundle built above, so the deployed function never contains an npm:/jsr:
 * specifier. */
function pgAliasPlugin(vendorPath) {
  return {
    name: "postgres-alias",
    setup(build) {
      build.onResolve({ filter: /^postgres$/ }, () => ({ path: vendorPath }));
    },
  };
}

async function bundleApp(vendorPath, projectId) {
  console.log(`[build] esbuild bundling ${ENTRY} -> ${OUT_FILE}`);
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile: OUT_FILE,
    minify: true,
    legalComments: "none",
    absWorkingDir: ROOT,
    define: { __CREW_PROJECT_ID__: JSON.stringify(projectId) },
    plugins: [pgAliasPlugin(vendorPath), forceNodePrefixPlugin],
    logLevel: "info",
  });
  if (result.errors.length) throw new Error("esbuild reported errors bundling crew-api");
}

function verifyBundle(text) {
  if (/\brequire\(/.test(text)) throw new Error("bundled index.ts still contains require( calls");
  if (/from\s*["'](npm:|jsr:|https?:)/.test(text)) throw new Error("bundled index.ts contains a forbidden npm:/jsr:/https: import");
  if (/__CREW_PROJECT_ID__/.test(text)) throw new Error("__CREW_PROJECT_ID__ was not substituted by esbuild define");
  console.log("[build] index.ts: no require(), no npm:/jsr:/https: imports, project id injected");
}

function validateAndPack() {
  const rel = "index.ts";
  const base = path.basename(rel);
  if (FORBIDDEN_BASENAMES.has(base)) throw new Error(`forbidden filename: ${rel}`);
  if (!PATH_RE.test(rel)) throw new Error(`path does not match required pattern ${PATH_RE}: ${rel}`);
  const stat = statSync(OUT_FILE);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`file exceeds 1 MiB: ${rel} (${stat.size} bytes)`);
  if (stat.size > MAX_TOTAL_BYTES) throw new Error(`total size exceeds 4 MiB: ${stat.size} bytes`);
  const entries = [{ path: rel, base64: readFileSync(OUT_FILE).toString("base64") }];
  if (entries.length > MAX_FILES) throw new Error(`too many files: ${entries.length} > ${MAX_FILES}`);
  return { entries, totalBytes: stat.size };
}

async function main() {
  const projectId = process.env.CREW_PROJECT_ID;
  if (!projectId) throw new Error("CREW_PROJECT_ID env var is required (the target Supabase project UUID)");
  mkdirSync(OUT_DIR, { recursive: true });

  const { tmpDir, entry } = fetchPostgresSource();
  const vendorPath = path.join(tmpDir, "postgres.bundle.js");
  try {
    await bundlePostgres(entry, vendorPath);
    await bundleApp(vendorPath, projectId);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const text = readFileSync(OUT_FILE, "utf8");
  verifyBundle(text);

  const { entries, totalBytes } = validateAndPack();
  writeFileSync(FILES_JSON, JSON.stringify(entries, null, 2) + "\n");

  console.log(`[build] index.ts: ${statSync(OUT_FILE).size} bytes`);
  console.log(`[build] ${entries.length} deploy file(s), ${totalBytes} bytes total`);
  console.log(`[build] wrote ${FILES_JSON}`);
}

main().catch((err) => {
  console.error("[build] FAILED:", err.message);
  process.exit(1);
});
