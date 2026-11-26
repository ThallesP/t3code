import type { EnvironmentId, ModsStatusResult } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useRef } from "react";

import type { ModMachineStep } from "../../state/mods";
import { RestartInterruptionNote, RunningThreads } from "../sidebar/UpdateEverythingDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";

export interface ModMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The machine the mod's thread runs on, where its build is made. */
  readonly home: boolean;
  /** This page is served by it, so its restart is the one that reloads the page. */
  readonly servesThisPage: boolean;
  readonly connected: boolean;
  /** The user did not leave it out. */
  readonly included: boolean;
  /** Set when it runs another T3 Code than the machine the build was made on. */
  readonly otherVersion: string | null;
  readonly continuesThreads: boolean;
  readonly status: ModsStatusResult | null;
  readonly step: ModMachineStep | null;
  readonly failure: string | null;
}

/** True for a machine a build can go to right now. */
export const takesMod = (machine: ModMachine) =>
  machine.home || (machine.connected && machine.otherVersion === null);

/**
 * Asks once where a mod goes and says what that costs. Confirming does all of it: the mod is
 * applied, copied to every chosen machine, and each one restarted when the mod needs it.
 */
export function ModApplyDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly restarts: boolean;
  readonly machines: ReadonlyArray<ModMachine>;
  readonly onInclude: (environmentId: EnvironmentId, included: boolean) => void;
  readonly onConfirm: () => void;
}) {
  const gt = useGT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const chosen = props.machines.filter((machine) => machine.included && takesMod(machine));

  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup
        className="sm:max-w-xl"
        initialFocus={cancelRef}
        finalFocus={(closeType) => closeType === "keyboard"}
      >
        <AlertDialogHeader className="shrink-0">
          <AlertDialogTitle>
            {gt(
              "{count, plural, one {Apply to {count} machine?} other {Apply to {count} machines?}}",
              { count: chosen.length },
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>{props.title}</AlertDialogDescription>
        </AlertDialogHeader>
        <ScrollArea scrollFade>
          <div className="px-6 pb-4">
            <div
              role="table"
              className="grid grid-cols-[minmax(4rem,1fr)_max-content_max-content] gap-x-4 text-sm"
            >
              <div
                role="row"
                className="col-span-full grid grid-cols-subgrid border-b pb-1.5 text-muted-foreground text-xs"
              >
                <span role="columnheader">
                  <T>Machine</T>
                </span>
                <span role="columnheader">
                  <T>Status</T>
                </span>
                <span role="columnheader" />
              </div>
              {props.machines.map((machine) => {
                const takes = takesMod(machine);
                const gets = takes && machine.included;
                return (
                  <div
                    key={machine.environmentId}
                    role="row"
                    className="col-span-full grid grid-cols-subgrid items-center border-b border-border/50 py-1.5 last:border-b-0"
                  >
                    <label role="cell" className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        checked={gets}
                        disabled={machine.home || !takes}
                        aria-label={machine.label}
                        onCheckedChange={(checked) =>
                          props.onInclude(machine.environmentId, checked)
                        }
                      />
                      <span className="max-w-48 min-w-0">
                        <MiddleTruncate value={machine.label} aria-hidden />
                      </span>
                    </label>
                    <span role="cell" className={gets ? undefined : "text-muted-foreground"}>
                      {!machine.connected && !machine.home ? (
                        <T>Offline</T>
                      ) : machine.otherVersion !== null ? (
                        gt("Runs {version}, update it first", { version: machine.otherVersion })
                      ) : !gets ? (
                        <T>Left out</T>
                      ) : props.restarts ? (
                        <T>Restarts</T>
                      ) : (
                        <T>No restart</T>
                      )}
                      {gets && props.restarts && machine.servesThisPage && chosen.length > 1 ? (
                        <span className="block text-muted-foreground text-xs">
                          <T>restarts last</T>
                        </span>
                      ) : null}
                    </span>
                    <span role="cell" className="text-right">
                      {gets && props.restarts ? (
                        <RunningThreads environmentId={machine.environmentId} />
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </ScrollArea>
        <AlertDialogFooter>
          {props.restarts ? (
            <RestartInterruptionNote
              restarts={chosen.map((machine) => ({
                environmentId: machine.environmentId,
                continuesThreads: machine.continuesThreads,
              }))}
            />
          ) : null}
          <AlertDialogClose ref={cancelRef} render={<Button variant="outline" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button onClick={props.onConfirm}>
            {props.restarts ? gt("Apply and restart") : gt("Apply")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
