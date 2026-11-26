import { expect, it, vi } from "vite-plus/test";

import { reloadAfterRestart, reloadWhenInterfaceChanges } from "./interfaceReload";

const page = (script: string) =>
  new Response(`<html><head><script type="module" src="${script}"></script></head></html>`);

/** Stands in for the app bundle this page was loaded from. */
function loadedScript(src: string) {
  const script = document.createElement("script");
  script.type = "module";
  script.setAttribute("src", src);
  document.head.append(script);
  return { [Symbol.dispose]: () => script.remove() };
}

it("reloads once the served app differs from the one this page loaded", async () => {
  using _loaded = loadedScript("/assets/index-OLD.js");
  using fetched = vi
    .spyOn(window, "fetch")
    .mockResolvedValueOnce(page("/assets/index-OLD.js"))
    .mockResolvedValueOnce(page("/assets/index-NEW.js"));
  const reload = vi.fn();

  expect(await reloadWhenInterfaceChanges(10_000, reload)).toBe(true);
  expect(fetched).toHaveBeenCalledTimes(2);
  expect(reload).toHaveBeenCalledOnce();
});

it("reloads when the server is back from a restart, even with the same files", async () => {
  using _loaded = loadedScript("/assets/index-OLD.js");
  using _fetched = vi
    .spyOn(window, "fetch")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(page("/assets/index-OLD.js"));
  const reload = vi.fn();

  expect(await reloadWhenInterfaceChanges(10_000, reload)).toBe(true);
  expect(reload).toHaveBeenCalledOnce();
});

it("gives up without reloading when nothing changed in time", async () => {
  using _loaded = loadedScript("/assets/index-OLD.js");
  using _fetched = vi
    .spyOn(window, "fetch")
    .mockImplementation(async () => page("/assets/index-OLD.js"));
  const reload = vi.fn();

  expect(await reloadWhenInterfaceChanges(0, reload)).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});

it("waits out a restart before reloading, whatever is served until then", async () => {
  using _loaded = loadedScript("/assets/index-OLD.js");
  using fetched = vi
    .spyOn(window, "fetch")
    // Before it restarts, the server serves its plain interface, not the one being applied.
    .mockResolvedValueOnce(page("/assets/index-PLAIN.js"))
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(page("/assets/index-NEW.js"));
  const reload = vi.fn();

  expect(await reloadAfterRestart(10_000, reload)).toBe(true);
  expect(fetched).toHaveBeenCalledTimes(3);
  expect(reload).toHaveBeenCalledOnce();
});
