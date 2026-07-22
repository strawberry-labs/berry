import { RefreshCw } from "@berry/desktop-ui/lib/icons";

import styles from "./image-generation.module.css";

export interface ImageGenerationState {
  prompt: string;
  status: "generating" | "error";
  message?: string;
}

export function ImageGeneration({
  prompt = "a calm mountain lake at dawn",
  resolution = "1024 × 1024",
}: {
  prompt?: string;
  resolution?: string;
}) {
  return (
    <div className={styles.igWrap} role="status" aria-live="polite">
      <div className={styles.igCanvas} aria-label="Generating image">
        <span className={styles.igDots} aria-hidden />
        <span className={styles.igGlow} aria-hidden />
        <span className={styles.igRes}>{resolution}</span>
      </div>
      <div className={styles.igMeta}>
        <span className={`${styles.igLabel} berry-shimmer`}>Generating image</span>
        <span className={styles.igPrompt}>“{prompt}”</span>
      </div>
    </div>
  );
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
    <div className={styles.igError} role="alert">
      <div className={styles.igErrorCopy}>
        <span className={styles.igErrorLabel}>Image generation failed</span>
        <span className={styles.igPrompt}>“{prompt}”</span>
        <span className={styles.igErrorMessage}>{message}</span>
      </div>
      <button type="button" className={styles.igRetry} onClick={onRetry}>
        <RefreshCw aria-hidden />
        Try again
      </button>
    </div>
  );
}
