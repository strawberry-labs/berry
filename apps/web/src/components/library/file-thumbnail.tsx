import * as React from "react";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";

/**
 * Berry-adapted Extend UI file thumbnail: durable previews come from object
 * storage; this component owns the loading/reveal/fallback presentation.
 */
export function FileThumbnail({ name, previewImageUrl, className = "" }: {
  name: string;
  previewImageUrl?: string | null;
  className?: string;
}) {
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [previewImageUrl]);

  return (
    <span className={`relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-muted ${className}`}>
      {previewImageUrl && !failed ? (
        <img
          src={previewImageUrl}
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
      {previewImageUrl && !loaded && !failed ? <span className="absolute inset-0 animate-pulse bg-background/55 motion-reduce:animate-none" aria-hidden /> : null}
    </span>
  );
}

export function isImageFile(file: { name: string; mediaType: string }): boolean {
  return file.mediaType.startsWith("image/") || /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(file.name);
}
