import * as React from "react";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { isPassiveInlineImageFile } from "./file-preview-policy";
import { useBoundedImageSource } from "./bounded-image";

/**
 * Berry-adapted Extend UI file thumbnail: durable previews come from object
 * storage; this component owns the loading/reveal/fallback presentation.
 */
export function FileThumbnail({ name, previewImageUrl, mediaType, className = "" }: {
  name: string;
  previewImageUrl?: string | null;
  mediaType?: string | null;
  className?: string;
}) {
  const containerRef = React.useRef<HTMLSpanElement | null>(null);
  const [inViewport, setInViewport] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (!previewImageUrl || typeof IntersectionObserver === "undefined") {
      setInViewport(Boolean(previewImageUrl));
      return;
    }
    const element = containerRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      setInViewport(Boolean(entry?.isIntersecting));
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [previewImageUrl]);
  const safePreviewUrl = useBoundedImageSource({ src: previewImageUrl, mediaType, enabled: inViewport });
  React.useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [previewImageUrl]);

  return (
    <span ref={containerRef} className={`relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-muted ${className}`}>
      {safePreviewUrl && !failed ? (
        <img
          src={safePreviewUrl}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className={`absolute inset-0 size-full object-cover transition-[opacity,filter] duration-160 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${loaded ? "opacity-100 blur-0" : "opacity-0 blur-sm"}`}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : (
        <FileTypeIcon path={name} className="size-10" />
      )}
      {safePreviewUrl && !loaded && !failed ? <span className="absolute inset-0 animate-pulse bg-background/55 motion-reduce:animate-none" aria-hidden /> : null}
    </span>
  );
}

export function isImageFile(file: { name: string; mediaType: string; detectedMediaType?: string | null; size?: number | null }): boolean {
  return isPassiveInlineImageFile(file);
}
