import type { ComponentProps } from "react";

import { cn } from "@berry/desktop-ui/lib/utils";

type IndicatorSize = number | string;

export interface CircularProgressIndicatorProps
  extends Omit<ComponentProps<"span">, "children"> {
  value: number;
  min?: number;
  max?: number;
  size?: IndicatorSize;
  strokeWidth?: number;
  label?: string;
  trackClassName?: string;
  indicatorClassName?: string;
  formatValueText?: (percentage: number, value: number) => string;
}

export function CircularProgressIndicator({
  value,
  min = 0,
  max = 100,
  size = 16,
  strokeWidth = 2.5,
  label = "Progress",
  trackClassName,
  indicatorClassName,
  formatValueText,
  className,
  style,
  ...props
}: CircularProgressIndicatorProps) {
  const dimension = normalizeSize(size);
  const percentage = calculatePercentage(value, min, max);
  const clampedValue = Number.isFinite(value) && max > min ? clamp(value, min, max) : min;
  const valueText = formatValueText
    ? formatValueText(percentage, value)
    : `${Math.round(percentage)}%`;

  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={clampedValue}
      aria-valuetext={valueText}
      title={`${label}: ${valueText}`}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center text-foreground/70",
        className,
      )}
      style={{ ...style, width: dimension, height: dimension }}
      {...props}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="size-full -rotate-90 overflow-visible">
        <circle
          cx="12"
          cy="12"
          r="9"
          pathLength="100"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className={cn("opacity-20", trackClassName)}
        />
        <circle
          cx="12"
          cy="12"
          r="9"
          pathLength="100"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray="100"
          strokeDashoffset={100 - percentage}
          className={cn(
            "transition-[stroke-dashoffset] duration-200 ease-out motion-reduce:transition-none",
            indicatorClassName,
          )}
        />
      </svg>
    </span>
  );
}

function calculatePercentage(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || max <= min) return 0;
  return clamp(((value - min) / (max - min)) * 100, 0, 100);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSize(size: IndicatorSize): string {
  return typeof size === "number" ? `${size}px` : size;
}
