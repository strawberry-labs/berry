import * as React from "react";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@berry/desktop-ui/components/ui/dialog";
import { Textarea } from "@berry/desktop-ui/components/ui/textarea";

export function PastedTextEditorDialog({ name, text, saving, error, onTextChange, onClose, onSave }: {
  name: string;
  text: string;
  saving: boolean;
  error: string;
  onTextChange: (text: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="flex h-[min(82vh,760px)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl" showCloseButton={!saving}>
        <DialogHeader className="border-b border-[var(--berry-border)] px-5 py-4">
          <DialogTitle className="truncate pr-8">{name}</DialogTitle>
          <DialogDescription className="sr-only">Review and edit the pasted text file.</DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-5 py-4 font-mono text-sm leading-6 shadow-none focus-visible:ring-0"
          aria-label="Pasted text contents"
          spellCheck
        />
        {error ? <p className="px-5 pb-2 text-xs text-destructive" role="alert">{error}</p> : null}
        <DialogFooter className="border-t border-[var(--berry-border)] px-5 py-4">
          <DialogClose asChild><Button variant="outline" disabled={saving}>Close</Button></DialogClose>
          <Button disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
