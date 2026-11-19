import * as React from "react";
import { FileCode, FileImage, FileText } from "@berry/desktop-ui/lib/icons";

/**
 * Canvas-wide file drop. The main task canvas hosts the drop zone and the
 * overlay; the composer registers itself as the target so a drop anywhere on
 * the canvas goes through the composer's normal attach/upload path.
 */
export type CanvasFileDropTarget = {
  addFiles: (files: File[]) => void;
  acceptsFiles: () => boolean;
};

type CanvasFileDropRegistry = {
  register: (target: CanvasFileDropTarget) => () => void;
};

const CanvasFileDropContext = React.createContext<CanvasFileDropRegistry | null>(null);

export function filesFromDataTransfer(dataTransfer: Pick<DataTransfer, "files" | "items"> | null): File[] {
  if (!dataTransfer) return [];
  const directFiles = Array.from(dataTransfer.files);
  if (directFiles.length > 0) return directFiles;
  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
}

export function dataTransferCarriesFiles(dataTransfer: Pick<DataTransfer, "types"> | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes("Files"));
}

/** Registers the composer as the canvas drop target while it is mounted. */
export function useCanvasFileDropTarget(addFiles: (files: File[]) => void, acceptsFiles: boolean): boolean {
  const registry = React.useContext(CanvasFileDropContext);
  const latest = React.useRef({ addFiles, acceptsFiles });
  latest.current = { addFiles, acceptsFiles };
  React.useEffect(() => {
    if (!registry) return;
    return registry.register({
      addFiles: (files) => latest.current.addFiles(files),
      acceptsFiles: () => latest.current.acceptsFiles,
    });
  }, [registry]);
  return Boolean(registry);
}

export function CanvasFileDropZone({
  className,
  panelRef,
  children,
}: {
  className?: string;
  panelRef?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}) {
  const targetsRef = React.useRef<CanvasFileDropTarget[]>([]);
  const depthRef = React.useRef(0);
  const internalDragRef = React.useRef(false);
  const [active, setActive] = React.useState(false);

  const registry = React.useMemo<CanvasFileDropRegistry>(() => ({
    register: (target) => {
      targetsRef.current = [...targetsRef.current, target];
      return () => {
        targetsRef.current = targetsRef.current.filter((item) => item !== target);
      };
    },
  }), []);

  const currentTarget = () => {
    const target = targetsRef.current.at(-1);
    return target && target.acceptsFiles() ? target : null;
  };

  const reset = React.useCallback(() => {
    depthRef.current = 0;
    setActive(false);
  }, []);

  // Drags that start inside the page (queued-message reordering, images, links)
  // never open the overlay, even when the browser exposes them as files.
  React.useEffect(() => {
    const onDragStart = () => { internalDragRef.current = true; };
    const onDragEnd = () => { internalDragRef.current = false; reset(); };
    document.addEventListener("dragstart", onDragStart, true);
    document.addEventListener("dragend", onDragEnd, true);
    return () => {
      document.removeEventListener("dragstart", onDragStart, true);
      document.removeEventListener("dragend", onDragEnd, true);
    };
  }, [reset]);

  React.useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") reset(); };
    // A drop elsewhere (or one a nested target consumed) still ends this drag.
    const onWindowDrop = () => { window.setTimeout(reset, 0); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", reset);
    window.addEventListener("drop", onWindowDrop, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", reset);
      window.removeEventListener("drop", onWindowDrop, true);
    };
  }, [active, reset]);

  const accepts = (event: React.DragEvent) => !internalDragRef.current && dataTransferCarriesFiles(event.dataTransfer) && currentTarget() !== null;

  return (
    <CanvasFileDropContext.Provider value={registry}>
      <div
        ref={panelRef}
        className={className}
        onDragEnter={(event) => {
          if (!accepts(event)) return;
          event.preventDefault();
          depthRef.current += 1;
          setActive(true);
        }}
        onDragOver={(event) => {
          if (!accepts(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          // dragenter on the next element fires before dragleave on the last,
          // so the depth only reaches zero when the pointer leaves the canvas
          // (including leaving the window).
          if (depthRef.current === 0) return;
          depthRef.current -= 1;
          if (depthRef.current === 0) reset();
        }}
        onDrop={(event) => {
          if (!dataTransferCarriesFiles(event.dataTransfer)) return;
          const target = currentTarget();
          reset();
          // A nested drop target (e.g. a question's file answer) already took it.
          if (event.defaultPrevented || internalDragRef.current || !target) return;
          event.preventDefault();
          const files = filesFromDataTransfer(event.dataTransfer);
          if (files.length > 0) target.addFiles(files);
        }}
      >
        {children}
        <CanvasFileDropOverlay active={active} />
      </div>
    </CanvasFileDropContext.Provider>
  );
}

function CanvasFileDropOverlay({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden={!active}
      data-active={active || undefined}
      className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-[var(--berry-drop-scrim)] opacity-0 transition-opacity duration-150 ease-out data-[active]:opacity-100"
    >
      <div className="flex flex-col items-center gap-4 px-6 text-center">
        <div className="relative flex h-16 w-36 items-end justify-center" aria-hidden>
          <span className="absolute left-3 top-2 flex size-12 -rotate-[14deg] items-center justify-center rounded-[14px] bg-[var(--berry-surface-raised)] text-[var(--berry-text-secondary)] shadow-[var(--berry-ring-subtle)]"><FileImage className="size-5" /></span>
          <span className="absolute right-3 top-2 flex size-12 rotate-[14deg] items-center justify-center rounded-[14px] bg-[var(--berry-surface-raised)] text-[var(--berry-text-secondary)] shadow-[var(--berry-ring-subtle)]"><FileCode className="size-5" /></span>
          <span className="relative flex size-14 items-center justify-center rounded-[16px] bg-[var(--berry-card-bg)] text-[var(--berry-text-primary)] shadow-[var(--berry-ring-strong),var(--berry-shadow-floating)]"><FileText className="size-6" /></span>
        </div>
        <div role="status" aria-live="polite" className="flex flex-col items-center gap-1">
          {active ? (
            <>
              <strong className="text-lg font-semibold text-[var(--berry-on-drop-scrim)]">Add anything</strong>
              <span className="text-sm text-[var(--berry-on-drop-scrim-muted)]">Drop files here to add them to the task</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
