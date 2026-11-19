---
name: google-drive-mcp
description: Find, read, upload, and organize Drive files and shared-drive folders using Berry’s Google Workspace connector, and open native Docs, Sheets, or Slides.
---

# Google Drive

Discover tools with `tool_search` under connector `Google Workspace`, the Berry connector that provides Drive, Docs, Sheets, and Slides. Use the exact schema it returns and `use_tool` when the tool is deferred. Follow the in-chat **Reconnect** card when requested. Use **Settings → Connectors → Grant write access** if the connection is read-only. Selected-file access covers files granted to Berry. Broader searches depend on the connected account and organization access settings.

## Find and read a file

- Use `drive_search_files` with a Drive `query`, such as `name contains 'Project brief' and trashed = false`. Pass `driveId` when the shared drive is known. Continue a paged search with the returned `nextPageToken`, `searchScope`, and `driveId` as applicable. `drive_list_children` lists one folder by `folderId`.
- Use `drive_get_file_metadata` to confirm the exact `fileId`, type, parent folders, and capabilities before a change. `drive_read_file` stages bytes for the current task and accepts `exportMimeType` for native files. Set `saveToLibrary: true` only for a user-requested durable copy.
- Use `docs_read_document`, `sheets_get_values`, or `slides_read_presentation` for native content. For a Sheets append, confirm the exact spreadsheet ID, tab and A1 `range`, then pass `values` as rows to `sheets_append_values`.

## Organize and upload

- Use `drive_create_folder` with `name` and the verified `parentId`. Use `drive_copy_file`, `drive_rename_file`, or `drive_move_file` for a specific `fileId`. A move takes the destination `addParentId` and `removeParentIds` for the old locations being replaced. After the write, verify the destination with `drive_list_children` or file metadata.
- `drive_upload_file` takes a real `content` payload, `contentEncoding` of `text` or `base64`, the `name`, and the chosen `parentId` and `mimeType` when applicable. Include the source file and destination in the proposal.
- Submit each proposed write to Berry’s inline approval card and wait for the decision. Drive deletion and trash actions are unavailable. For a lost response, read the exact file or destination folder before proposing a repeat.

Adapted from the Workspace CLI [Drive workflows](https://github.com/googleworkspace/cli/blob/main/skills/gws-drive/SKILL.md), [folder organization recipe](https://github.com/googleworkspace/cli/blob/main/skills/recipe-organize-drive-folder/SKILL.md), and [Sheets append workflow](https://github.com/googleworkspace/cli/blob/main/skills/gws-sheets-append/SKILL.md).
