import type { ComponentProps } from "react";
import { cn } from "@berry/desktop-ui/lib/utils";
import { Label } from "@berry/desktop-ui/components/ui/label";

// The vertical Field composition from shadcn's registry, scoped to the web
// form so adding it does not overwrite the shared Label or Separator.
export function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="field-group" className={cn("flex w-full flex-col gap-4", className)} {...props} />;
}
export function Field({ className, ...props }: ComponentProps<"div">) {
  return <div role="group" data-slot="field" className={cn("flex w-full flex-col gap-1.5", className)} {...props} />;
}
export function FieldLabel({ className, ...props }: ComponentProps<typeof Label>) {
  return <Label data-slot="field-label" className={cn("text-xs font-medium text-[var(--berry-text-primary)]", className)} {...props} />;
}
export function FieldDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="field-description" className={cn("text-xs leading-5 text-[var(--berry-text-secondary)]", className)} {...props} />;
}
