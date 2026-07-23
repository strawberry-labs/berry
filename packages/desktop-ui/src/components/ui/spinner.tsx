import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner"

/** @deprecated Use CircularActivitySpinner for new loading states. */
function Spinner(props: React.ComponentProps<typeof CircularActivitySpinner>) {
  return <CircularActivitySpinner label="Loading" {...props} />
}

export { Spinner }
