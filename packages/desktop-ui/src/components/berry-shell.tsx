import type { CSSProperties, ReactNode } from "react";
import { cn } from "@berry/desktop-ui/lib/utils";
import { SidebarInset, SidebarProvider } from "@berry/desktop-ui/components/ui/sidebar";

export function BerryShellFrame({
  bridge,
  chrome,
  sidebar,
  children,
  overlay,
  className,
  sidebarWidth = "18rem",
  sidebarWidthIcon = "3.5rem",
}: {
  bridge?: ReactNode;
  chrome?: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
  overlay?: ReactNode;
  className?: string;
  sidebarWidth?: string;
  sidebarWidthIcon?: string;
}) {
  return (
    <SidebarProvider
      className={cn("berry-shell relative", className)}
      style={{ "--sidebar-width": sidebarWidth, "--sidebar-width-icon": sidebarWidthIcon } as CSSProperties}
    >
      {bridge}
      {chrome}
      {sidebar}
      <SidebarInset className="berry-main-panel h-svh overflow-hidden bg-background md:peer-data-[variant=inset]:shadow-none">
        {children}
      </SidebarInset>
      {overlay}
    </SidebarProvider>
  );
}
