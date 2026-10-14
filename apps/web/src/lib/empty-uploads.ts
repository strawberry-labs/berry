/**
 * A dropped folder reaches the composer as a 0-byte file without a type, and
 * online-only placeholders and empty files are 0 bytes too. Uploading them
 * gave tasks empty inputs that were then treated as real content (H-027).
 */
export function splitEmptyUploads(files: readonly File[]): { accepted: File[]; message: string | null } {
  const empty = files.filter((file) => file.size === 0);
  if (empty.length === 0) return { accepted: [...files], message: null };
  const names = empty.slice(0, 5).map((file) => file.name).join(", ") + (empty.length > 5 ? ` and ${empty.length - 5} more` : "");
  const folderLike = empty.every((file) => !file.type);
  return {
    accepted: files.filter((file) => file.size > 0),
    message: folderLike
      ? `Not attached (0 bytes): ${names}. Folders and online-only placeholders can't be attached directly; attach the files inside, or a .zip of the folder.`
      : `Not attached (0 bytes): ${names}. These files are empty.`,
  };
}
