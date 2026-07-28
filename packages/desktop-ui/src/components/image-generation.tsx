import * as React from "react";
import { IMAGE_ASPECT_RATIO_DIMENSIONS, type ImageAspectRatio } from "@berry/shared";
import { RefreshCw } from "@berry/desktop-ui/lib/icons";
import { ProgressiveImage } from "@berry/desktop-ui/components/generated-image-gallery";

import styles from "./image-generation.module.css";

export interface ImageGenerationPartial {
  requestIndex: number;
  index: number;
  percentComplete: number;
  src: string;
  aspectRatio: ImageAspectRatio;
}

export interface ImageGenerationState {
  prompt: string;
  status: "generating" | "error";
  message?: string;
  aspectRatio?: ImageAspectRatio;
  batchCount?: number;
  partials?: ImageGenerationPartial[];
}

export function ImageGeneration({
  prompt = "a calm mountain lake at dawn",
  aspectRatio = "1:1",
  batchCount = 1,
  partials = [],
}: {
  prompt?: string;
  aspectRatio?: ImageAspectRatio;
  batchCount?: number;
  partials?: ImageGenerationPartial[];
}) {
  const activePartial = partials[0];
  const activeRatio = activePartial?.aspectRatio ?? aspectRatio;
  const dimensions = IMAGE_ASPECT_RATIO_DIMENSIONS[activeRatio];
  const previewByIndex = new Map(partials.map((partial) => [partial.requestIndex, partial]));
  return (
    <div className={styles.wrap} role="status" aria-live="polite" aria-busy="true">
      <div className={styles.heading}>
        <span className={`${styles.label} berry-shimmer`}>Creating image</span>
        <span className={styles.status}>Rendering preview…</span>
      </div>
      <div className={styles.gallery}>
        <div className={styles.canvas} style={{ aspectRatio: `${dimensions.width} / ${dimensions.height}` }}>
          {activePartial ? (
            <ProgressiveImage
              src={activePartial.src}
              alt="Generated image preview"
              availablePercentComplete={activePartial.percentComplete}
              dimensions={dimensions}
              isTransparent={false}
              ignoreFirstChunk
            />
          ) : (
            <>
              <DotGridCanvas />
              <div className={styles.loadingPill} aria-label="Generating image">
                <span />
                <span />
                <span />
              </div>
            </>
          )}
        </div>
        {batchCount > 1 ? (
          <aside className={styles.previewRail} aria-label={`${batchCount} image previews`}>
            <span className={styles.previewLabel}>Preview</span>
            {Array.from({ length: Math.min(4, batchCount) }, (_, index) => {
              const partial = previewByIndex.get(index);
              return (
                <div className={styles.previewSlot} key={index}>
                  {partial ? <img src={partial.src} alt={`Preview ${index + 1}`} /> : <span />}
                </div>
              );
            })}
          </aside>
        ) : null}
      </div>
      <span className={styles.prompt} title={prompt}>“{prompt}”</span>
    </div>
  );
}

function DotGridCanvas() {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let start = performance.now();
    const draw = (now: number) => {
      const bounds = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(bounds.width * dpr));
      const height = Math.max(1, Math.round(bounds.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.clearRect(0, 0, width, height);
      const phase = ((now - start) / 2800) % 1;
      const gap = 13 * dpr;
      const radius = 1.05 * dpr;
      for (let y = -gap; y < height + gap; y += gap) {
        for (let x = -gap; x < width + gap; x += gap) {
          const wave = .18 + .34 * (.5 + .5 * Math.sin((x + y) / (70 * dpr) + phase * Math.PI * 2));
          context.beginPath();
          context.fillStyle = `rgba(255,255,255,${wave})`;
          context.arc(x + phase * gap, y - phase * gap, radius, 0, Math.PI * 2);
          context.fill();
        }
      }
      if (!reducedMotion) frame = window.requestAnimationFrame(draw);
    };
    if (reducedMotion) draw(start);
    else frame = window.requestAnimationFrame(draw);
    return () => {
      window.cancelAnimationFrame(frame);
      start = 0;
    };
  }, []);
  return <canvas ref={canvasRef} className={styles.dotCanvas} data-testid="image-skeleton-canvas" aria-hidden />;
}

export function ImageGenerationError({
  prompt,
  message,
  onRetry,
}: {
  prompt: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className={styles.error} role="alert">
      <div className={styles.errorCopy}>
        <span className={styles.errorLabel}>Image generation failed</span>
        <span className={styles.prompt}>“{prompt}”</span>
        <span className={styles.errorMessage}>{message}</span>
      </div>
      <button type="button" className={styles.retry} onClick={onRetry}>
        <RefreshCw aria-hidden />
        Try again
      </button>
    </div>
  );
}
