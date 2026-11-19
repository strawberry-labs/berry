import { Directory, Paths } from "expo-file-system";
import { Image } from "expo-image";

const USER_FOLDER = "berry-user";

/**
 * Where downloads, exports and shared packages are written. Everything the
 * signed-in person fetched lives under one folder so sign-out can remove it.
 */
export function userCacheDirectory(...segments: string[]): Directory {
  const directory = new Directory(Paths.cache, USER_FOLDER, ...segments);
  directory.create({ intermediates: true, idempotent: true });
  return directory;
}

/** Removes the person's downloaded files and cached images (sign-out, revocation). */
export async function clearUserFiles(): Promise<void> {
  try {
    const directory = new Directory(Paths.cache, USER_FOLDER);
    if (directory.exists) directory.delete();
  } catch {
    // Best effort: the OS also purges the cache directory.
  }
  await Promise.all([Image.clearMemoryCache(), Image.clearDiskCache()]).catch(() => undefined);
}
