import * as React from "react";

const fallbackDuration = 250;
const motionDuration = (name: string) => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = raw.endsWith("ms") ? Number.parseFloat(raw) : Number.parseFloat(raw) * 1000;
  return Number.isFinite(value) ? value : fallbackDuration;
};
const motionEase = () =>
  getComputedStyle(document.documentElement).getPropertyValue("--ease-smooth-out").trim() ||
  "cubic-bezier(0.22, 1, 0.36, 1)";
const transitionFor = (ms: number, ease: string) =>
  `height ${ms}ms ${ease}, opacity ${ms}ms ${ease}`;

/** Interruptible collapse with a double-rAF WebKit mount fix. */
export function AnimatedCollapse({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const prevOpenRef = React.useRef(open);
  const timerRef = React.useRef<number | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const [mounted, setMounted] = React.useState(open);

  if (open && !mounted) setMounted(true);

  React.useLayoutEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    const el = ref.current;
    if (open === wasOpen || !el) return;

    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);

    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.style.transition = "";
      el.style.height = "";
      el.style.opacity = "";
      el.style.overflow = "";
      if (!open) setMounted(false);
      return;
    }

    const fresh = open && el.style.height === "";
    const startHeight = fresh ? 0 : el.getBoundingClientRect().height;
    const startOpacity = fresh ? "0" : getComputedStyle(el).opacity;
    el.style.transition = "none";
    el.style.overflow = "hidden";
    el.style.height = `${startHeight}px`;
    el.style.opacity = startOpacity;

    const start = () => {
      const duration = motionDuration("--duration-fast");
      const ease = motionEase();
      el.style.transition = transitionFor(duration, ease);
      if (open) {
        el.style.height = `${el.scrollHeight}px`;
        el.style.opacity = "1";
        timerRef.current = window.setTimeout(() => {
          el.style.transition = "";
          el.style.height = "";
          el.style.opacity = "";
          el.style.overflow = "";
        }, duration);
      } else {
        el.style.height = "0px";
        el.style.opacity = "0";
        timerRef.current = window.setTimeout(() => setMounted(false), duration);
      }
    };

    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(start);
    });
  }, [open]);

  React.useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  if (!mounted) return null;
  return <div ref={ref} className={className}>{children}</div>;
}
