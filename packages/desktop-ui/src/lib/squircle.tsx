import * as React from "react";
import { getSvgPath } from "figma-squircle";

/**
 * WKWebView has no `corner-shape: superellipse`, so real squircles need a
 * generated SVG path. We clip the element to that path with `clip-path`, which
 * shapes the background AND any inset box-shadow border ring to the exact
 * superellipse (an outset drop-shadow would be clipped away — use a blurred
 * shadow on a parent if you need one). The path is recomputed on resize so it
 * stays correct for fluid widths.
 */
/** Either a single radius for all corners, or a per-corner map. */
type SquircleRadius =
  | number
  | {
      topLeftCornerRadius?: number;
      topRightCornerRadius?: number;
      bottomLeftCornerRadius?: number;
      bottomRightCornerRadius?: number;
    };

export function useSquircle(
  ref: React.RefObject<HTMLElement | null>,
  radius: SquircleRadius,
  cornerSmoothing = 0.8,
  options?: {
    /** Draw a hairline ring as an SVG stroke along the SAME superellipse path
     * the clip uses. An inset box-shadow ring follows the rectangular
     * border-radius, so the clip cuts it away at the corners — the SVG stroke
     * is the only way to hug the squircle exactly. The 1px stroke is centered
     * on the path (outer half clipped), yielding a 0.5px inner hairline. */
    ring?: boolean;
  },
) {
  // Serialize so object literals (new identity each render) don't re-run the
  // effect every render, while still updating when the values actually change.
  const radiusKey = typeof radius === "number" ? `n:${radius}` : JSON.stringify(radius);
  const ring = options?.ring ?? false;
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const SVG_NS = "http://www.w3.org/2000/svg";
    let svg: SVGSVGElement | null = null;
    let pathEl: SVGPathElement | null = null;
    if (ring) {
      svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("aria-hidden", "true");
      svg.classList.add("berry-squircle-ring");
      pathEl = document.createElementNS(SVG_NS, "path");
      pathEl.setAttribute("fill", "none");
      svg.appendChild(pathEl);
      if (getComputedStyle(el).position === "static") el.style.position = "relative";
      el.appendChild(svg);
    }
    const apply = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      if (!width || !height) return;
      const radii =
        typeof radius === "number"
          ? // Radius can't exceed half the shorter side, or the path degenerates.
            { cornerRadius: Math.min(radius, width / 2, height / 2) }
          : radius;
      const path = getSvgPath({ width, height, cornerSmoothing, ...radii });
      el.style.clipPath = `path('${path}')`;
      el.style.setProperty("-webkit-clip-path", `path('${path}')`);
      if (svg && pathEl) {
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        pathEl.setAttribute("d", path);
      }
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      svg?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, radiusKey, cornerSmoothing, ring]);
}

type SquircleProps<T extends keyof React.JSX.IntrinsicElements = "div"> = {
  as?: T;
  cornerRadius: number;
  cornerSmoothing?: number;
} & Omit<React.ComponentPropsWithoutRef<T>, "as">;

/** A squircle-clipped element. Carries its own className/style like a div. */
export function Squircle<T extends keyof React.JSX.IntrinsicElements = "div">({
  as,
  cornerRadius,
  cornerSmoothing = 0.8,
  ...props
}: SquircleProps<T>) {
  const ref = React.useRef<HTMLElement>(null);
  useSquircle(ref, cornerRadius, cornerSmoothing);
  const Comp = (as ?? "div") as React.ElementType;
  return <Comp ref={ref} {...props} />;
}
