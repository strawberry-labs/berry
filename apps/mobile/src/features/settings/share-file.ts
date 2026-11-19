import { Share } from "react-native";
import { File } from "expo-file-system";
import { userCacheDirectory } from "../../storage/user-files";
import * as Sharing from "expo-sharing";

/**
 * The phone's version of the web's "download" buttons: writes the export to
 * the cache and opens the share sheet (Save to Files, Mail, AirDrop...).
 */
export async function shareTextFile(name: string, content: string, mimeType: "text/csv" | "application/json"): Promise<void> {
  if (await Sharing.isAvailableAsync()) {
    const file = new File(userCacheDirectory("exports"), name);
    file.create({ overwrite: true });
    file.write(content);
    await Sharing.shareAsync(file.uri, {
      mimeType,
      dialogTitle: name,
      UTI: mimeType === "text/csv" ? "public.comma-separated-values-text" : "public.json",
    });
    return;
  }
  await Share.share({ title: name, message: content });
}

export function datedFileName(prefix: string, extension: "csv" | "json", now = new Date()): string {
  return `${prefix}-${now.toISOString().slice(0, 10)}.${extension}`;
}
