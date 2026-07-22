import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@berry/desktop-ui/lib/utils";

export function BerryLogo({ className, alt = "Berry", ...props }: ComponentPropsWithoutRef<"img">) {
  return <img src="/berry-logo.svg" alt={alt} draggable={false} className={cn("shrink-0 object-contain", className)} {...props} />;
}
