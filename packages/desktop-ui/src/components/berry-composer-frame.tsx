import * as React from "react";
import { cn } from "@berry/desktop-ui/lib/utils";

export function BerryComposerFrame({
  variant,
  className,
  shellRef,
  cardRef,
  shellProps,
  before,
  header,
  children,
}: {
  variant: "home" | "thread";
  className?: string;
  shellRef?: React.Ref<HTMLDivElement>;
  cardRef?: React.Ref<HTMLDivElement>;
  shellProps?: Omit<React.ComponentPropsWithoutRef<"div">, "className" | "children">;
  before?: React.ReactNode;
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="berry-composer-root relative w-full">
      {before}
      <div
        {...shellProps}
        ref={shellRef}
        className={cn(
          "berry-composer-shell flex w-full flex-col",
          variant === "home" ? "berry-composer-home" : "berry-composer-thread",
          className,
        )}
      >
        {header}
        <div ref={cardRef} className="berry-composer-card flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </div>
    </div>
  );
}
