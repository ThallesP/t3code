import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import { XIcon } from "lucide-react";

import {
  dismissedModRepairsAtom,
  dismissModRepairs,
  modMachineStepsAtom,
  modStatusesAtom,
  restartModMachines,
} from "../../state/mods";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { runningThreadCountAtom } from "./UpdateEverythingDialog";

const ROW =
  "flex min-h-7 w-full shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-2xs leading-4 font-medium";

/**
 * Says where the user's mods are when they are not what runs: an update leaves them out until
 * they are rebuilt, and a rebuilt server only takes over with a restart.
 */
export function SidebarModsNotice() {
  const gt = useGT();
  const statuses = useAtomValue(modStatusesAtom);
  const steps = useAtomValue(modMachineStepsAtom);
  const dismissed = useAtomValue(dismissedModRepairsAtom);
  const machines = [...statuses];

  const paused = machines.filter(([, status]) => status.paused !== undefined);
  const returning = paused.filter(
    ([environmentId, status]) =>
      status.paused?.rebuilding === true || steps.get(environmentId) === "copying",
  );
  const failure = paused.find(([, status]) => status.paused?.failure)?.[1].paused?.failure;
  // A restart someone asked for shows on its card; this is the one a machine waits to make.
  const waiting = machines
    .filter(
      ([environmentId, status]) =>
        status.build !== null &&
        status.restartPending &&
        status.canRestart &&
        !steps.has(environmentId),
    )
    .map(([environmentId]) => environmentId);
  const running = useAtomValue(runningThreadCountAtom(waiting.join("\n")));
  const broken = new Map(
    machines.flatMap(([, status]) =>
      (status.needsRepair ?? [])
        .filter((mod) => !dismissed.includes(mod.id))
        .map((mod) => [mod.id, mod.title] as const),
    ),
  );

  return (
    <>
      {returning.length > 0 ? (
        <div className={`${ROW} bg-sidebar-control-surface text-sidebar-foreground`}>
          <Spinner size="sm" className="shrink-0" />
          <span className="min-w-0">{gt("Bringing your mods back after the update…")}</span>
        </div>
      ) : waiting.length > 0 ? (
        <div className={`${ROW} bg-sidebar-control-surface text-sidebar-foreground`}>
          {running === 0 ? <Spinner size="sm" className="shrink-0" /> : null}
          <span className="min-w-0 flex-1">
            {running === 0
              ? gt("Switching to your mods…")
              : gt("Your mods switch on once running threads finish.")}
          </span>
          {running > 0 ? (
            <button
              type="button"
              className="shrink-0 cursor-pointer underline decoration-muted-foreground/60 underline-offset-3 hover:decoration-current"
              onClick={() => void restartModMachines(waiting)}
            >
              {gt("Restart now")}
            </button>
          ) : null}
        </div>
      ) : paused.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <div className={`${ROW} bg-sidebar-control-surface text-muted-foreground`}>
                <span className="min-w-0">{gt("Your mods are paused since the update.")}</span>
              </div>
            }
          />
          {failure !== undefined ? <TooltipPopup side="top">{failure}</TooltipPopup> : null}
        </Tooltip>
      ) : null}
      {broken.size > 0 ? (
        <div className={`${ROW} bg-warning/12 text-warning`}>
          <span className="min-w-0 flex-1">
            {broken.size === 1
              ? gt("“{title}” no longer fits this T3 Code version. Ask in a thread to repair it.", {
                  title: [...broken.values()][0] ?? "",
                })
              : gt(
                  "{count} of your mods no longer fit this T3 Code version. Ask in a thread to repair them.",
                  { count: broken.size },
                )}
          </span>
          <button
            type="button"
            aria-label={gt("Dismiss")}
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-70 hover:opacity-100"
            onClick={() => dismissModRepairs([...broken.keys()])}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ) : null}
    </>
  );
}
