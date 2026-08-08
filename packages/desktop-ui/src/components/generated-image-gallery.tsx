import * as React from "react";
import {
  GeneratedImageContentSchema,
  type GeneratedImageContent,
  type ImageAspectRatio,
  type MessagePart,
} from "@berry/shared";
import {
  ArrowUp,
  ArrowUpRight01Icon,
  CirclePlus,
  FileDown,
  FileImage,
  MoreHorizontal,
  Pencil,
  X,
} from "@berry/desktop-ui/lib/icons";
import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@berry/desktop-ui/components/ui/dropdown-menu";
import { cn } from "@berry/desktop-ui/lib/utils";

import styles from "./generated-image-gallery.module.css";

export interface GeneratedImageView extends GeneratedImageContent {
  id: string;
}

export interface ImageEditAnnotation {
  index: number;
  xPct: number;
  yPct: number;
  text: string;
}

export interface GeneratedImageGalleryProps {
  parts: MessagePart[];
  conversationParts?: MessagePart[];
  onEdit?: (image: GeneratedImageView, instruction: string, annotations: ImageEditAnnotation[]) => void | Promise<void>;
  onRegenerate?: (image: GeneratedImageView, aspectRatio: ImageAspectRatio) => void | Promise<void>;
}

const ASPECT_RATIOS: Array<{ value: ImageAspectRatio; label: string }> = [
  { value: "1:1", label: "Square 1:1" },
  { value: "3:4", label: "Portrait 3:4" },
  { value: "9:16", label: "Story 9:16" },
  { value: "4:3", label: "Landscape 4:3" },
  { value: "16:9", label: "Widescreen 16:9" },
];

export function generatedImageFromPart(part: MessagePart): GeneratedImageView | null {
  if (part.kind !== "image") return null;
  const parsed = GeneratedImageContentSchema.safeParse(part.content);
  return parsed.success ? { id: part.id, ...parsed.data } : null;
}

export function GeneratedImageGallery({
  parts,
  conversationParts = parts,
  onEdit,
  onRegenerate,
}: GeneratedImageGalleryProps) {
  const images = React.useMemo(() => parts.flatMap((part) => {
    const image = generatedImageFromPart(part);
    return image ? [image] : [];
  }), [parts]);
  const conversationImages = React.useMemo(() => conversationParts.flatMap((part) => {
    const image = generatedImageFromPart(part);
    return image ? [image] : [];
  }), [conversationParts]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [lightboxId, setLightboxId] = React.useState<string | null>(null);
  const [failedThumbnails, setFailedThumbnails] = React.useState<Record<string, string>>({});
  const active = images[Math.min(activeIndex, images.length - 1)];
  if (!active) return null;

  const openLightbox = (image: GeneratedImageView) => setLightboxId(image.id);
  return (
    <>
      <div className={styles.gallery}>
        <GeneratedImageCard
          image={active}
          onOpen={() => openLightbox(active)}
          onEdit={onEdit ? () => openLightbox(active) : undefined}
        />
        {images.length > 1 ? (
          <div className={styles.rail} aria-label={`${images.length} generated images`}>
            {images.map((image, index) => (
              <button
                type="button"
                key={image.id}
                className={styles.thumbnailButton}
                aria-label={`Image ${index + 1} of ${images.length}`}
                aria-current={index === activeIndex ? "true" : undefined}
                onClick={() => setActiveIndex(index)}
              >
                {failedThumbnails[image.id] === image.src ? (
                  <span className={styles.thumbnailUnavailable}><FileImage aria-hidden="true" /></span>
                ) : (
                  <img
                    src={image.src}
                    alt=""
                    className={styles.thumbnail}
                    onError={() => setFailedThumbnails((current) => ({ ...current, [image.id]: image.src }))}
                  />
                )}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <GeneratedImageLightbox
        images={conversationImages}
        activeId={lightboxId}
        onActiveIdChange={setLightboxId}
        onEdit={onEdit}
        onRegenerate={onRegenerate}
      />
    </>
  );
}

function GeneratedImageCard({
  image,
  onOpen,
  onEdit,
}: {
  image: GeneratedImageView;
  onOpen: () => void;
  onEdit?: (() => void) | undefined;
}) {
  const [failedSource, setFailedSource] = React.useState<string | null>(null);
  const failed = failedSource === image.src;
  React.useEffect(() => setFailedSource(null), [image.id, image.src]);
  if (failed) {
    return (
      <div className={styles.card} style={{ aspectRatio: ratioCss(image.aspectRatio) }}>
        <UnavailableImage image={image} />
      </div>
    );
  }
  return (
    <div
      className={styles.card}
      data-transparent={image.transparentBackground ? "true" : undefined}
      style={{ aspectRatio: ratioCss(image.aspectRatio) }}
    >
      <button type="button" className={styles.imageButton} onClick={onOpen} aria-label={`Open ${image.title}`}>
        <ProgressiveImage
          src={image.src}
          alt={image.title}
          availablePercentComplete={1}
          dimensions={{ width: image.width ?? 1024, height: image.height ?? 1024 }}
          isTransparent={image.transparentBackground}
          onError={() => setFailedSource(image.src)}
        />
      </button>
      <div className={styles.scrim} aria-hidden />
      <div className={styles.overlay} data-testid="image-gen-overlay-actions">
        <div data-testid="image-gen-overlay-left-actions">
          {onEdit ? (
            <button type="button" className={styles.overlayPill} onClick={onEdit} aria-label="Edit image">
              <Pencil />
              Edit
            </button>
          ) : null}
        </div>
        <div data-testid="image-gen-overlay-right-actions">
          <a
            className={styles.overlayIcon}
            href={image.downloadUrl ?? image.src}
            download={downloadName(image)}
            aria-label="Save"
            onClick={(event) => event.stopPropagation()}
          >
            <FileDown />
          </a>
        </div>
      </div>
    </div>
  );
}

export function ProgressiveImage({
  src,
  alt,
  availablePercentComplete,
  dimensions,
  isTransparent,
  ignoreFirstChunk = false,
  shouldRenderSquareThumbnail = false,
  unconstrainedWidth = false,
  onFinalImageLoad,
  onError,
}: {
  src: string;
  alt: string;
  availablePercentComplete: number;
  dimensions: { width: number; height: number };
  isTransparent: boolean;
  ignoreFirstChunk?: boolean;
  shouldRenderSquareThumbnail?: boolean;
  unconstrainedWidth?: boolean;
  onFinalImageLoad?: () => void;
  onError?: () => void;
}) {
  const progress = ignoreFirstChunk && availablePercentComplete < 0.25 ? 0 : availablePercentComplete;
  const blur = Math.max(0, 16 * (1 - progress));
  const maskStop = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
  return (
    <div
      className={cn(styles.progressive, unconstrainedWidth && styles.unconstrained)}
      data-transparent={isTransparent ? "true" : undefined}
      style={{ aspectRatio: shouldRenderSquareThumbnail ? "1 / 1" : `${dimensions.width} / ${dimensions.height}` }}
    >
      <div className={styles.bloom} aria-hidden>
        <img src={src} alt="" />
      </div>
      <div className={styles.base} style={{ filter: `blur(${blur}px)` }}>
        <img src={src} alt={alt} onLoad={progress >= 1 ? onFinalImageLoad : undefined} onError={onError} />
      </div>
      {progress > 0 && progress < 1 ? (
        <div
          className={styles.reveal}
          aria-hidden
          style={{
            WebkitMaskImage: `linear-gradient(to bottom, #000 0, #000 ${maskStop}, transparent ${maskStop})`,
            maskImage: `linear-gradient(to bottom, #000 0, #000 ${maskStop}, transparent ${maskStop})`,
          }}
        >
          <img src={src} alt="" />
        </div>
      ) : null}
    </div>
  );
}

export function GeneratedImageLightbox({
  images,
  activeId,
  onActiveIdChange,
  onEdit,
  onRegenerate,
}: {
  images: GeneratedImageView[];
  activeId: string | null;
  onActiveIdChange: (id: string | null) => void;
  onEdit?: GeneratedImageGalleryProps["onEdit"];
  onRegenerate?: GeneratedImageGalleryProps["onRegenerate"];
}) {
  const activeIndex = Math.max(0, images.findIndex((image) => image.id === activeId));
  const active = images[activeIndex];
  const [instruction, setInstruction] = React.useState("");
  const [commentMode, setCommentMode] = React.useState(false);
  const [annotations, setAnnotations] = React.useState<ImageEditAnnotation[]>([]);
  const [activePin, setActivePin] = React.useState<number | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [failedSources, setFailedSources] = React.useState<Record<string, string>>({});
  const activeFailed = Boolean(active && failedSources[active.id] === active.src);

  React.useEffect(() => {
    setFailedSources((current) => Object.fromEntries(
      Object.entries(current).filter(([id, source]) => images.some((image) => image.id === id && image.src === source)),
    ));
  }, [images]);

  React.useEffect(() => {
    if (!activeId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowLeft") return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
      const next = (activeIndex + delta + images.length) % images.length;
      onActiveIdChange(images[next]?.id ?? activeId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, activeIndex, images, onActiveIdChange]);

  React.useEffect(() => {
    setInstruction("");
    setAnnotations([]);
    setActivePin(null);
    setCommentMode(false);
  }, [activeId]);

  if (!active) return null;

  const submitEdit = async () => {
    if (!onEdit || (!instruction.trim() && annotations.every((item) => !item.text.trim()))) return;
    setSubmitting(true);
    try {
      await onEdit(active, instruction.trim(), annotations.filter((item) => item.text.trim()));
      onActiveIdChange(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={Boolean(activeId)} onOpenChange={(open) => { if (!open) onActiveIdChange(null); }}>
      <DialogContent
        className={styles.lightbox}
        role="dialog"
        aria-label="Media viewer"
        showCloseButton={false}
      >
        <header className={styles.lightboxHeader} data-testid="lightbox-shell-header">
          <DialogClose asChild>
            <Button variant="ghost" size="icon" aria-label="Close fullscreen view"><X /></Button>
          </DialogClose>
          <DialogHeader className={styles.lightboxTitle}>
            <DialogTitle>{activeFailed ? active.title : commentMode ? "Add comments" : active.title}</DialogTitle>
            <DialogDescription className="sr-only">Generated image viewer and editor</DialogDescription>
          </DialogHeader>
          <div className={styles.headerActions}>
            {activeFailed ? null : (
              <>
                {commentMode ? (
                  <Button variant="ghost" size="sm" onClick={() => setCommentMode(false)}>Cancel</Button>
                ) : (
                  <>
                    {onEdit ? <Button variant="ghost" size="sm" onClick={() => setCommentMode(true)}><CirclePlus /> Comment</Button> : null}
                    {onRegenerate ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm"><ArrowUpRight01Icon /> Aspect ratio</Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {ASPECT_RATIOS.map((ratio) => (
                            <DropdownMenuItem key={ratio.value} onClick={() => {
                              void Promise.resolve(onRegenerate(active, ratio.value)).then(() => onActiveIdChange(null));
                            }}>
                              <span className={styles.ratioGlyph} style={{ aspectRatio: ratioCss(ratio.value) }} />
                              {ratio.label}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                    <span className={styles.headerDivider} />
                    <Button asChild variant="default" size="sm">
                      <a href={active.downloadUrl ?? active.src} download={downloadName(active)}><FileDown /> Save</a>
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Show more"><MoreHorizontal /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem>Like this image</DropdownMenuItem>
                        <DropdownMenuItem>Dislike this image</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
              </>
            )}
          </div>
        </header>
        <div className={styles.lightboxBody} data-testid="lightbox-body">
          {images.length > 1 ? (
            <aside className={styles.lightboxRail} aria-label="Images in this conversation">
              {images.map((image, index) => (
                <button
                  type="button"
                  key={image.id}
                  data-testid="lightbox-rail-item"
                  aria-label={`Image ${index + 1} of ${images.length}`}
                  aria-current={image.id === active.id ? "true" : undefined}
                  onClick={() => onActiveIdChange(image.id)}
                >
                  {failedSources[image.id] === image.src ? (
                    <span className={styles.thumbnailUnavailable}><FileImage aria-hidden="true" /></span>
                  ) : (
                    <img src={image.src} alt="" onError={() => setFailedSources((current) => ({ ...current, [image.id]: image.src }))} />
                  )}
                </button>
              ))}
            </aside>
          ) : <span />}
          <main className={styles.lightboxCenter}>
            {activeFailed ? (
              <div className={styles.lightboxUnavailable} style={{ aspectRatio: ratioCss(active.aspectRatio) }}>
                <UnavailableImage image={active} />
              </div>
            ) : (
              <div
                className={cn(styles.lightboxStage, commentMode && styles.commentStage)}
                data-transparent={active.transparentBackground ? "true" : undefined}
              >
                <div
                  className={styles.lightboxImageFrame}
                  onClick={(event) => {
                    if (!commentMode) return;
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const next: ImageEditAnnotation = {
                      index: annotations.length + 1,
                      xPct: ((event.clientX - bounds.left) / bounds.width) * 100,
                      yPct: ((event.clientY - bounds.top) / bounds.height) * 100,
                      text: "",
                    };
                    setAnnotations((current) => [...current, next]);
                    setActivePin(next.index);
                  }}
                >
                <img src={active.src} alt={active.title} onError={() => setFailedSources((current) => ({ ...current, [active.id]: active.src }))} />
                {annotations.map((annotation) => (
                  <button
                    type="button"
                    key={annotation.index}
                    className={styles.commentPin}
                    style={{ left: `${annotation.xPct}%`, top: `${annotation.yPct}%` }}
                    onClick={(event) => {
                      event.stopPropagation();
                      setActivePin(annotation.index);
                    }}
                    aria-label={`Comment ${annotation.index}`}
                  >
                    {annotation.index}
                  </button>
                ))}
                {activePin ? (
                  <div
                    className={styles.pinEditor}
                    style={{
                      left: `${annotations.find((item) => item.index === activePin)?.xPct ?? 50}%`,
                      top: `${annotations.find((item) => item.index === activePin)?.yPct ?? 50}%`,
                    }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      autoFocus
                      value={annotations.find((item) => item.index === activePin)?.text ?? ""}
                      placeholder="Describe changes"
                      onChange={(event) => setAnnotations((current) => current.map((item) => item.index === activePin ? { ...item, text: event.target.value } : item))}
                    />
                    <button type="button" aria-label="Delete comment" onClick={() => {
                      setAnnotations((current) => current.filter((item) => item.index !== activePin));
                      setActivePin(null);
                    }}><X /></button>
                  </div>
                ) : null}
                </div>
              </div>
            )}
            {commentMode && !activeFailed ? <p className={styles.helper}>Tap on the image to add comments. Pins guide a semantic edit, not a pixel-perfect mask.</p> : null}
            {onEdit && !activeFailed ? (
              <footer className={styles.editComposer}>
                <textarea
                  rows={1}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder={commentMode ? "(Optional) Add additional edits" : "Describe edits"}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void submitEdit();
                    }
                  }}
                />
                <Button
                  size="icon"
                  disabled={submitting || (!instruction.trim() && annotations.every((item) => !item.text.trim()))}
                  onClick={() => void submitEdit()}
                  aria-label="Submit image edit"
                >
                  <ArrowUp />
                </Button>
              </footer>
            ) : null}
          </main>
          <span />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UnavailableImage({ image }: { image: GeneratedImageView }) {
  return (
    <div className={styles.unavailable} role="status" aria-label={`${image.title}: Image unavailable`}>
      <FileImage aria-hidden="true" />
      <strong>{image.title}</strong>
      <span>Image unavailable</span>
      <p>This image was deleted or you no longer have access.</p>
    </div>
  );
}

function ratioCss(ratio: ImageAspectRatio): string {
  return ratio.replace(":", " / ");
}

function downloadName(image: GeneratedImageView): string {
  const extension = image.mimeType === "image/webp" ? "webp" : image.mimeType === "image/jpeg" ? "jpg" : "png";
  const base = image.title.replace(/[\\/:*?"<>|]+/g, "-").trim() || "generated-image";
  return `${base}.${extension}`;
}
