import * as React from "react"
import { ChevronDownIcon } from "@berry/desktop-ui/lib/icons"
import { Accordion as AccordionPrimitive } from "radix-ui"

import { cn } from "@berry/desktop-ui/lib/utils"

function Accordion({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />
}

function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("border-b last:border-b-0", className)}
      {...props}
    />
  )
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "flex flex-1 items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium transition-[background-color,color,box-shadow] outline-none hover:underline focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180",
          className
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon className="pointer-events-none size-4 shrink-0 translate-y-0.5 text-muted-foreground transition-transform duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)]" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({
  className,
  children,
  onAnimationStart,
  onAnimationEnd,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  const [openSettled, setOpenSettled] = React.useState(false)

  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className={cn("berry-collapsible text-sm", openSettled ? "overflow-visible" : "overflow-hidden")}
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
    >
      <div className={cn("pt-0 pb-4", className)}>{children}</div>
    </AccordionPrimitive.Content>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
