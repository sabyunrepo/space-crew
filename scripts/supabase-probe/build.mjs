#!/usr/bin/env node
// Builds scripts/supabase-probe/function/vendor/postgres.js from the npm
// "postgres" package (postgres.js) so the Edge Function ships with zero
// npm:/jsr:/https: imports, and writes the deploy-ready source list to
// scripts/supabase-probe/dist/files.json.
//
// Usage: node scripts/supabase-probe/build.mjs
//
// This script only touches files under scripts/supabase-probe/. It does not
// modify the repo's package.json or lockfile: the "postgres" tarball is
// fetched into an OS temp dir and discarded after bundling.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const PG_VERSION = "3.4.9";
const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FUNCTION_DIR = path.join(PROBE_DIR, "function");
const VENDOR_OUT = path.join(FUNCTION_DIR, "vendor", "postgres.js");
const DIST_DIR = path.join(PROBE_DIR, "dist");
const FILES_JSON = path.join(DIST_DIR, "files.json");

// Platform constraints for the self-hosted deploy pipeline.
const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MiB per file
const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // 4 MiB total
const MAX_FILES = 128;
const PATH_RE = /^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*\.(ts|js|mjs|json)$/;
const FORBIDDEN_BASENAMES = new Set(["deno.json", "package.json", "import_map.json"]);

// Node builtins that postgres.js imports with a bare specifier. Rewritten to
// explicit node: specifiers so the Deno-based bundler resolves them via its
// Node compatibility layer instead of trying (and failing, offline) to hit
// npm/jsr resolution.
const NODE_BUILTINS = new Set(["os", "fs", "net", "tls", "crypto", "stream", "perf_hooks"]);

const forceNodePrefixPlugin = {
  name: "force-node-prefix",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (NODE_BUILTINS.has(args.path)) {
        return { path: "node:" + args.path, external: true };
      }
      return null;
    });
  },
};

function fetchPostgresSource() {
  const tmp = mkdtempSync(path.join(tmpdir(), "supabase-probe-pg-"));
  console.log(`[build] npm pack postgres@${PG_VERSION} -> ${tmp}`);
  execFileSync("npm", ["pack", `postgres@${PG_VERSION}`, "--pack-destination", tmp], {
    stdio: "inherit",
  });
  const tarball = path.join(tmp, `postgres-${PG_VERSION}.tgz`);
  execFileSync("tar", ["xzf", tarball, "-C", tmp]);
  return { tmpDir: tmp, entry: path.join(tmp, "package", "src", "index.js") };
}

async function bundlePostgres(entry) {
  console.log(`[build] esbuild bundling ${entry} -> ${VENDOR_OUT}`);
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile: VENDOR_OUT,
    plugins: [forceNodePrefixPlugin],
    // postgres.js reads the Node globals Buffer/process/setImmediate.
    // Edge Runtime 1.74 does not define a global Buffer, and a shim in the
    // importing module runs too late (imports evaluate first), so bind them
    // as module-scope imports inside the bundle itself.
    banner: {
      js: 'import { Buffer } from "node:buffer";\nimport process from "node:process";\nimport { setImmediate, clearImmediate } from "node:timers";',
    },
    legalComments: "none",
    logLevel: "info",
  });
  if (result.errors.length) {
    throw new Error("esbuild reported errors");
  }
}

function verifyBundle() {
  const src = readFileSync(VENDOR_OUT, "utf8");
  if (/\brequire\(/.test(src)) {
    throw new Error("bundled vendor/postgres.js still contains require( calls");
  }
  for (const builtin of NODE_BUILTINS) {
    // Every retained reference to a bare builtin name must be node:-prefixed.
    const bareImportRe = new RegExp(`from\\s+["']${builtin}["']`);
    if (bareImportRe.test(src)) {
      throw new Error(`vendor/postgres.js imports "${builtin}" without a node: prefix`);
    }
  }
  const npmLike = /from\s+["'](npm:|jsr:|https?:)/;
  if (npmLike.test(src)) {
    throw new Error("vendor/postgres.js contains a forbidden npm:/jsr:/https: import");
  }
  console.log("[build] vendor/postgres.js: no require(), no bare builtin imports, no npm:/jsr:/https: imports");
}

function collectFunctionFiles() {
  /** @type {string[]} */
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && !entry.name.endsWith(".d.ts")) {
        // *.d.ts is dev-only (local type-checking of the vendored JS driver)
        // and is never part of the deployed function.
        files.push(full);
      }
    }
  })(FUNCTION_DIR);
  return files.sort();
}

function validateAndPack(files) {
  if (files.length === 0) {
    throw new Error("no function source files found");
  }
  if (files.length > MAX_FILES) {
    throw new Error(`too many files: ${files.length} > ${MAX_FILES}`);
  }
  const hasIndex = files.some((f) => path.relative(FUNCTION_DIR, f) === "index.ts");
  if (!hasIndex) {
    throw new Error("function/index.ts is required and was not found");
  }

  let totalBytes = 0;
  const entries = [];
  for (const abs of files) {
    const rel = path.relative(FUNCTION_DIR, abs).split(path.sep).join("/");
    const base = path.basename(rel);
    if (FORBIDDEN_BASENAMES.has(base)) {
      throw new Error(`forbidden filename present: ${rel}`);
    }
    if (!PATH_RE.test(rel)) {
      throw new Error(`path does not match required pattern ${PATH_RE}: ${rel}`);
    }
    const stat = statSync(abs);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`file exceeds 1 MiB: ${rel} (${stat.size} bytes)`);
    }
    totalBytes += stat.size;
    entries.push({ path: rel, base64: readFileSync(abs).toString("base64") });
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`total size exceeds 4 MiB: ${totalBytes} bytes`);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, totalBytes };
}

async function main() {
  mkdirSync(path.join(FUNCTION_DIR, "vendor"), { recursive: true });
  mkdirSync(DIST_DIR, { recursive: true });

  const { tmpDir, entry } = fetchPostgresSource();
  try {
    await bundlePostgres(entry);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  verifyBundle();

  const files = collectFunctionFiles();
  const { entries, totalBytes } = validateAndPack(files);
  writeFileSync(FILES_JSON, JSON.stringify(entries, null, 2) + "\n");

  const vendorBytes = statSync(VENDOR_OUT).size;
  console.log(`[build] vendor/postgres.js: ${vendorBytes} bytes`);
  console.log(`[build] ${entries.length} deploy files, ${totalBytes} bytes total`);
  console.log(`[build] wrote ${FILES_JSON}`);
}

main().catch((err) => {
  console.error("[build] FAILED:", err.message);
  process.exit(1);
});
