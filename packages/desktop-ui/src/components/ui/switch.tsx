import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@berry/desktop-ui/lib/utils"

function Switch({
  className,
  size = "default",
  checked,
  defaultChecked,
  onCheckedChange,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  const [initialized, setInitialized] = React.useState(false)
  const [uncontrolledChecked, setUncontrolledChecked] = React.useState(Boolean(defaultChecked))
  const isControlled = checked !== undefined
  const isOn = isControlled ? checked : uncontrolledChecked

  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      data-on={isOn ? "true" : "false"}
      className={cn(
        "t-toggle peer group/switch inline-flex shrink-0 items-center rounded-full border border-[var(--berry-border-hover)] shadow-xs transition-[background-color,border-color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:border-[var(--berry-accent)] data-[state=checked]:bg-[var(--berry-accent)] data-[state=unchecked]:bg-[var(--berry-text-tertiary)]",
        initialized && "is-init",
        className
      )}
      {...(checked === undefined ? {} : { checked })}
      {...(defaultChecked === undefined ? {} : { defaultChecked })}
      onCheckedChange={(next) => {
        setInitialized(true)
        if (!isControlled) setUncontrolledChecked(next)
        onCheckedChange?.(next)
      }}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "t-toggle-thumb pointer-events-none block rounded-full bg-[var(--berry-card-bg)] ring-0 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-bounce)] group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 group-data-[state=checked]/switch:bg-[var(--primary-foreground)]"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
