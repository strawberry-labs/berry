"use client"

import * as React from "react"
import { Collapsible as CollapsiblePrimitive } from "radix-ui"

import { cn } from "@berry/desktop-ui/lib/utils"

function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  )
}

function CollapsibleContent({
  className,
  onAnimationStart,
  onAnimationEnd,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  const [openSettled, setOpenSettled] = React.useState(false)

  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      className={cn("berry-collapsible", className, openSettled ? "overflow-visible" : "overflow-hidden")}
      onAnimationStart={(event) => {
        if (event.target === event.currentTarget) setOpenSettled(false)
        onAnimationStart?.(event)
      }}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) {
          setOpenSettled(event.currentTarget.dataset.state === "open")
        }
        onAnimationEnd?.(event)
      }}
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
