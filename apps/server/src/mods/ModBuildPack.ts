// @effect-diagnostics nodeBuiltinImport:off -- Packs are read and written in fixed chunks through one file descriptor.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const CHUNK_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;

/**
 * Names come from another machine. Only plain relative paths are written to disk.
 */
export const isSafePackName = (name: string) =>
  name.length > 0 &&
  !name.includes("\0") &&
  !name.includes("\\") &&
  !name.startsWith("/") &&
  name.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");

export interface BuildPackEntry {
  readonly name: string;
  readonly filePath: string;
}

/**
 * Writes files as one stream a build can be copied to another machine in: for each file a
 * length-prefixed JSON header, then its bytes.
 */
export function writeBuildPack(packPath: string, entries: ReadonlyArray<BuildPackEntry>): void {
  NodeFS.mkdirSync(NodePath.dirname(packPath), { recursive: true });
  const pack = NodeFS.openSync(packPath, "w");
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  try {
    for (const entry of entries) {
      const file = NodeFS.openSync(entry.filePath, "r");
      try {
        const header = Buffer.from(
          JSON.stringify({ name: entry.name, size: NodeFS.fstatSync(file).size }),
        );
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(header.length);
        NodeFS.writeSync(pack, length);
        NodeFS.writeSync(pack, header);
        for (;;) {
          const read = NodeFS.readSync(file, chunk, 0, CHUNK_BYTES, null);
          if (read === 0) break;
          NodeFS.writeSync(pack, chunk, 0, read);
        }
      } finally {
        NodeFS.closeSync(file);
      }
    }
  } finally {
    NodeFS.closeSync(pack);
  }
}

const readExactly = (file: number, buffer: Buffer, length: number): boolean => {
  let filled = 0;
  while (filled < length) {
    const read = NodeFS.readSync(file, buffer, filled, length - filled, null);
    if (read === 0) {
      if (filled === 0) return false;
      throw new Error("The build pack ends in the middle of a file.");
    }
    filled += read;
  }
  return true;
};

/** Unpacks into `targetDir` and returns the names written. Throws on a malformed pack. */
export function readBuildPack(packPath: string, targetDir: string): ReadonlyArray<string> {
  const pack = NodeFS.openSync(packPath, "r");
  const length = Buffer.allocUnsafe(4);
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  const names: Array<string> = [];
  try {
    while (readExactly(pack, length, 4)) {
      const headerBytes = length.readUInt32BE();
      if (headerBytes === 0 || headerBytes > MAX_HEADER_BYTES) {
        throw new Error("The build pack has a malformed entry.");
      }
      const header = Buffer.allocUnsafe(headerBytes);
      readExactly(pack, header, headerBytes);
      const parsed: unknown = JSON.parse(header.toString("utf8"));
      const name = (parsed as { name?: unknown }).name;
      const size = (parsed as { size?: unknown }).size;
      if (
        typeof name !== "string" ||
        !isSafePackName(name) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0
      ) {
        throw new Error("The build pack has a malformed entry.");
      }
      const target = NodePath.join(targetDir, name);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      const file = NodeFS.openSync(target, "w");
      try {
        let remaining = size;
        while (remaining > 0) {
          const wanted = Math.min(remaining, CHUNK_BYTES);
          readExactly(pack, chunk, wanted);
          NodeFS.writeSync(file, chunk, 0, wanted);
          remaining -= wanted;
        }
      } finally {
        NodeFS.closeSync(file);
      }
      names.push(name);
    }
  } finally {
    NodeFS.closeSync(pack);
  }
  return names;
}

// The desktop app keeps its own files inside an archive. Only Node's synchronous `fs` reads into
// it there, so everything that touches the installed T3 Code goes through these.

export const installedFileExists = (file: string) => {
  try {
    return NodeFS.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Files under `dir`, as relative paths with forward slashes. Empty when `dir` is missing. */
export function listInstalledFiles(dir: string): ReadonlyArray<string> {
  const files: Array<string> = [];
  const walk = (relative: string) => {
    let names: ReadonlyArray<string>;
    try {
      names = NodeFS.readdirSync(NodePath.join(dir, relative));
    } catch {
      return;
    }
    for (const name of names) {
      const child = relative === "" ? name : `${relative}/${name}`;
      let stat: NodeFS.Stats;
      try {
        stat = NodeFS.statSync(NodePath.join(dir, child));
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) files.push(child);
    }
  };
  walk("");
  return files.toSorted();
}

export function copyInstalledFile(source: string, target: string): void {
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, NodeFS.readFileSync(source), {
    mode: NodeFS.statSync(source).mode & 0o777,
  });
}

// A package every installed T3 Code keeps out of its bundle.
const PACKAGE_MARKER = NodePath.join("node-pty", "package.json");
const COMPLETE_MARKER = ".t3-complete";

/**
 * The folder holding the packages the installed T3 Code leaves out of its bundle, which a build
 * from another machine loads too. Inside the desktop app's archive they are no folder a link can
 * point at, so they are copied out to `cacheDir` once.
 */
export function installedPackagesDir(stockDir: string, cacheDir: string): string | null {
  let dir = NodePath.resolve(stockDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = NodePath.join(dir, "node_modules");
    if (installedFileExists(NodePath.join(candidate, PACKAGE_MARKER))) {
      if (!candidate.includes(`.asar${NodePath.sep}`)) return candidate;
      const copied = NodePath.join(cacheDir, "node_modules");
      if (!installedFileExists(NodePath.join(cacheDir, COMPLETE_MARKER))) {
        NodeFS.rmSync(cacheDir, { recursive: true, force: true });
        for (const file of listInstalledFiles(candidate)) {
          copyInstalledFile(NodePath.join(candidate, file), NodePath.join(copied, file));
        }
        NodeFS.writeFileSync(NodePath.join(cacheDir, COMPLETE_MARKER), "");
      }
      return copied;
    }
    const parent = NodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export const readInstalledText = (file: string) => {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

export const linkDirectory = (target: string, link: string) => NodeFS.symlinkSync(target, link);
