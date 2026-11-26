const ENTRY_FILES = 'script[type="module"][src], link[rel="stylesheet"][href]';
const POLL_INTERVAL_MS = 1_000;

const fileOf = (element: Element) => element.getAttribute("src") ?? element.getAttribute("href");

/** `null` while the app's files cannot be read, which is the case while the server restarts. */
async function readInterfaceChanged(): Promise<boolean | null> {
  const loaded = new Set(Array.from(document.querySelectorAll(ENTRY_FILES), fileOf));
  try {
    const response = await fetch(new URL("/index.html", window.location.href), {
      cache: "no-store",
    });
    if (!response.ok) return null;
    const served = new DOMParser().parseFromString(await response.text(), "text/html");
    // The page adds files of its own as it runs, so only the served list is compared.
    return Array.from(served.querySelectorAll(ENTRY_FILES), fileOf).some(
      (file) => !loaded.has(file),
    );
  } catch {
    return null;
  }
}

async function reloadWhen(
  ready: (changed: boolean, serverWentAway: boolean) => boolean,
  timeoutMs: number,
  reload: () => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let serverWentAway = false;
  for (;;) {
    const changed = await readInterfaceChanged();
    if (changed !== null && ready(changed, serverWentAway)) {
      reload();
      return true;
    }
    if (changed === null) serverWentAway = true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Reloads once the app's files were replaced since this page loaded, as after a T3 Code mod is
 * applied, or once the server is back from a restart. Resolves false when neither happened in
 * time.
 */
export const reloadWhenInterfaceChanges = (
  timeoutMs: number,
  reload: () => void = () => window.location.reload(),
) => reloadWhen((changed, serverWentAway) => changed || serverWentAway, timeoutMs, reload);

/**
 * Reloads once the server is back from a restart that is about to happen. Until then it may
 * serve another interface than the one it restarts into, which is not one to reload for.
 */
export const reloadAfterRestart = (
  timeoutMs: number,
  reload: () => void = () => window.location.reload(),
) => reloadWhen((_changed, serverWentAway) => serverWentAway, timeoutMs, reload);
