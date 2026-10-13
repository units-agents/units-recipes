#!/usr/bin/env bun
// Checks every recipe of this repository. No network, no Docker, no dependencies: only Bun.
//
//   bun scripts/validate.ts            check everything; exit 1 on the first run with a problem
//   bun scripts/validate.ts --list     also print one line per recipe
//
// What it checks, for every directory under recipes/:
//   1. recipe.yml parses and fits schema/recipe.schema.json, plus the rules a schema cannot say
//      (unique metric names, noisy metrics have at least 5 rounds, a cuda recipe pins a GPU, at least
//      one deterministic metric, overlay files sit outside what a patch may touch).
//   2. The recipe id, recomputed here from recipe.yml and the overlay files, equals the one in
//      recipes/index.json. The id is what a network and a verifier compare, so this proves the files
//      here are the recipe the index names.
//   3. calibration.json fits schema/calibration.schema.json, belongs to this recipe id, lists no test
//      twice, and gives a base value for every enabled deterministic metric of the recipe.
//   4. calibration-amd64.json (where present) carries a calibration of the same shape for the same
//      metrics and says where it comes from: source "site" is the record of a live unit on mainnet
//      and names its site and lineage_id, the same ones as recipes/index.json; source "measured" is
//      the project's own amd64 measurement of a recipe that is not a live unit, and names neither.
//      The amd64 variant in amd64/ applies to recipe.yml and still fits the schema.
//   5. recipes/SOURCE.json lists exactly the files that are there, with their sha256.
//   6. Nothing that is held back on purpose is present (see README, "What is not here").
//   7. README.md names every recipe, and no file holds an em dash.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RECIPES = join(ROOT, "recipes");
const problems: string[] = [];
const fail = (where: string, what: string) => problems.push(`${where}: ${what}`);

// ----------------------------------------------------------------------- hashing (recipe identity)

const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Sorted-key JSON with no whitespace; undefined properties are left out. */
function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return JSON.stringify(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  throw new Error(`no stable encoding for ${typeof v}`);
}
/** Domain-separated hash of a tuple: sha256 of the canonical JSON array of its parts. */
const H = (...parts: (string | number)[]) => sha256(canonicalJson(parts));

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
    else out.push(p); // a link or a device: reported by the caller
  }
  return out;
}

/** The recipe as a network loads it, and its id: H("recipe", sha256(canonical JSON of the recipe)). */
export function loadRecipe(yml: string, overlay: { path: string; bytes: Uint8Array }[]) {
  const raw = Bun.YAML.parse(yml) as Record<string, any>;
  const files = overlay.map((f) => f.path).sort();
  const overlay_digest = files.length ? H("overlay", JSON.stringify(files.map((f) => [f, sha256(overlay.find((o) => o.path === f)!.bytes)]))) : undefined;
  const recipe: Record<string, any> = { ...raw, overlay_digest };
  recipe.test = { exclude: [], ...recipe.test };
  recipe.build = { reproducible: false, artifacts: [], ...recipe.build };
  // overlay files are always protected, whatever the recipe says
  recipe.patch = { ...recipe.patch, protected_paths: [...new Set([...(recipe.patch?.protected_paths ?? []), ...files])].sort() };
  return { raw, recipe, recipe_id: H("recipe", sha256(canonicalJson(recipe))), overlay_digest: overlay_digest ?? null, overlay_files: files };
}

// ------------------------------------------------------------------- a small JSON Schema checker

type Schema = Record<string, any>;
const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v);

/** Checks a value against the subset of JSON Schema the two schema files use. Returns the problems found. */
export function check(schema: Schema, v: unknown, at = "$"): string[] {
  const out: string[] = [];
  const t = typeOf(v);
  if (schema.type) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!want.some((w: string) => w === t || (w === "number" && t === "integer"))) return [`${at} must be ${want.join(" or ")}, is ${t}`];
  }
  if ("const" in schema && v !== schema.const) out.push(`${at} must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(v)) out.push(`${at} must be one of ${schema.enum.join(", ")}`);
  if (typeof v === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) out.push(`${at} does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && v.length < schema.minLength) out.push(`${at} is shorter than ${schema.minLength}`);
  }
  if (typeof v === "number") {
    if (schema.minimum !== undefined && v < schema.minimum) out.push(`${at} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) out.push(`${at} is above ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && v <= schema.exclusiveMinimum) out.push(`${at} must be above ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && v >= schema.exclusiveMaximum) out.push(`${at} must be below ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) out.push(`${at} needs at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) out.push(`${at} repeats an item`);
    if (schema.items) v.forEach((x, i) => out.push(...check(schema.items, x, `${at}[${i}]`)));
  }
  if (t === "object") {
    const o = v as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) out.push(`${at}.${k} is required`);
    for (const [k, x] of Object.entries(o)) {
      if (schema.properties?.[k]) out.push(...check(schema.properties[k], x, `${at}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${at}.${k} is not a known field`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") out.push(...check(schema.additionalProperties, x, `${at}.${k}`));
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------- the run

const recipeSchema = JSON.parse(readFileSync(join(ROOT, "schema/recipe.schema.json"), "utf8")) as Schema;
const calSchema = JSON.parse(readFileSync(join(ROOT, "schema/calibration.schema.json"), "utf8")) as Schema;

/** Names that are held back from this repository on purpose (README, "What is not here"). */
const HELD_BACK = ["canaries", "candidates", "patch-defs.json", "make-patches.ts", "claude-attempts", "proposal.json", "NOTES.md"];

/** The rules of a recipe that the schema cannot express. */
export function recipeRules(r: Record<string, any>, overlayFiles: string[]): string[] {
  const out: string[] = [];
  const names = (r.metrics ?? []).map((m: any) => m.name);
  if (new Set(names).size !== names.length) out.push("two metrics share a name");
  for (const m of r.metrics ?? []) if (!m.deterministic && !((m.rounds ?? 0) >= 5)) out.push(`metric ${m.name}: a noisy metric needs rounds of at least 5`);
  if (!(r.metrics ?? []).some((m: any) => m.deterministic)) out.push("no deterministic metric");
  if (r.class === "cuda" && !r.requires?.gpu) out.push("a cuda recipe must pin requires.gpu");
  if (r.class !== "cuda" && r.requires?.gpu) out.push("only a cuda recipe pins a GPU");
  const cls = /^lineage\/([a-z0-9-]+):/.exec(r.image ?? "")?.[1];
  if (cls && cls !== r.class) out.push(`image lineage/${cls} does not belong to class ${r.class}`);
  // an overlay file under an allowed path stays protected (protected wins), but a harness that a
  // patch could reach by name is a mistake worth catching early: it must not be an allowed path itself
  for (const f of overlayFiles) if ((r.patch?.allowed_paths ?? []).includes(f)) out.push(`overlay file ${f} is listed as an allowed path`);
  return out;
}

function checkCalibration(where: string, c: Record<string, any>, recipe: Record<string, any>, recipe_id: string | null): void {
  for (const p of check(calSchema, c)) fail(where, p);
  if (recipe_id && c.recipe_id !== recipe_id) fail(where, `belongs to recipe ${String(c.recipe_id).slice(0, 12)}, but the recipe here is ${recipe_id.slice(0, 12)}`);
  const seen = new Map<string, string>();
  for (const set of ["stable", "known_failures", "quarantined"]) for (const t of c[set] ?? []) {
    if (seen.has(t)) fail(where, `test ${t} is in both ${seen.get(t)} and ${set}`);
    seen.set(t, set);
  }
  if (!(c.stable ?? []).length) fail(where, "no stable test: nothing would protect behaviour");
  const metricNames = new Set((recipe.metrics ?? []).map((m: any) => m.name));
  for (const k of Object.keys(c.metrics ?? {})) if (!metricNames.has(k)) fail(where, `metric ${k} is not a metric of the recipe`);
  for (const m of recipe.metrics ?? []) {
    const x = c.metrics?.[m.name];
    if (!x) fail(where, `no entry for metric ${m.name}`);
    else if (x.enabled && m.deterministic && !(typeof x.base_value === "number" && x.base_value > 0)) fail(where, `enabled deterministic metric ${m.name} has no base value`);
    else if (!x.enabled && !x.reason) fail(where, `disabled metric ${m.name} gives no reason`);
  }
  for (const t of recipe.test?.exclude ?? []) if (seen.has(t)) fail(where, `excluded test ${t} is counted`);
}

const index = JSON.parse(readFileSync(join(RECIPES, "index.json"), "utf8")) as { recipes: Record<string, any>[] };
const byName = new Map(index.recipes.map((r) => [r.name as string, r]));
const dirs = readdirSync(RECIPES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const rows: string[] = [];

for (const name of dirs) {
  const dir = join(RECIPES, name);
  if (name.startsWith("fixture-")) fail(name, "a fixture recipe is not part of this repository");
  for (const e of readdirSync(dir)) if (HELD_BACK.includes(e)) fail(name, `${e} is held back on purpose and must not be here`);
  const ymlFile = join(dir, "recipe.yml");
  if (!existsSync(ymlFile)) {
    fail(name, "no recipe.yml");
    continue;
  }
  const yml = readFileSync(ymlFile, "utf8");
  const overlay = walk(join(dir, "overlay")).map((p) => ({ path: relative(join(dir, "overlay"), p).split("\\").join("/"), bytes: readFileSync(p) }));
  let loaded: ReturnType<typeof loadRecipe>;
  try {
    loaded = loadRecipe(yml, overlay);
  } catch (e) {
    fail(name, `recipe.yml does not parse: ${(e as Error).message}`);
    continue;
  }
  for (const p of check(recipeSchema, loaded.raw)) fail(`${name}/recipe.yml`, p);
  for (const p of recipeRules(loaded.raw, loaded.overlay_files)) fail(`${name}/recipe.yml`, p);
  if (loaded.raw.name !== name) fail(`${name}/recipe.yml`, `names itself ${loaded.raw.name}`);

  const row = byName.get(name);
  if (!row) fail(name, "not in recipes/index.json");
  else {
    if (row.recipe_id !== loaded.recipe_id) fail(name, `recipe id here is ${loaded.recipe_id.slice(0, 12)}, index.json says ${String(row.recipe_id).slice(0, 12)}`);
    if (row.overlay_digest !== loaded.overlay_digest) fail(name, "overlay digest differs from index.json");
    for (const k of ["class", "repo", "commit", "image"]) if (row[k] !== loaded.raw[k]) fail(name, `${k} differs from index.json`);
    if (JSON.stringify(row.metrics.map((m: any) => m.name)) !== JSON.stringify(loaded.raw.metrics.map((m: any) => m.name))) fail(name, "metrics differ from index.json");
  }

  const calFile = join(dir, "calibration.json");
  let arches: string[] = [];
  if (!existsSync(calFile)) fail(name, "no calibration.json");
  else {
    checkCalibration(`${name}/calibration.json`, JSON.parse(readFileSync(calFile, "utf8")), loaded.raw, loaded.recipe_id);
    arches.push(loaded.raw.requires?.arch);
  }
  const amdFile = join(dir, "calibration-amd64.json");
  if (existsSync(amdFile)) {
    const w = JSON.parse(readFileSync(amdFile, "utf8")) as Record<string, any>;
    const at = `${name}/calibration-amd64.json`;
    for (const k of ["source", "recipe_id", "calibration"]) if (!(k in w)) fail(at, `${k} is required`);
    const hex64 = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
    if (!hex64(w.recipe_id)) fail(at, "recipe_id is not a 64 character hex id");
    if (w.source === "site") {
      // the record of a live unit: where it was read and which unit it is
      if (w.network !== "mainnet") fail(at, "a site record must be from mainnet");
      if (typeof w.site !== "string" || !/^https:\/\/[a-z0-9.-]+$/.test(w.site)) fail(at, "site must be the https origin the record was read from");
      for (const k of ["lineage_id", "calib_id"]) if (!hex64(w[k])) fail(at, `${k} is required (64 character hex id)`);
      const m = row?.mainnet;
      if (!m || m.lineage_id !== w.lineage_id || m.recipe_id !== w.recipe_id || m.site !== w.site) fail(at, "index.json does not name the same mainnet unit");
    } else if (w.source === "measured") {
      for (const k of ["site", "lineage_id", "network"]) if (k in w) fail(at, `a measured calibration is not a unit's record and must not carry ${k}`);
      if (row?.mainnet) fail(at, "index.json names a mainnet unit, but the calibration here is not its site record");
    } else fail(at, 'source must be "site" or "measured"');
    for (const k of Object.keys(w)) if (!["_note", "source", "network", "site", "lineage_id", "recipe_id", "calib_id", "calibrated_by", "calibration_sig", "read_at", "calibration"].includes(k)) fail(at, `${k} is not a known field`);
    if (row && row.calibrations?.amd64?.source !== w.source) fail(at, "index.json gives another source for the amd64 calibration");
    if (w.calibration?.recipe_id !== undefined && w.calibration.recipe_id !== w.recipe_id) fail(at, "the calibration inside is for another recipe id");
    if (w.calibration) checkCalibration(at, { ...w.calibration, recipe_id: w.recipe_id }, loaded.raw, null);
    if (w.recipe_id === loaded.recipe_id) fail(`${name}/calibration-amd64.json`, "has the id of recipe.yml: an amd64 variant pins another image, so its id must differ");
    if (loaded.raw.requires?.arch === "amd64") fail(`${name}/calibration-amd64.json`, "recipe.yml is already amd64: its calibration is calibration.json");
    arches.push("amd64");
  }

  // the amd64 variant: text replacements in recipe.yml, extra harness files beside the overlay
  const amd = join(dir, "amd64");
  if (existsSync(amd)) {
    for (const e of readdirSync(amd)) if (e !== "replace.json" && e !== "overlay") fail(`${name}/amd64`, `unexpected ${e}`);
    let text = yml;
    if (existsSync(join(amd, "replace.json"))) {
      const repl = JSON.parse(readFileSync(join(amd, "replace.json"), "utf8")) as [string, string][];
      if (!Array.isArray(repl) || !repl.every((x) => Array.isArray(x) && x.length === 2 && x.every((s) => typeof s === "string"))) fail(`${name}/amd64/replace.json`, "must be a list of [from, to] strings");
      else
        for (const [from, to] of repl) {
          if (!text.includes(from)) fail(`${name}/amd64/replace.json`, `"${from}" does not occur in recipe.yml`);
          text = text.split(from).join(to);
        }
    }
    text = text.replace(/^requires:\s*\{([^}]*)\}/m, (_a, inner: string) => `requires: {${inner.replace(/arch:\s*\w+/, "arch: amd64")}}`);
    const extra = walk(join(amd, "overlay")).map((p) => ({ path: relative(join(amd, "overlay"), p).split("\\").join("/"), bytes: readFileSync(p) }));
    try {
      const merged = [...overlay.filter((o) => !extra.some((x) => x.path === o.path)), ...extra];
      const v = loadRecipe(text, merged);
      for (const p of check(recipeSchema, v.raw)) fail(`${name} (amd64 variant)`, p);
      if (v.raw.requires?.arch !== "amd64") fail(`${name} (amd64 variant)`, "requires.arch did not become amd64");
    } catch (e) {
      fail(`${name} (amd64 variant)`, `does not parse: ${(e as Error).message}`);
    }
    if (!existsSync(amdFile)) fail(`${name}/amd64`, "an amd64 variant without calibration-amd64.json");
  }
  if (row?.mainnet && !existsSync(amdFile)) fail(name, "index.json names a mainnet unit, but there is no site record (calibration-amd64.json)");

  const m = loaded.raw;
  rows.push(`${name.padEnd(20)} ${String(m.class).padEnd(7)} ${arches.filter(Boolean).join("+").padEnd(12)} ${(row?.mainnet ? "mainnet" : "").padEnd(8)} ${String(m.metrics.length).padStart(2)} metrics  ${loaded.recipe_id.slice(0, 12)}  ${m.repo}`);
}
for (const r of index.recipes) if (!dirs.includes(r.name)) fail("recipes/index.json", `names ${r.name}, which has no directory`);

// SOURCE.json: exactly the files that are there
const source = JSON.parse(readFileSync(join(RECIPES, "SOURCE.json"), "utf8")) as { source_commit: string; files: Record<string, string> };
const onDisk = walk(RECIPES).map((p) => relative(RECIPES, p).split("\\").join("/")).filter((p) => p !== "SOURCE.json").sort();
for (const p of onDisk) {
  if (!statSync(join(RECIPES, p)).isFile()) fail(`recipes/${p}`, "not a regular file");
  else if (!(p in source.files)) fail(`recipes/${p}`, "not listed in SOURCE.json");
  else if (sha256(readFileSync(join(RECIPES, p))) !== source.files[p]) fail(`recipes/${p}`, "differs from the sha256 in SOURCE.json (edited by hand?)");
}
for (const p of Object.keys(source.files)) if (!onDisk.includes(p)) fail("recipes/SOURCE.json", `lists ${p}, which is missing`);
if (!/^[0-9a-f]{40}$/.test(source.source_commit)) fail("recipes/SOURCE.json", "source_commit is not a full commit");

// README names every recipe; no em dash anywhere
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
for (const name of dirs) if (!readme.includes("`" + name + "`")) fail("README.md", `does not name the recipe ${name}`);
const EM_DASH = String.fromCharCode(0x2014);
for (const p of [...walk(RECIPES), join(ROOT, "README.md"), join(ROOT, "LICENSE"), ...walk(join(ROOT, "schema")), ...walk(join(ROOT, "scripts"))]) {
  if (!existsSync(p) || !statSync(p).isFile()) continue;
  const b = readFileSync(p);
  if (!b.includes(0) && b.toString("utf8").includes(EM_DASH)) fail(relative(ROOT, p), "holds an em dash");
}

if (process.argv.includes("--list")) for (const r of rows) console.log(r);
if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  console.error(`${problems.length} problem(s) in ${dirs.length} recipes`);
  process.exit(1);
}
console.log(`${dirs.length} recipes valid: schema, rules, recipe ids, calibrations and ${onDisk.length} file digests all check (snapshot of ${source.source_commit.slice(0, 12)})`);
