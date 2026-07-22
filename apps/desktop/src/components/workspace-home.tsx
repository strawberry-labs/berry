import { CircleHelp } from "@berry/desktop-ui/lib/icons";

import { Button } from "@berry/desktop-ui/components/ui/button";
import { BerryWorkspaceHomeFrame } from "@berry/desktop-ui/components/berry-workspace-home";

import { greeting } from "@/lib/berry";
import { BerryLogo } from "@/components/berry-logo";
import { Composer, useStartTurn } from "@/components/composer";
import { HelpMenu } from "@/components/help-menu";

/** Workspace empty state: inline brand mark, time-of-day greeting, centered composer. */
export function WorkspaceHome() {
  const startTurn = useStartTurn();

  return (
    <BerryWorkspaceHomeFrame
      help={
        <HelpMenu>
          <Button variant="ghost" size="icon-sm" aria-label="Help" className="berry-home-help text-muted-foreground">
            <CircleHelp />
          </Button>
        </HelpMenu>
      }
      logo={<BerryLogo className="berry-home-greeting-logo" alt="" />}
      greeting={greeting()}
      composer={
        <>
          <Composer
            variant="home"
            streaming={startTurn.isPending}
            onSubmit={(submission) => startTurn.mutateAsync({ submission }).then(() => undefined)}
          />
          {startTurn.isError ? (
            <p className="mt-2 px-2 text-sm text-destructive">{String(startTurn.error)}</p>
          ) : null}
        </>
      }
    />
  );
}
