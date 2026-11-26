// Drives the MacBook client through the local-mods story and freezes a beat at each step into
// <out>/beats. Needs serve.mjs running; applying the mod is one-way, so restart serve.mjs before
// driving again. Usage: drive.mjs <out-dir>
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { saveBeat } from "../../scripts/snapshot.mjs";
import { cli, openBrowser } from "../../scripts/stage-env.mjs";

const out = NodePath.resolve(process.argv[2] ?? "");
const stage = JSON.parse(NodeFS.readFileSync(NodePath.join(out, "stage.json"), "utf8"));
NodeFS.rmSync(NodePath.join(out, "beats"), { recursive: true, force: true });
NodeFS.mkdirSync(NodePath.join(out, "shots"), { recursive: true });

const { browser, page } = await openBrowser();
const started = Date.now();
const beat = async (name, { park = true } = {}) => {
  // Park the pointer off the app so no hover state is frozen in.
  if (park) await page.mouse.move(1439, 719);
  await page.waitForTimeout(250);
  await saveBeat(page, out, name);
  await page.screenshot({ path: NodePath.join(out, "shots", `${name}.png`) });
  console.log(`beat ${name} at ${((Date.now() - started) / 1000).toFixed(1)}s`);
};

try {
  // The startup link expires; mint a fresh one for this run.
  const pairing = cli(stage.macbook.home, ["pair"]);
  const pairingUrl = /https?:\/\/\S+\/pair#token=\S+/.exec(pairing)?.[0];
  if (!pairingUrl) throw new Error("pair printed no pairing URL");
  await page.goto(pairingUrl);
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 120_000 });
  const composer = page.getByRole("textbox").first();
  await composer.waitFor({ timeout: 120_000 });
  await page.getByText("Upgrade the Stripe SDK to v18").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await beat("home");

  await composer.click();
  await composer.pressSequentially(
    "show each thread's git branch in the sidebar, I can never tell my worktrees apart",
    { delay: 10 },
  );
  await beat("ask-typed");
  await composer.press("Enter");

  await page.getByText("T3 mod start", { exact: false }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(500);
  await beat("starting");
  await page.getByText("T3 mod propose", { exact: false }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await beat("proposing");

  const card = page.locator("section[aria-label^='Apply T3 Code customization']");
  await card.waitFor({ timeout: 180_000 });
  await page.getByText("switches this T3 Code to it", { exact: false }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await beat("card");

  await card.getByRole("button", { name: "Apply", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await beat("dialog");

  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByText("fix/coupon-rounding").first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(2000);
  await beat("applied");
} catch (error) {
  await page.screenshot({ path: NodePath.join(out, "shots", "failure.png") });
  throw error;
} finally {
  await browser.close();
}
