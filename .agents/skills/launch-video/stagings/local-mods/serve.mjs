// One installed-style T3 Code ("MacBook") for the local-mods video. Unlike a dev server it serves a
// built web client, so Apply really swaps it for the mod's build and the page reloads into it.
// The mod source is a small git checkout holding the one file the mod edits; its build step copies
// in the real client built here with or without the mod, by whether that file has the change.
// Keeps running; writes <out>/stage.json. Usage: serve.mjs <out-dir>
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { REPO, cli, createProject, freePort, prepareHome } from "../../scripts/stage-env.mjs";
import { MOD_EDITS, MOD_FILE, MOD_ID, applyEdits } from "./mod.mjs";

const out = NodePath.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: serve.mjs <out-dir>");
const clients = NodePath.join(out, "clients");
const root = NodePath.join(out, "stage");
const home = NodePath.join(root, "macbook");
const source = NodePath.join(root, "t3code");
const vars = NodePath.join(root, "claude-vars.json");
const version = JSON.parse(
  NodeFS.readFileSync(NodePath.join(REPO, "apps/server/package.json"), "utf8"),
).version;

// --- The real web client, stock and with the mod (cached across runs) ----------------------
function buildClient(name, edit) {
  const dest = NodePath.join(clients, name);
  if (NodeFS.existsSync(NodePath.join(dest, "index.html"))) return dest;
  const file = NodePath.join(REPO, MOD_FILE);
  const stock = NodeFS.readFileSync(file, "utf8");
  try {
    if (edit) NodeFS.writeFileSync(file, applyEdits(stock));
    console.log(`building the ${name} web client`);
    NodeChildProcess.execFileSync("vp", ["run", "--filter", "@t3tools/web", "build"], {
      cwd: REPO,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, APP_VERSION: version },
    });
  } finally {
    NodeFS.writeFileSync(file, stock);
  }
  NodeFS.mkdirSync(clients, { recursive: true });
  NodeFS.cpSync(NodePath.join(REPO, "apps/web/dist"), dest, { recursive: true });
  return dest;
}
const stockClient = buildClient("stock", false);
const moddedClient = buildClient("modded", true);

NodeFS.rmSync(root, { recursive: true, force: true });
NodeFS.mkdirSync(root, { recursive: true });

// --- The source mods are made from ---------------------------------------------------------
const files = {
  "package.json": JSON.stringify({ name: "t3code-monorepo", private: true }, null, 2),
  "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
  "apps/server/package.json": JSON.stringify({ name: "t3", version, private: true }, null, 2),
  "apps/web/package.json": JSON.stringify(
    {
      name: "@t3tools/web",
      private: true,
      scripts: { build: "node ../../scripts/build-client.mjs" },
    },
    null,
    2,
  ),
  [MOD_FILE]: NodeFS.readFileSync(NodePath.join(REPO, MOD_FILE), "utf8"),
  "scripts/build-client.mjs": `// Stands in for the web build: copies the client built from this source.
import * as NodeFS from "node:fs";
const edited = NodeFS.readFileSync(${JSON.stringify(MOD_FILE)}.replace(/^/, "../../"), "utf8");
const from = edited.includes(${JSON.stringify(MOD_EDITS[1].new)})
  ? ${JSON.stringify(moddedClient)}
  : ${JSON.stringify(stockClient)};
NodeFS.rmSync("dist", { recursive: true, force: true });
NodeFS.cpSync(from, "dist", { recursive: true });
console.log("built", from.endsWith("modded") ? "with the mod" : "stock");
`,
};
for (const [file, content] of Object.entries(files)) {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(source, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(source, file), content);
}
const git = (...args) => NodeChildProcess.execFileSync("git", args, { cwd: source });
git("init", "--quiet", "--initial-branch=main");
git("config", "user.name", "T3 Code");
git("config", "user.email", "release@example.com");
git("add", "--all");
git("commit", "--quiet", "-m", `v${version}`);
git("tag", `v${version}`);

// --- The agent ------------------------------------------------------------------------------
const workspaceFile = NodePath.join(`${source}-mods`, MOD_ID, MOD_FILE);
const title = (text, match = "") => ({
  match: `"title"[\\s\\S]*${match}`,
  json: { title: text, needsRefinement: false },
});
const VERIFY = `import { readFileSync } from "node:fs";

// The sidebar row's second line must render the thread's branch.
const row = readFileSync(${JSON.stringify(MOD_FILE)}, "utf8");
const metaLine = row.slice(row.indexOf("const metaLine ="), row.indexOf("const titleLineIcons"));
if (!/GitBranchIcon[\\s\\S]*checkoutThread\\.branch/.test(metaLine)) {
  console.error("The sidebar row does not show the thread's branch.");
  process.exit(1);
}
`;
// Earlier work in the sidebar: each a worktree thread on its own branch, with a real change.
const SEEDS = [
  {
    branch: "fix/coupon-rounding",
    title: "Fix coupon rounding at checkout",
    file: "src/checkout/coupon.ts",
    content:
      "export const applyCoupon = (subtotal: number, percent: number) =>\n  Math.round(subtotal * (1 - percent / 100) * 100) / 100;\n",
  },
  {
    branch: "feat/avatar-crop",
    title: "Crop avatars on upload",
    file: "src/profile/avatar.ts",
    content:
      "export const cropSquare = (width: number, height: number) => {\n  const side = Math.min(width, height);\n  return { x: (width - side) / 2, y: (height - side) / 2, side };\n};\n",
  },
  {
    branch: "chore/stripe-v18",
    title: "Upgrade the Stripe SDK to v18",
    file: "src/billing/stripe.ts",
    content: 'export const STRIPE_API_VERSION = "2026-09-30.acacia";\n',
  },
];
prepareHome(home, {
  label: "MacBook",
  claude: [
    title("Show branches in the sidebar", "branch"),
    ...SEEDS.map((seed) => ({
      match: seed.title,
      steps: [
        { write: seed.file, content: seed.content, ms: 300 },
        { text: `Done: ${seed.title.toLowerCase()} on \`${seed.branch}\`.` },
      ],
    })),
    {
      match: "branch",
      steps: [
        {
          think:
            "This is a change to T3 Code itself, not to mugshot. The sidebar row already has each thread's branch; it only shows it in the hover card.",
        },
        { text: "That's a change to T3 Code itself, so I'll make it as a mod." },
        { tool: "t3_mod_start", input: { id: MOD_ID } },
        // Long enough for drive.mjs to freeze the start row; the edit rows show a scratch path.
        { wait: 2500 },
        ...MOD_EDITS.map((edit) => ({ edit: workspaceFile, old: edit.old, new: edit.new, ms: 300 })),
        {
          tool: "t3_mod_propose",
          input: {
            id: MOD_ID,
            title: "Branch names in the sidebar",
            intent:
              "Each thread in the sidebar shows its git branch on its second line.\nThreads without a branch look the same as before.",
            verifySource: VERIFY,
          },
        },
        {
          text: "It's built and checked. **Preview** tries it on scratch data; **Apply** switches this T3 Code to it.",
        },
      ],
    },
  ],
});
NodeFS.writeFileSync(vars, "{}");

// --- The server, serving the built client ---------------------------------------------------
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const identity = JSON.parse(NodeFS.readFileSync(NodePath.join(home, "identity.json"), "utf8"));
const log = NodePath.join(home, "server.log");
const server = NodeChildProcess.spawn(
  process.execPath,
  [
    "apps/server/src/bin.ts",
    "--base-dir",
    home,
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    "--no-browser",
  ],
  {
    cwd: REPO,
    detached: true,
    stdio: ["ignore", "pipe", NodeFS.openSync(log, "a")],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      T3CODE_ENVIRONMENT_LABEL: identity.label,
      T3CODE_ENVIRONMENT_MACHINE_KIND: identity.machine,
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
      T3CODE_STATIC_DIR: stockClient,
      T3CODE_MOD_SOURCE_DIR: source,
      FAKE_CLAUDE_SCRIPT: NodePath.join(home, "claude-script.json"),
      FAKE_CLAUDE_LOG: NodePath.join(home, "fake-claude.log"),
      FAKE_CLAUDE_VARS: vars,
    },
  },
);
const stop = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));
const pairingUrl = await new Promise((resolve, reject) => {
  let buffer = "";
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    NodeFS.appendFileSync(log, String(chunk).replace(/pairingUrl:\s*\S+/g, "pairingUrl: <hidden>"));
    const match = /pairingUrl:\s*(\S+)/.exec(buffer);
    if (match) resolve(match[1]);
  });
  server.once("exit", (code) => reject(new Error(`server exited ${code}; see ${log}`)));
});
const descriptor = await (await fetch(`${origin}/.well-known/t3/environment`)).json();
const macbook = { home, origin, environmentId: descriptor.environmentId, label: descriptor.label };
console.log(`MacBook: ${macbook.label} ${macbook.environmentId} at ${origin}`);

const project = await createProject(macbook, "mugshot", {
  "README.md": "# mugshot\n\nProfile photos for teams.\n",
  "src/index.ts": "export {};\n",
});
for (const seed of SEEDS) {
  console.log(
    cli(home, [
      "thread",
      "start",
      project.projectId,
      seed.title,
      "--title",
      seed.title,
      "--worktree",
      "main",
      "--branch",
      seed.branch,
      "--wait",
    ]).trim(),
  );
}

NodeFS.writeFileSync(
  NodePath.join(out, "stage.json"),
  JSON.stringify({ macbook: { ...macbook, pairingUrl }, project }, null, 2),
);
console.log(`ready: ${NodePath.join(out, "stage.json")}`);
await new Promise(() => {});
