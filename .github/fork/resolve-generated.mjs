#!/usr/bin/env node
// Resolves merge conflicts in files both this fork and upstream regenerate on almost every change,
// so merging upstream needs a person only for real code conflicts. Run inside a conflicted merge.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
const stage = (number, path) => git("show", `:${number}:${path}`);

// Translation catalogs map a message hash to its text and only ever grow at the end. Entries are
// kept as the text they were written with, so the result needs no formatter.
function catalogEntries(text) {
  const entries = new Map();
  let key;
  for (const line of text.split("\n").slice(1)) {
    const start = /^ {2}"([^"]+)": /u.exec(line);
    if (start) key = start[1];
    else if (line === "}" || line === "") continue;
    if (key === undefined) throw new Error(`Unexpected catalog line: ${line}`);
    entries.set(key, entries.has(key) ? `${entries.get(key)}\n${line}` : line);
  }
  for (const [name, entry] of entries) entries.set(name, entry.replace(/,$/u, ""));
  return entries;
}

function mergeCatalog(baseText, oursText, theirsText) {
  const [base, ours, theirs] = [baseText, oursText, theirsText].map(catalogEntries);
  const merged = new Map(theirs);
  for (const [key, entry] of ours) {
    const added = !base.has(key);
    const changedHere = base.has(key) && base.get(key) !== entry;
    const untouchedThere = theirs.has(key) && theirs.get(key) === base.get(key);
    if ((added && !theirs.has(key)) || (changedHere && untouchedThere)) merged.set(key, entry);
  }
  for (const key of base.keys()) {
    if (!ours.has(key) && theirs.get(key) === base.get(key)) merged.delete(key);
  }
  return `{\n${[...merged.values()].join(",\n")}\n}\n`;
}

// The budget holds measured byte counts, and each side's text adds to them independently.
function mergeBudget(baseText, oursText, theirsText) {
  const [base, ours, theirs] = [baseText, oursText, theirsText].map((text) => JSON.parse(text));
  const merged = Object.fromEntries(
    Object.keys(theirs).map((key) => [
      key,
      theirs[key] + ((ours[key] ?? base[key] ?? 0) - (base[key] ?? 0)),
    ]),
  );
  return `${JSON.stringify(merged, null, 2)}\n`;
}

const resolvers = [
  [/^apps\/(web|mobile)\/src\/i18n\/translations\/[^/]+\.json$/u, mergeCatalog],
  [/^apps\/server\/src\/provider\/agentContextBudget\.json$/u, mergeBudget],
];

const conflicted = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
const left = [];
for (const path of conflicted) {
  const resolve = resolvers.find(([pattern]) => pattern.test(path))?.[1];
  if (!resolve) {
    left.push(path);
    continue;
  }
  writeFileSync(path, resolve(stage(1, path), stage(2, path), stage(3, path)));
  git("add", "--", path);
}
if (left.length > 0) {
  console.log(left.join("\n"));
  process.exitCode = 1;
}
