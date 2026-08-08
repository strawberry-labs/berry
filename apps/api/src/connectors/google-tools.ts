import { randomUUID } from "node:crypto";
import type { McpCachedTool } from "@berry/local-agent";
import type { ConnectorWorkspaceAccessMode } from "@berry/shared";

export type GoogleConnectorKey = "google-workspace" | "gmail" | "google-calendar";
export type GoogleAccessLevel = "read" | "full";

const SCOPE = {
  driveFile: "https://www.googleapis.com/auth/drive.file",
  driveRead: "https://www.googleapis.com/auth/drive.readonly",
  docs: "https://www.googleapis.com/auth/documents",
  sheets: "https://www.googleapis.com/auth/spreadsheets",
  slides: "https://www.googleapis.com/auth/presentations",
  formsBody: "https://www.googleapis.com/auth/forms.body",
  formsResponses: "https://www.googleapis.com/auth/forms.responses.readonly",
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailModify: "https://www.googleapis.com/auth/gmail.modify",
  calendarEventsRead: "https://www.googleapis.com/auth/calendar.events.readonly",
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
  calendarListRead: "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  calendarFreeBusy: "https://www.googleapis.com/auth/calendar.events.freebusy",
} as const;

const GOOGLE_TOOL_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;
const GOOGLE_ERROR_BODY_LIMIT_BYTES = 1024 * 1024;

type ScopeRequirement = { all?: string[]; any?: string[] };
type ToolContext = { accountEmail: string | null };
type ToolDefinition = McpCachedTool & {
  access: GoogleAccessLevel;
  approvalRequired: boolean;
  scopes: ScopeRequirement;
  run: (token: string, input: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
};

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false,
});
const string = (description: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "string", description, ...extra });
const integer = (description: string, minimum = 1, maximum = 1000): Record<string, unknown> => ({ type: "integer", description, minimum, maximum });
const number = (description: string): Record<string, unknown> => ({ type: "number", description });
const boolean = (description: string): Record<string, unknown> => ({ type: "boolean", description });
const stringArray = (description: string, maxItems = 100): Record<string, unknown> => ({ type: "array", description, maxItems, items: { type: "string" } });
const twoDimensionalValues = (): Record<string, unknown> => ({ type: "array", maxItems: 10_000, items: { type: "array", maxItems: 1_000, items: { type: ["string", "number", "boolean", "null"] } } });

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  access: GoogleAccessLevel,
  scopes: ScopeRequirement,
  run: ToolDefinition["run"],
  options: { destructive?: boolean; idempotent?: boolean; openWorld?: boolean; approvalRequired?: boolean } = {},
): ToolDefinition {
  return {
    name, description, inputSchema, access, scopes, run,
    approvalRequired: options.approvalRequired ?? access === "full",
    annotations: {
      readOnlyHint: access === "read",
      destructiveHint: options.destructive ?? false,
      idempotentHint: options.idempotent ?? access === "read",
      openWorldHint: options.openWorld ?? false,
    },
  };
}

const driveReadScopes = { any: [SCOPE.driveFile, SCOPE.driveRead] };

const workspaceTools: ToolDefinition[] = [
  tool("drive_search_files", "Search eligible Google Drive files. Results that Google marks unavailable for generative AI are omitted.", object({
    query: string("Drive files.list q expression."), pageSize: integer("Maximum results.", 1, 100), pageToken: string("Continuation token."),
    orderBy: string("Drive orderBy expression."), driveId: string("Optional shared drive ID."),
  }), "read", driveReadScopes, searchDriveFiles),
  tool("drive_list_recent_files", "List recently modified eligible Drive files.", object({ pageSize: integer("Maximum results.", 1, 100), pageToken: string("Continuation token.") }), "read", driveReadScopes,
    (token, input) => searchDriveFiles(token, { ...input, query: "trashed = false", orderBy: "modifiedTime desc" })),
  tool("drive_get_file_metadata", "Get safe metadata and current capabilities for one Drive file.", object({ fileId: string("Drive file ID.") }, ["fileId"]), "read", driveReadScopes,
    async (token, input) => driveFilePreflight(token, requiredString(input.fileId, "fileId"), "read")),
  tool("drive_read_file", "Read or export an eligible Drive file. Text is returned directly and binary content is base64 encoded.", object({ fileId: string("Drive file ID."), exportMimeType: string("Optional export MIME type for Google-native files.") }, ["fileId"]), "read", driveReadScopes, readDriveFile),
  tool("drive_list_children", "List eligible files directly inside a Drive folder.", object({ folderId: string("Folder ID."), pageSize: integer("Maximum results.", 1, 100), pageToken: string("Continuation token.") }, ["folderId"]), "read", driveReadScopes,
    (token, input) => searchDriveFiles(token, { query: `'${escapeDriveQuery(requiredString(input.folderId, "folderId"))}' in parents and trashed = false`, pageSize: input.pageSize, pageToken: input.pageToken })),
  tool("drive_list_permissions", "List existing Drive permissions without changing sharing.", object({ fileId: string("Drive file ID."), pageSize: integer("Maximum permissions.", 1, 100), pageToken: string("Continuation token.") }, ["fileId"]), "read", driveReadScopes, async (token, input) => {
    const fileId = requiredString(input.fileId, "fileId");
    await driveFilePreflight(token, fileId, "read");
    return googleJson(token, driveUrl(`files/${encodeURIComponent(fileId)}/permissions`, { pageSize: boundedInteger(input.pageSize, 100, 1, 100), pageToken: optionalString(input.pageToken), supportsAllDrives: true, fields: "nextPageToken,permissions(id,type,role,emailAddress,displayName,domain,allowFileDiscovery,expirationTime,pendingOwner,deleted)" }));
  }),
  tool("drive_create_folder", "Create a folder in Drive.", object({ name: string("Folder name."), parentId: string("Optional parent folder ID.") }, ["name"]), "full", { all: [SCOPE.driveFile] }, async (token, input) => googleJson(token, driveUrl("files", { supportsAllDrives: true, fields: DRIVE_FIELDS }), { method: "POST", body: jsonBody(compact({ name: requiredString(input.name, "name"), mimeType: "application/vnd.google-apps.folder", parents: optionalString(input.parentId) ? [optionalString(input.parentId)] : undefined })) }), { openWorld: true }),
  tool("drive_upload_file", "Upload a new file. Uploads above 5 MB use a resumable session.", object({ name: string("File name."), mimeType: string("Content MIME type."), parentId: string("Optional parent folder ID."), content: string("Text or base64 content."), contentEncoding: string("Content encoding.", { enum: ["text", "base64"] }) }, ["name", "content"]), "full", { all: [SCOPE.driveFile] }, uploadDriveFile, { openWorld: true }),
  tool("drive_copy_file", "Copy a Drive file into an optional folder.", object({ fileId: string("Source file ID."), name: string("Optional new name."), parentId: string("Optional destination folder ID.") }, ["fileId"]), "full", { all: [SCOPE.driveFile] }, async (token, input) => {
    const fileId = requiredString(input.fileId, "fileId"); await driveFilePreflight(token, fileId, "copy");
    return googleJson(token, driveUrl(`files/${encodeURIComponent(fileId)}/copy`, { supportsAllDrives: true, fields: DRIVE_FIELDS }), { method: "POST", body: jsonBody(compact({ name: optionalString(input.name), parents: optionalString(input.parentId) ? [optionalString(input.parentId)] : undefined })) });
  }, { openWorld: true }),
  tool("drive_move_file", "Move a Drive file between folders.", object({ fileId: string("File ID."), addParentId: string("Destination folder ID."), removeParentIds: stringArray("Parent IDs to remove.", 20) }, ["fileId", "addParentId"]), "full", { all: [SCOPE.driveFile] }, async (token, input) => updateDriveMetadata(token, input, {}, optionalString(input.addParentId), optionalStringArray(input.removeParentIds)), { idempotent: true }),
  tool("drive_rename_file", "Rename a Drive file.", object({ fileId: string("File ID."), name: string("New name.") }, ["fileId", "name"]), "full", { all: [SCOPE.driveFile] }, (token, input) => updateDriveMetadata(token, input, { name: requiredString(input.name, "name") }), { idempotent: true }),
  tool("drive_trash_file", "Move a Drive file to trash. This is reversible.", object({ fileId: string("File ID.") }, ["fileId"]), "full", { all: [SCOPE.driveFile] }, (token, input) => updateDriveMetadata(token, input, { trashed: true }), { destructive: true, idempotent: true }),
  tool("drive_restore_file", "Restore a Drive file from trash.", object({ fileId: string("File ID.") }, ["fileId"]), "full", { all: [SCOPE.driveFile] }, (token, input) => updateDriveMetadata(token, input, { trashed: false }), { idempotent: true }),

  tool("docs_read_document", "Read all tabs and structural content in a Google Doc.", object({ documentId: string("Document ID.") }, ["documentId"]), "read", driveReadScopes,
    (token, input) => googleJson(token, docsUrl(`documents/${encodeURIComponent(requiredString(input.documentId, "documentId"))}`, { includeTabsContent: true }))),
  tool("docs_create_document", "Create a Google Doc.", object({ title: string("Document title.") }, ["title"]), "full", { any: [SCOPE.driveFile, SCOPE.docs] }, (token, input) => googleJson(token, docsUrl("documents"), { method: "POST", body: jsonBody({ title: requiredString(input.title, "title") }) }), { openWorld: true }),
  tool("docs_insert_text", "Insert text at a document index.", object({ documentId: string("Document ID."), text: string("Text to insert."), index: integer("One-based insertion index.", 1, 10_000_000), tabId: string("Optional tab ID."), revisionId: string("Optional required revision ID.") }, ["documentId", "text", "index"]), "full", { any: [SCOPE.driveFile, SCOPE.docs] }, (token, input) => docsBatch(token, input, [{ insertText: { text: requiredString(input.text, "text"), location: compact({ index: boundedInteger(input.index, 1, 1, 10_000_000), tabId: optionalString(input.tabId) }) } }]), { idempotent: false }),
  tool("docs_append_text", "Append text to the end of a document or tab.", object({ documentId: string("Document ID."), text: string("Text to append."), tabId: string("Optional tab ID."), revisionId: string("Optional required revision ID.") }, ["documentId", "text"]), "full", { any: [SCOPE.driveFile, SCOPE.docs] }, (token, input) => docsBatch(token, input, [{ insertText: { text: requiredString(input.text, "text"), endOfSegmentLocation: compact({ segmentId: "", tabId: optionalString(input.tabId) }) } }]), { idempotent: false }),
  tool("docs_replace_text", "Replace all matching text in a Google Doc.", object({ documentId: string("Document ID."), find: string("Text to find."), replace: string("Replacement text."), matchCase: boolean("Match case."), tabIds: stringArray("Optional tab IDs.", 100), revisionId: string("Optional required revision ID.") }, ["documentId", "find", "replace"]), "full", { any: [SCOPE.driveFile, SCOPE.docs] }, (token, input) => docsBatch(token, input, [{ replaceAllText: { containsText: { text: requiredString(input.find, "find"), matchCase: optionalBoolean(input.matchCase) ?? true }, replaceText: stringValue(input.replace), ...(optionalStringArray(input.tabIds)?.length ? { tabsCriteria: { tabIds: optionalStringArray(input.tabIds) } } : {}) } }]), { idempotent: true }),
  tool("docs_apply_text_style", "Apply a limited text style to a range.", object({ documentId: string("Document ID."), startIndex: integer("Start index.", 1, 10_000_000), endIndex: integer("End index.", 1, 10_000_000), bold: boolean("Bold."), italic: boolean("Italic."), underline: boolean("Underline."), fontSizePt: number("Optional font size in points."), tabId: string("Optional tab ID."), revisionId: string("Optional required revision ID.") }, ["documentId", "startIndex", "endIndex"]), "full", { any: [SCOPE.driveFile, SCOPE.docs] }, styleDocumentText, { idempotent: true }),
  tool("docs_insert_table", "Insert an empty table at a document index.", object({ documentId: string("Document ID."), rows: integer("Rows.", 1, 100), columns: integer("Columns.", 1, 20), index: integer("Insertion index.", 1, 10_000_000), tabId: string("Optional tab ID."), revisionId: string("Optional required revision ID.") }, ["documentId", "rows", "columns", "index"]), "full", { any: [SCOPE.driveFile, SCOPE.docs] }, (token, input) => docsBatch(token, input, [{ insertTable: { rows: boundedInteger(input.rows, 1, 1, 100), columns: boundedInteger(input.columns, 1, 1, 20), location: compact({ index: boundedInteger(input.index, 1, 1, 10_000_000), tabId: optionalString(input.tabId) }) } }]), { idempotent: false }),

  tool("sheets_get_spreadsheet", "Get spreadsheet metadata without unbounded grid data.", object({ spreadsheetId: string("Spreadsheet ID."), ranges: stringArray("Optional bounded A1 ranges.", 100), includeGridData: boolean("Include grid data only for the supplied ranges.") }, ["spreadsheetId"]), "read", driveReadScopes, async (token, input) => {
    const ranges = optionalStringArray(input.ranges); if (input.includeGridData === true && !ranges?.length) throw new Error("includeGridData requires at least one bounded range");
    return googleJson(token, sheetsUrl(`spreadsheets/${encodeURIComponent(requiredString(input.spreadsheetId, "spreadsheetId"))}`, { ranges, includeGridData: input.includeGridData === true }));
  }),
  tool("sheets_get_values", "Read values from one bounded A1 range.", valuesReadSchema(false), "read", driveReadScopes, (token, input) => googleJson(token, sheetsUrl(`spreadsheets/${encodeURIComponent(requiredString(input.spreadsheetId, "spreadsheetId"))}/values/${encodeURIComponent(requiredString(input.range, "range"))}`, { majorDimension: optionalString(input.majorDimension), valueRenderOption: optionalString(input.valueRenderOption) }))),
  tool("sheets_batch_get_values", "Read values from several bounded A1 ranges in one request.", valuesReadSchema(true), "read", driveReadScopes, (token, input) => googleJson(token, sheetsUrl(`spreadsheets/${encodeURIComponent(requiredString(input.spreadsheetId, "spreadsheetId"))}/values:batchGet`, { ranges: requiredStringArray(input.ranges, "ranges").slice(0, 100), majorDimension: optionalString(input.majorDimension), valueRenderOption: optionalString(input.valueRenderOption) }))),
  tool("sheets_create_spreadsheet", "Create a spreadsheet with optional sheet titles.", object({ title: string("Spreadsheet title."), sheetTitles: stringArray("Optional initial sheet titles.", 20) }, ["title"]), "full", { any: [SCOPE.driveFile, SCOPE.sheets] }, (token, input) => googleJson(token, sheetsUrl("spreadsheets"), { method: "POST", body: jsonBody({ properties: { title: requiredString(input.title, "title") }, ...(optionalStringArray(input.sheetTitles)?.length ? { sheets: optionalStringArray(input.sheetTitles)!.map((title) => ({ properties: { title } })) } : {}) }) }), { openWorld: true }),
  tool("sheets_update_values", "Replace values in a bounded A1 range.", valuesWriteSchema(false), "full", { any: [SCOPE.driveFile, SCOPE.sheets] }, (token, input) => googleJson(token, sheetsUrl(`spreadsheets/${encodeURIComponent(requiredString(input.spreadsheetId, "spreadsheetId"))}/values/${encodeURIComponent(requiredString(input.range, "range"))}`, { valueInputOption: optionalString(input.valueInputOption) ?? "USER_ENTERED" }), { method: "PUT", body: jsonBody({ range: requiredString(input.range, "range"), majorDimension: optionalString(input.majorDimension) ?? "ROWS", values: boundedValues(input.values) }) }), { idempotent: true }),
  tool("sheets_append_values", "Append rows after a table in a bounded A1 range.", valuesWriteSchema(false), "full", { any: [SCOPE.driveFile, SCOPE.sheets] }, (token, input) => googleJson(token, sheetsUrl(`spreadsheets/${encodeURIComponent(requiredString(input.spreadsheetId, "spreadsheetId"))}/values/${encodeURIComponent(requiredString(input.range, "range"))}:append`, { valueInputOption: optionalString(input.valueInputOption) ?? "USER_ENTERED", insertDataOption: "INSERT_ROWS" }), { method: "POST", body: jsonBody({ range: requiredString(input.range, "range"), majorDimension: optionalString(input.majorDimension) ?? "ROWS", values: boundedValues(input.values) }) }), { idempotent: false }),
  tool("sheets_clear_values", "Clear values in a bounded A1 range.", object({ spreadsheetId: string("Spreadsheet ID."), range: string("A1 range.") }, ["spreadsheetId", "range"]), "full", { any: [SCOPE.driveFile, SCOPE.sheets] }, (token, input) => googleJson(token, sheetsUrl(`spreadsheets/${encodeURIComponent(requiredString(input.spreadsheetId, "spreadsheetId"))}/values/${encodeURIComponent(requiredString(input.range, "range"))}:clear`), { method: "POST", body: "{}" }), { destructive: true, idempotent: true }),
  tool("sheets_add_sheet", "Add a sheet tab.", object({ spreadsheetId: string("Spreadsheet ID."), title: string("New sheet title."), rowCount: integer("Initial rows.", 1, 100_000), columnCount: integer("Initial columns.", 1, 1_000) }, ["spreadsheetId", "title"]), "full", { any: [SCOPE.driveFile, SCOPE.sheets] }, (token, input) => sheetsBatch(token, input, [{ addSheet: { properties: { title: requiredString(input.title, "title"), gridProperties: { rowCount: boundedInteger(input.rowCount, 1000, 1, 100_000), columnCount: boundedInteger(input.columnCount, 26, 1, 1_000) } } } }]), { openWorld: true }),
  tool("sheets_format_range", "Apply basic bold, italic, background, and number formatting to a grid range.", gridRangeSchema({ bold: boolean("Bold text."), italic: boolean("Italic text."), backgroundColorHex: string("Six-digit hex RGB."), numberPattern: string("Optional number-format pattern.") }), "full", { any: [SCOPE.driveFile, SCOPE.sheets] }, formatSheetRange, { idempotent: true }),
  tool("sheets_insert_dimension", "Insert rows or columns before a bounded index.", object({ spreadsheetId: string("Spreadsheet ID."), sheetId: integer("Numeric sheet ID.", 0, 2_147_483_647), dimension: string("ROWS or COLUMNS.", { enum: ["ROWS", "COLUMNS"] }), startIndex: integer("Zero-based start index.", 0, 1_000_000), count: integer("Number to insert.", 1, 1_000) }, ["spreadsheetId", "sheetId", "dimension", "startIndex", "count"]), "full", { any: [SCOPE.driveFile, SCOPE.sheets] }, (token, input) => sheetsBatch(token, input, [{ insertDimension: { range: { sheetId: boundedInteger(input.sheetId, 0, 0, 2_147_483_647), dimension: requiredEnum(input.dimension, ["ROWS", "COLUMNS"], "dimension"), startIndex: boundedInteger(input.startIndex, 0, 0, 1_000_000), endIndex: boundedInteger(input.startIndex, 0, 0, 1_000_000) + boundedInteger(input.count, 1, 1, 1_000) }, inheritFromBefore: false } }]), { idempotent: false }),

  tool("slides_read_presentation", "Read a Google Slides presentation.", object({ presentationId: string("Presentation ID.") }, ["presentationId"]), "read", driveReadScopes, (token, input) => googleJson(token, slidesUrl(`presentations/${encodeURIComponent(requiredString(input.presentationId, "presentationId"))}`))),
  tool("slides_get_page_thumbnail", "Get a temporary thumbnail URL for one slide.", object({ presentationId: string("Presentation ID."), pageObjectId: string("Slide object ID."), size: string("Thumbnail size.", { enum: ["SMALL", "MEDIUM", "LARGE"] }) }, ["presentationId", "pageObjectId"]), "read", driveReadScopes, (token, input) => googleJson(token, slidesUrl(`presentations/${encodeURIComponent(requiredString(input.presentationId, "presentationId"))}/pages/${encodeURIComponent(requiredString(input.pageObjectId, "pageObjectId"))}/thumbnail`, { "thumbnailProperties.mimeType": "PNG", "thumbnailProperties.thumbnailSize": optionalString(input.size) ?? "MEDIUM" }))),
  tool("slides_create_presentation", "Create a presentation.", object({ title: string("Presentation title.") }, ["title"]), "full", { any: [SCOPE.driveFile, SCOPE.slides] }, (token, input) => googleJson(token, slidesUrl("presentations"), { method: "POST", body: jsonBody({ title: requiredString(input.title, "title") }) }), { openWorld: true }),
  tool("slides_add_slide", "Add a slide using a predefined layout.", object({ presentationId: string("Presentation ID."), layout: string("Predefined layout.", { enum: ["BLANK", "TITLE", "TITLE_AND_BODY", "TITLE_ONLY", "SECTION_HEADER", "ONE_COLUMN_TEXT", "MAIN_POINT"] }), insertionIndex: integer("Optional zero-based insertion index.", 0, 10_000) }, ["presentationId"]), "full", { any: [SCOPE.driveFile, SCOPE.slides] }, addSlide, { openWorld: true }),
  tool("slides_add_text", "Add a text box to a slide.", object({ presentationId: string("Presentation ID."), pageObjectId: string("Target slide object ID."), text: string("Text."), x: number("X position in points."), y: number("Y position in points."), width: number("Width in points."), height: number("Height in points.") }, ["presentationId", "pageObjectId", "text"]), "full", { any: [SCOPE.driveFile, SCOPE.slides] }, addSlideText, { openWorld: true }),
  tool("slides_replace_text", "Replace all matching text in a presentation.", object({ presentationId: string("Presentation ID."), find: string("Text to find."), replace: string("Replacement."), matchCase: boolean("Match case."), pageObjectIds: stringArray("Optional slides to limit replacement.", 100) }, ["presentationId", "find", "replace"]), "full", { any: [SCOPE.driveFile, SCOPE.slides] }, (token, input) => slidesBatch(token, input, [{ replaceAllText: { containsText: { text: requiredString(input.find, "find"), matchCase: optionalBoolean(input.matchCase) ?? true }, replaceText: stringValue(input.replace), ...(optionalStringArray(input.pageObjectIds)?.length ? { pageObjectIds: optionalStringArray(input.pageObjectIds) } : {}) } }]), { idempotent: true }),
  tool("slides_add_image", "Add an image from a public HTTPS URL. Google requires PNG, JPEG, or GIF under 50 MB and 25 MP.", object({ presentationId: string("Presentation ID."), pageObjectId: string("Target slide object ID."), imageUrl: string("Public HTTPS image URL."), x: number("X points."), y: number("Y points."), width: number("Width points."), height: number("Height points.") }, ["presentationId", "pageObjectId", "imageUrl"]), "full", { any: [SCOPE.driveFile, SCOPE.slides] }, addSlideImage, { openWorld: true }),
  tool("slides_delete_object", "Delete a slide element or slide.", object({ presentationId: string("Presentation ID."), objectId: string("Object ID.") }, ["presentationId", "objectId"]), "full", { any: [SCOPE.driveFile, SCOPE.slides] }, (token, input) => slidesBatch(token, input, [{ deleteObject: { objectId: requiredString(input.objectId, "objectId") } }]), { destructive: true, idempotent: true }),

  tool("forms_get_form", "Read a Google Form and its questions.", object({ formId: string("Form ID.") }, ["formId"]), "read", driveReadScopes, (token, input) => googleJson(token, formsUrl(`forms/${encodeURIComponent(requiredString(input.formId, "formId"))}`))),
  tool("forms_list_responses", "List form responses with an optional timestamp filter.", object({ formId: string("Form ID."), filter: string("Only timestamp > or >= filters are supported."), pageSize: integer("Maximum responses.", 1, 500), pageToken: string("Continuation token.") }, ["formId"]), "read", { any: [SCOPE.driveFile, SCOPE.formsResponses] }, (token, input) => googleJson(token, formsUrl(`forms/${encodeURIComponent(requiredString(input.formId, "formId"))}/responses`, { filter: optionalString(input.filter), pageSize: boundedInteger(input.pageSize, 100, 1, 500), pageToken: optionalString(input.pageToken) }))),
  tool("forms_get_response", "Get one form response.", object({ formId: string("Form ID."), responseId: string("Response ID.") }, ["formId", "responseId"]), "read", { any: [SCOPE.driveFile, SCOPE.formsResponses] }, (token, input) => googleJson(token, formsUrl(`forms/${encodeURIComponent(requiredString(input.formId, "formId"))}/responses/${encodeURIComponent(requiredString(input.responseId, "responseId"))}`))),
  tool("forms_create_form", "Create an empty Google Form.", object({ title: string("Form title."), documentTitle: string("Optional Drive file title.") }, ["title"]), "full", { any: [SCOPE.driveFile, SCOPE.formsBody] }, (token, input) => googleJson(token, formsUrl("forms"), { method: "POST", body: jsonBody({ info: compact({ title: requiredString(input.title, "title"), documentTitle: optionalString(input.documentTitle) }) }) }), { openWorld: true }),
  tool("forms_add_question", "Add a text, paragraph, choice, checkbox, dropdown, scale, date, or time question.", formQuestionSchema(false), "full", { any: [SCOPE.driveFile, SCOPE.formsBody] }, addFormQuestion, { openWorld: true }),
  tool("forms_update_question", "Replace an existing question item.", formQuestionSchema(true), "full", { any: [SCOPE.driveFile, SCOPE.formsBody] }, updateFormQuestion, { idempotent: true }),
  tool("forms_move_item", "Move a form item to a new zero-based index.", object({ formId: string("Form ID."), originalIndex: integer("Current index.", 0, 10_000), newIndex: integer("New index.", 0, 10_000), revisionId: string("Optional required revision ID.") }, ["formId", "originalIndex", "newIndex"]), "full", { any: [SCOPE.driveFile, SCOPE.formsBody] }, (token, input) => formsBatch(token, input, [{ moveItem: { originalLocation: { index: boundedInteger(input.originalIndex, 0, 0, 10_000) }, newLocation: { index: boundedInteger(input.newIndex, 0, 0, 10_000) } } }]), { idempotent: true }),
  tool("forms_delete_item", "Delete a form item by zero-based index.", object({ formId: string("Form ID."), index: integer("Item index.", 0, 10_000), revisionId: string("Optional required revision ID.") }, ["formId", "index"]), "full", { any: [SCOPE.driveFile, SCOPE.formsBody] }, (token, input) => formsBatch(token, input, [{ deleteItem: { location: { index: boundedInteger(input.index, 0, 0, 10_000) } } }]), { destructive: true, idempotent: true }),
  tool("forms_set_publish_state", "Publish, unpublish, open, or close a form.", object({ formId: string("Form ID."), isPublished: boolean("Whether the form is published."), isAcceptingResponses: boolean("Whether responses are accepted.") }, ["formId", "isPublished", "isAcceptingResponses"]), "full", { any: [SCOPE.driveFile, SCOPE.formsBody] }, setFormPublishState, { destructive: true, idempotent: true, openWorld: true }),
];

const gmailTools: ToolDefinition[] = [
  tool("gmail_search_threads", "Search Gmail threads using Gmail API search syntax.", gmailSearchSchema("threads"), "read", { any: [SCOPE.gmailRead, SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl("users/me/threads", gmailSearchQuery(input)))),
  tool("gmail_search_messages", "Search individual Gmail messages using Gmail API search syntax.", gmailSearchSchema("messages"), "read", { any: [SCOPE.gmailRead, SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl("users/me/messages", gmailSearchQuery(input)))),
  tool("gmail_get_thread", "Get a Gmail thread and its messages.", gmailGetSchema("threadId"), "read", { any: [SCOPE.gmailRead, SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl(`users/me/threads/${encodeURIComponent(requiredString(input.threadId, "threadId"))}`, gmailGetQuery(input)))),
  tool("gmail_get_message", "Get one Gmail message.", gmailGetSchema("messageId", true), "read", { any: [SCOPE.gmailRead, SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl(`users/me/messages/${encodeURIComponent(requiredString(input.messageId, "messageId"))}`, gmailGetQuery(input)))),
  tool("gmail_get_attachment", "Download one Gmail attachment as base64url data.", object({ messageId: string("Message ID."), attachmentId: string("Attachment ID.") }, ["messageId", "attachmentId"]), "read", { any: [SCOPE.gmailRead, SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl(`users/me/messages/${encodeURIComponent(requiredString(input.messageId, "messageId"))}/attachments/${encodeURIComponent(requiredString(input.attachmentId, "attachmentId"))}`))),
  tool("gmail_list_labels", "List Gmail labels.", object({}), "read", { any: [SCOPE.gmailRead, SCOPE.gmailModify] }, (token) => googleJson(token, gmailUrl("users/me/labels"))),
  tool("gmail_list_drafts", "List Gmail drafts.", gmailSearchSchema("drafts"), "read", { any: [SCOPE.gmailRead, SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl("users/me/drafts", gmailSearchQuery(input)))),
  tool("gmail_get_draft", "Get one Gmail draft.", object({ draftId: string("Draft ID."), format: string("Message format.", { enum: ["full", "metadata", "minimal", "raw"] }) }, ["draftId"]), "read", { any: [SCOPE.gmailRead, SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl(`users/me/drafts/${encodeURIComponent(requiredString(input.draftId, "draftId"))}`, { format: optionalString(input.format) ?? "full" }))),
  tool("gmail_create_draft", "Create a reviewable Gmail draft. This does not send it.", mailSchema(), "full", { all: [SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl("users/me/drafts"), { method: "POST", body: jsonBody({ message: compact({ raw: encodeMail(input), threadId: optionalString(input.threadId) }) }) }), { openWorld: true, approvalRequired: false }),
  tool("gmail_update_draft", "Replace the content of a Gmail draft.", mailSchema({ draftId: string("Draft ID.") }, ["draftId"]), "full", { all: [SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl(`users/me/drafts/${encodeURIComponent(requiredString(input.draftId, "draftId"))}`), { method: "PUT", body: jsonBody({ id: requiredString(input.draftId, "draftId"), message: compact({ raw: encodeMail(input), threadId: optionalString(input.threadId) }) }) }), { idempotent: true, openWorld: true, approvalRequired: false }),
  tool("gmail_send_draft", "Send an existing Gmail draft.", object({ draftId: string("Draft ID.") }, ["draftId"]), "full", { all: [SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl("users/me/drafts/send"), { method: "POST", body: jsonBody({ id: requiredString(input.draftId, "draftId") }) }), { destructive: true, openWorld: true }),
  tool("gmail_send_message", "Send an email from the connected Gmail account.", mailSchema(), "full", { all: [SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl("users/me/messages/send"), { method: "POST", body: jsonBody(compact({ raw: encodeMail(input), threadId: optionalString(input.threadId) })) }), { destructive: true, openWorld: true }),
  tool("gmail_reply_to_thread", "Send a correctly threaded reply. Supply the parent Message-ID and References headers from the thread.", mailSchema({ threadId: string("Thread ID."), inReplyTo: string("Parent Message-ID header."), references: string("References header."), subject: string("Matching subject.") }, ["threadId", "inReplyTo", "references"]), "full", { all: [SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl("users/me/messages/send"), { method: "POST", body: jsonBody({ raw: encodeMail(input), threadId: requiredString(input.threadId, "threadId") }) }), { destructive: true, openWorld: true }),
  tool("gmail_apply_labels", "Apply labels to a message or thread.", gmailLabelsSchema(true), "full", { all: [SCOPE.gmailModify] }, (token, input) => modifyGmailLabels(token, { ...input, remove: false }), { idempotent: true }),
  tool("gmail_remove_labels", "Remove labels from a message or thread.", gmailLabelsSchema(false), "full", { all: [SCOPE.gmailModify] }, (token, input) => modifyGmailLabels(token, { ...input, remove: true }), { idempotent: true }),
  tool("gmail_mark_read", "Mark a message or thread read.", gmailTargetSchema(), "full", { all: [SCOPE.gmailModify] }, (token, input) => modifyGmailLabels(token, { ...input, labelIds: ["UNREAD"], remove: true }), { idempotent: true }),
  tool("gmail_mark_unread", "Mark a message or thread unread.", gmailTargetSchema(), "full", { all: [SCOPE.gmailModify] }, (token, input) => modifyGmailLabels(token, { ...input, labelIds: ["UNREAD"], remove: false }), { idempotent: true }),
  tool("gmail_trash_message", "Move a Gmail message to trash.", object({ messageId: string("Message ID.") }, ["messageId"]), "full", { all: [SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl(`users/me/messages/${encodeURIComponent(requiredString(input.messageId, "messageId"))}/trash`), { method: "POST", body: "{}" }), { destructive: true, idempotent: true }),
  tool("gmail_untrash_message", "Restore a Gmail message from trash.", object({ messageId: string("Message ID.") }, ["messageId"]), "full", { all: [SCOPE.gmailModify] }, (token, input) => googleJson(token, gmailUrl(`users/me/messages/${encodeURIComponent(requiredString(input.messageId, "messageId"))}/untrash`), { method: "POST", body: "{}" }), { idempotent: true }),
];

const calendarTools: ToolDefinition[] = [
  tool("google_calendar_list_calendars", "List calendars visible to the connected account.", object({ maxResults: integer("Maximum calendars.", 1, 250), pageToken: string("Continuation token."), showHidden: boolean("Include hidden calendars.") }), "read", { all: [SCOPE.calendarListRead] }, (token, input) => googleJson(token, calendarUrl("users/me/calendarList", { maxResults: boundedInteger(input.maxResults, 100, 1, 250), pageToken: optionalString(input.pageToken), showHidden: optionalBoolean(input.showHidden) }))),
  tool("google_calendar_list_events", "List or search events on one calendar.", calendarListEventsSchema(), "read", { any: [SCOPE.calendarEventsRead, SCOPE.calendarEvents] }, listCalendarEvents),
  tool("google_calendar_get_event", "Get one Calendar event.", object({ calendarId: string("Calendar ID, normally primary."), eventId: string("Event ID.") }, ["eventId"]), "read", { any: [SCOPE.calendarEventsRead, SCOPE.calendarEvents] }, (token, input) => googleJson(token, calendarUrl(`calendars/${encodeURIComponent(optionalString(input.calendarId) ?? "primary")}/events/${encodeURIComponent(requiredString(input.eventId, "eventId"))}`))),
  tool("google_calendar_query_freebusy", "Query free/busy data for up to 50 calendars.", freeBusySchema(), "read", { all: [SCOPE.calendarFreeBusy] }, queryFreeBusy),
  tool("google_calendar_suggest_times", "Find available slots shared by the supplied calendars.", object({ ...freeBusySchema().properties as Record<string, unknown>, durationMinutes: integer("Required slot length.", 5, 480), intervalMinutes: integer("Candidate step.", 5, 120) }, ["timeMin", "timeMax", "calendarIds", "durationMinutes"]), "read", { all: [SCOPE.calendarFreeBusy] }, suggestCalendarTimes),
  tool("google_calendar_create_event", "Create a Calendar event with explicit invitation-email behavior.", calendarEventSchema(false), "full", { all: [SCOPE.calendarEvents] }, createCalendarEvent, { openWorld: true }),
  tool("google_calendar_update_event", "Update a Calendar event by reading and safely replacing the current resource.", calendarEventSchema(true), "full", { all: [SCOPE.calendarEvents] }, updateCalendarEvent, { openWorld: true }),
  tool("google_calendar_respond_to_event", "Accept, decline, or tentatively accept an invitation.", object({ calendarId: string("Calendar ID."), eventId: string("Event ID."), responseStatus: string("Response.", { enum: ["accepted", "declined", "tentative"] }), sendUpdates: string("Invitation email behavior.", { enum: ["all", "externalOnly", "none"] }) }, ["eventId", "responseStatus"]), "full", { all: [SCOPE.calendarEvents] }, respondToEvent, { openWorld: true }),
  tool("google_calendar_delete_event", "Delete an event and explicitly choose invitation-email behavior.", object({ calendarId: string("Calendar ID."), eventId: string("Event ID."), sendUpdates: string("Invitation email behavior.", { enum: ["all", "externalOnly", "none"] }) }, ["eventId"]), "full", { all: [SCOPE.calendarEvents] }, (token, input) => googleJson(token, calendarUrl(`calendars/${encodeURIComponent(optionalString(input.calendarId) ?? "primary")}/events/${encodeURIComponent(requiredString(input.eventId, "eventId"))}`, { sendUpdates: optionalString(input.sendUpdates) ?? "none" }), { method: "DELETE" }), { destructive: true, idempotent: true, openWorld: true }),
];

const toolsByConnector: Record<GoogleConnectorKey, ToolDefinition[]> = { "google-workspace": workspaceTools, gmail: gmailTools, "google-calendar": calendarTools };

export const GOOGLE_CONNECTOR_SERVICES: Record<GoogleConnectorKey, string[]> = {
  "google-workspace": ["Google Drive", "Google Docs", "Google Sheets", "Google Slides", "Google Forms"],
  gmail: ["Gmail"],
  "google-calendar": ["Google Calendar"],
};

export function googleConnectorScopes(connector: GoogleConnectorKey, access: GoogleAccessLevel, workspaceMode: ConnectorWorkspaceAccessMode = "selected_files"): string[] {
  if (connector === "gmail") return [access === "full" ? SCOPE.gmailModify : SCOPE.gmailRead];
  if (connector === "google-calendar") return [access === "full" ? SCOPE.calendarEvents : SCOPE.calendarEventsRead, SCOPE.calendarListRead, SCOPE.calendarFreeBusy];
  if (workspaceMode === "selected_files") return [SCOPE.driveFile];
  return access === "read"
    ? [SCOPE.driveRead, SCOPE.formsResponses]
    : [SCOPE.driveRead, SCOPE.driveFile, SCOPE.docs, SCOPE.sheets, SCOPE.slides, SCOPE.formsBody, SCOPE.formsResponses];
}

export function googleToolCatalog(connector: GoogleConnectorKey, access: GoogleAccessLevel, grantedScopes?: readonly string[]): McpCachedTool[] {
  return availableGoogleTools(connector, access, grantedScopes)
    .map(({ access: _access, approvalRequired: _approvalRequired, scopes: _scopes, run: _run, ...item }) => item);
}

export function googleToolsRequiringApproval(connector: GoogleConnectorKey, access: GoogleAccessLevel, grantedScopes?: readonly string[]): string[] {
  return availableGoogleTools(connector, access, grantedScopes)
    .filter((item) => item.approvalRequired)
    .map((item) => item.name);
}

export async function executeGoogleTool(connector: GoogleConnectorKey, access: GoogleAccessLevel, name: string, token: string, input: Record<string, unknown>, accountEmail: string | null, grantedScopes: readonly string[]): Promise<unknown> {
  const definition = toolsByConnector[connector].find((candidate) => candidate.name === name);
  if (!definition || (access === "read" && definition.access === "full") || !scopeAllows(definition.scopes, grantedScopes)) throw new Error(`Tool ${name} is not authorized for this connection`);
  return definition.run(token, input, { accountEmail });
}

function scopeAllows(requirement: ScopeRequirement, granted: readonly string[]): boolean {
  const values = new Set(granted);
  return (requirement.all?.every((scope) => values.has(scope)) ?? true) && (!requirement.any?.length || requirement.any.some((scope) => values.has(scope)));
}

function availableGoogleTools(connector: GoogleConnectorKey, access: GoogleAccessLevel, grantedScopes?: readonly string[]): ToolDefinition[] {
  return toolsByConnector[connector]
    .filter((item) => (access === "full" || item.access === "read") && (!grantedScopes || scopeAllows(item.scopes, grantedScopes)));
}

const DRIVE_FIELDS = "id,name,mimeType,size,modifiedTime,createdTime,webViewLink,iconLink,owners,parents,trashed,driveId,capabilities,contentRestrictions,downloadRestrictions,linkShareMetadata,copyRequiresWriterPermission,viewersCanCopyContent,hasAugmentedPermissions,resourceKey";
function driveUrl(path: string, query: Record<string, QueryValue> = {}) { return apiUrl("https://www.googleapis.com/drive/v3/", path, query); }
function docsUrl(path: string, query: Record<string, QueryValue> = {}) { return apiUrl("https://docs.googleapis.com/v1/", path, query); }
function sheetsUrl(path: string, query: Record<string, QueryValue> = {}) { return apiUrl("https://sheets.googleapis.com/v4/", path, query); }
function slidesUrl(path: string, query: Record<string, QueryValue> = {}) { return apiUrl("https://slides.googleapis.com/v1/", path, query); }
function formsUrl(path: string, query: Record<string, QueryValue> = {}) { return apiUrl("https://forms.googleapis.com/v1/", path, query); }
function gmailUrl(path: string, query: Record<string, QueryValue> = {}) { return apiUrl("https://gmail.googleapis.com/gmail/v1/", path, query); }
function calendarUrl(path: string, query: Record<string, QueryValue> = {}) { return apiUrl("https://www.googleapis.com/calendar/v3/", path, query); }
type QueryValue = string | number | boolean | string[] | undefined;
function apiUrl(base: string, path: string, query: Record<string, QueryValue>): string { const url = new URL(path, base); for (const [key, value] of Object.entries(query)) { if (value === undefined) continue; for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item)); } return url.toString(); }

async function googleJson(token: string, url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await googleFetch(token, url, init);
  if (response.status === 204) return { ok: true };
  const text = await readBoundedText(
    response,
    response.ok ? GOOGLE_TOOL_OUTPUT_LIMIT_BYTES : GOOGLE_ERROR_BODY_LIMIT_BYTES,
    response.ok
      ? "Google API response exceeds Berry's 10 MB tool-output limit"
      : "Google API error response exceeds Berry's 1 MB limit",
  );
  if (!response.ok) throw googleError(response.status, text);
  if (!text) return { ok: true };
  try { return JSON.parse(text) as unknown; } catch { return { text: text.slice(0, 2_000_000) }; }
}

async function googleFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${token}`); if (init.body && !headers.has("content-type") && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  let last: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) }); last = response;
    if (![429, 500, 502, 503, 504].includes(response.status) && !(response.status === 403 && response.headers.get("retry-after"))) return response;
    if (attempt === 3 || (init.method && !["GET", "HEAD", "PUT", "DELETE"].includes(init.method.toUpperCase()))) return response;
    const retryAfter = Number(response.headers.get("retry-after")); const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 300);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return last!;
}
function googleError(status: number, text: string): Error { let message = `HTTP ${status}`; try { const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } }; message = parsed.error?.message ?? parsed.error?.status ?? message; } catch { /* redacted fallback */ } return new Error(`Google API ${status}: ${message.slice(0, 500)}`); }

async function searchDriveFiles(token: string, input: Record<string, unknown>): Promise<unknown> {
  const driveId = optionalString(input.driveId);
  const result = await googleJson(token, driveUrl("files", { q: optionalString(input.query), pageSize: boundedInteger(input.pageSize, 50, 1, 100), pageToken: optionalString(input.pageToken), orderBy: optionalString(input.orderBy), spaces: "drive", corpora: driveId ? "drive" : "user", driveId, includeItemsFromAllDrives: true, supportsAllDrives: true, fields: `nextPageToken,incompleteSearch,files(${DRIVE_FIELDS})` })) as Record<string, unknown>;
  const files = Array.isArray(result.files) ? result.files.filter((file) => eligibleDriveFile(file)) : [];
  return { ...result, files, omittedIneligibleCount: Math.max(0, (Array.isArray(result.files) ? result.files.length : 0) - files.length) };
}
function eligibleDriveFile(value: unknown): boolean { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const file = value as Record<string, unknown>; const capabilities = record(file.capabilities); return file.trashed !== true && capabilities?.canAccessViaGenAi !== false; }
async function driveFilePreflight(token: string, fileId: string, operation: "read" | "download" | "edit" | "copy"): Promise<Record<string, unknown>> {
  const file = await googleJson(token, driveUrl(`files/${encodeURIComponent(fileId)}`, { fields: DRIVE_FIELDS, supportsAllDrives: true })) as Record<string, unknown>;
  const capabilities = record(file.capabilities) ?? {};
  if (file.trashed === true && operation !== "edit") throw new Error("Drive file is in trash");
  if (capabilities.canAccessViaGenAi === false) throw new Error("Google policy does not allow this file to be used with generative AI");
  if (operation === "download" && capabilities.canDownload === false) throw new Error("Drive download is restricted for this file");
  if (operation === "copy" && capabilities.canCopy === false) throw new Error("Drive copy is restricted for this file");
  if (operation === "edit" && capabilities.canEdit === false) throw new Error("The connected account cannot edit this Drive file");
  if (Array.isArray(file.contentRestrictions) && file.contentRestrictions.some((item) => record(item)?.readOnly === true) && operation === "edit") throw new Error("Drive file is read-only due to a content restriction");
  return file;
}
async function readDriveFile(token: string, input: Record<string, unknown>): Promise<unknown> {
  const fileId = requiredString(input.fileId, "fileId"); const metadata = await driveFilePreflight(token, fileId, "download"); const mimeType = requiredString(metadata.mimeType, "mimeType");
  if (mimeType === "application/vnd.google-apps.folder") throw new Error("Drive folders cannot be downloaded");
  const googleMime = mimeType.startsWith("application/vnd.google-apps."); const exportMimeType = optionalString(input.exportMimeType) ?? defaultExportMime(mimeType);
  const response = await googleFetch(token, googleMime ? driveUrl(`files/${encodeURIComponent(fileId)}/export`, { mimeType: exportMimeType }) : driveUrl(`files/${encodeURIComponent(fileId)}`, { alt: "media", supportsAllDrives: true }));
  if (!response.ok) throw googleError(response.status, await readBoundedText(response, GOOGLE_ERROR_BODY_LIMIT_BYTES, "Google API error response exceeds Berry's 1 MB limit"));
  const bytes = await readBoundedBody(response, GOOGLE_TOOL_OUTPUT_LIMIT_BYTES, "Drive content exceeds Berry's 10 MB tool-output limit");
  const contentType = response.headers.get("content-type")?.split(";")[0] ?? exportMimeType ?? mimeType; const textual = contentType.startsWith("text/") || contentType === "application/json" || contentType.includes("csv");
  return { ...metadata, contentType, encoding: textual ? "text" : "base64", content: textual ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString("base64") };
}

async function readBoundedText(response: Response, maximumBytes: number, limitMessage: string): Promise<string> {
  return new TextDecoder().decode(await readBoundedBody(response, maximumBytes, limitMessage));
}

async function readBoundedBody(response: Response, maximumBytes: number, limitMessage: string): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(limitMessage);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(limitMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function uploadDriveFile(token: string, input: Record<string, unknown>): Promise<unknown> {
  const metadata = compact({ name: requiredString(input.name, "name"), mimeType: optionalString(input.mimeType), parents: optionalString(input.parentId) ? [optionalString(input.parentId)] : undefined }); const content = requiredString(input.content, "content"); const bytes = (optionalString(input.contentEncoding) ?? "text") === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
  if (bytes.byteLength <= 5 * 1024 * 1024) { const form = new FormData(); form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" })); form.append("file", new Blob([bytes], { type: optionalString(input.mimeType) ?? "application/octet-stream" })); return googleJson(token, apiUrl("https://www.googleapis.com/upload/drive/v3/", "files", { uploadType: "multipart", supportsAllDrives: true, fields: DRIVE_FIELDS }), { method: "POST", body: form }); }
  const start = await googleFetch(token, apiUrl("https://www.googleapis.com/upload/drive/v3/", "files", { uploadType: "resumable", supportsAllDrives: true, fields: DRIVE_FIELDS }), { method: "POST", headers: { "content-type": "application/json", "x-upload-content-type": optionalString(input.mimeType) ?? "application/octet-stream", "x-upload-content-length": String(bytes.byteLength) }, body: JSON.stringify(metadata) });
  if (!start.ok) throw googleError(start.status, await readBoundedText(start, GOOGLE_ERROR_BODY_LIMIT_BYTES, "Google API error response exceeds Berry's 1 MB limit"));
  const location = start.headers.get("location"); if (!location) throw new Error("Google did not return a resumable upload URL");
  return googleJson(token, location, { method: "PUT", headers: { "content-type": optionalString(input.mimeType) ?? "application/octet-stream", "content-length": String(bytes.byteLength) }, body: bytes });
}
async function updateDriveMetadata(token: string, input: Record<string, unknown>, metadata: Record<string, unknown>, addParent?: string, removeParents?: string[]): Promise<unknown> { const fileId = requiredString(input.fileId, "fileId"); await driveFilePreflight(token, fileId, "edit"); return googleJson(token, driveUrl(`files/${encodeURIComponent(fileId)}`, { supportsAllDrives: true, addParents: addParent, removeParents: removeParents?.join(","), fields: DRIVE_FIELDS }), { method: "PATCH", body: jsonBody(metadata) }); }

function writeControl(input: Record<string, unknown>): Record<string, unknown> | undefined { return optionalString(input.revisionId) ? { requiredRevisionId: optionalString(input.revisionId) } : undefined; }
function docsBatch(token: string, input: Record<string, unknown>, requests: unknown[]) { return googleJson(token, docsUrl(`documents/${encodeURIComponent(requiredString(input.documentId, "documentId"))}:batchUpdate`), { method: "POST", body: jsonBody(compact({ requests, writeControl: writeControl(input) })) }); }
function styleDocumentText(token: string, input: Record<string, unknown>) { const style = compact({ bold: optionalBoolean(input.bold), italic: optionalBoolean(input.italic), underline: optionalBoolean(input.underline), fontSize: typeof input.fontSizePt === "number" ? { magnitude: input.fontSizePt, unit: "PT" } : undefined }); const fields = Object.keys(style).join(","); if (!fields) throw new Error("At least one style must be supplied"); return docsBatch(token, input, [{ updateTextStyle: { range: compact({ startIndex: boundedInteger(input.startIndex, 1, 1, 10_000_000), endIndex: boundedInteger(input.endIndex, 1, 1, 10_000_000), tabId: optionalString(input.tabId) }), textStyle: style, fields } }]); }

function valuesReadSchema(batch: boolean): Record<string, unknown> { return object({ spreadsheetId: string("Spreadsheet ID."), ...(batch ? { ranges: stringArray("A1 ranges.", 100) } : { range: string("A1 range.") }), majorDimension: string("ROWS or COLUMNS.", { enum: ["ROWS", "COLUMNS"] }), valueRenderOption: string("Value rendering.", { enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"] }) }, ["spreadsheetId", batch ? "ranges" : "range"]); }
function valuesWriteSchema(_batch: boolean): Record<string, unknown> { return object({ spreadsheetId: string("Spreadsheet ID."), range: string("A1 range."), values: twoDimensionalValues(), valueInputOption: string("RAW or USER_ENTERED.", { enum: ["RAW", "USER_ENTERED"] }), majorDimension: string("ROWS or COLUMNS.", { enum: ["ROWS", "COLUMNS"] }) }, ["spreadsheetId", "range", "values"]); }
function boundedValues(value: unknown): unknown[][] { const rows = requiredArray(value, "values"); if (rows.length > 10_000) throw new Error("values exceeds 10,000 rows"); const normalized = rows.map((row) => { if (!Array.isArray(row) || row.length > 1_000) throw new Error("Each values row must contain at most 1,000 cells"); return row; }); if (Buffer.byteLength(JSON.stringify(normalized)) > 2 * 1024 * 1024) throw new Error("Sheets payload exceeds the 2 MB connector limit"); return normalized; }
function sheetsBatch(token: string, input: Record<string, unknown>, requests: unknown[]) { return googleJson(token, sheetsUrl(`spreadsheets/${encodeURIComponent(requiredString(input.spreadsheetId, "spreadsheetId"))}:batchUpdate`), { method: "POST", body: jsonBody({ requests, includeSpreadsheetInResponse: false }) }); }
function gridRangeSchema(extra: Record<string, unknown>): Record<string, unknown> { return object({ spreadsheetId: string("Spreadsheet ID."), sheetId: integer("Numeric sheet ID.", 0, 2_147_483_647), startRowIndex: integer("Zero-based start row.", 0, 1_000_000), endRowIndex: integer("Exclusive end row.", 1, 1_000_000), startColumnIndex: integer("Zero-based start column.", 0, 100_000), endColumnIndex: integer("Exclusive end column.", 1, 100_000), ...extra }, ["spreadsheetId", "sheetId", "startRowIndex", "endRowIndex", "startColumnIndex", "endColumnIndex"]); }
function formatSheetRange(token: string, input: Record<string, unknown>) { const textFormat = compact({ bold: optionalBoolean(input.bold), italic: optionalBoolean(input.italic) }); const hex = optionalString(input.backgroundColorHex); const backgroundColor = hex ? hexColor(hex) : undefined; const numberFormat = optionalString(input.numberPattern) ? { type: "NUMBER", pattern: optionalString(input.numberPattern) } : undefined; const userEnteredFormat = compact({ textFormat: Object.keys(textFormat).length ? textFormat : undefined, backgroundColor, numberFormat }); const fields = Object.keys(userEnteredFormat).map((key) => `userEnteredFormat.${key}`).join(","); if (!fields) throw new Error("At least one format must be supplied"); return sheetsBatch(token, input, [{ repeatCell: { range: { sheetId: boundedInteger(input.sheetId, 0, 0, 2_147_483_647), startRowIndex: boundedInteger(input.startRowIndex, 0, 0, 1_000_000), endRowIndex: boundedInteger(input.endRowIndex, 1, 1, 1_000_000), startColumnIndex: boundedInteger(input.startColumnIndex, 0, 0, 100_000), endColumnIndex: boundedInteger(input.endColumnIndex, 1, 1, 100_000) }, cell: { userEnteredFormat }, fields } }]); }

function slidesBatch(token: string, input: Record<string, unknown>, requests: unknown[]) { return googleJson(token, slidesUrl(`presentations/${encodeURIComponent(requiredString(input.presentationId, "presentationId"))}:batchUpdate`), { method: "POST", body: jsonBody({ requests }) }); }
function addSlide(token: string, input: Record<string, unknown>) { const objectId = googleObjectId("slide"); return slidesBatch(token, input, [{ createSlide: compact({ objectId, insertionIndex: optionalInteger(input.insertionIndex), slideLayoutReference: { predefinedLayout: optionalString(input.layout) ?? "BLANK" } }) }]); }
function points(value: unknown, fallback: number): { magnitude: number; unit: "PT" } { return { magnitude: typeof value === "number" && Number.isFinite(value) ? value : fallback, unit: "PT" }; }
function transform(x: unknown, y: unknown) { return { scaleX: 1, scaleY: 1, translateX: points(x, 36).magnitude, translateY: points(y, 36).magnitude, unit: "PT" }; }
function addSlideText(token: string, input: Record<string, unknown>) { const objectId = googleObjectId("text"); return slidesBatch(token, input, [{ createShape: { objectId, shapeType: "TEXT_BOX", elementProperties: { pageObjectId: requiredString(input.pageObjectId, "pageObjectId"), size: { width: points(input.width, 648), height: points(input.height, 72) }, transform: transform(input.x, input.y) } } }, { insertText: { objectId, text: requiredString(input.text, "text") } }]); }
function addSlideImage(token: string, input: Record<string, unknown>) { const imageUrl = new URL(requiredString(input.imageUrl, "imageUrl")); if (imageUrl.protocol !== "https:" || imageUrl.toString().length > 2_000) throw new Error("imageUrl must be a public HTTPS URL no longer than 2,000 characters"); return slidesBatch(token, input, [{ createImage: { objectId: googleObjectId("image"), url: imageUrl.toString(), elementProperties: { pageObjectId: requiredString(input.pageObjectId, "pageObjectId"), size: { width: points(input.width, 320), height: points(input.height, 180) }, transform: transform(input.x, input.y) } } }]); }

function formQuestionSchema(update: boolean): Record<string, unknown> { return object({ formId: string("Form ID."), index: integer(update ? "Current item index." : "Insertion index.", 0, 10_000), ...(update ? { itemId: string("Existing item ID.") } : {}), title: string("Question title."), description: string("Optional description."), required: boolean("Whether required."), type: string("Question type.", { enum: ["text", "paragraph", "radio", "checkbox", "dropdown", "scale", "date", "time"] }), options: stringArray("Choice labels.", 200), low: integer("Scale low value.", 0, 10), high: integer("Scale high value.", 1, 10), lowLabel: string("Scale low label."), highLabel: string("Scale high label."), revisionId: string("Optional required revision ID.") }, ["formId", ...(update ? ["itemId", "index"] : []), "title", "type"]); }
function formQuestion(input: Record<string, unknown>): Record<string, unknown> { const type = requiredEnum(input.type, ["text", "paragraph", "radio", "checkbox", "dropdown", "scale", "date", "time"], "type"); const required = optionalBoolean(input.required) ?? false; const options = optionalStringArray(input.options) ?? []; let question: Record<string, unknown>; if (type === "text" || type === "paragraph") question = { required, textQuestion: { paragraph: type === "paragraph" } }; else if (["radio", "checkbox", "dropdown"].includes(type)) { if (!options.length) throw new Error("Choice questions require options"); question = { required, choiceQuestion: { type: type === "radio" ? "RADIO" : type === "checkbox" ? "CHECKBOX" : "DROP_DOWN", options: options.map((value) => ({ value })) } }; } else if (type === "scale") question = { required, scaleQuestion: compact({ low: boundedInteger(input.low, 1, 0, 10), high: boundedInteger(input.high, 5, 1, 10), lowLabel: optionalString(input.lowLabel), highLabel: optionalString(input.highLabel) }) }; else if (type === "date") question = { required, dateQuestion: { includeTime: false, includeYear: true } }; else question = { required, timeQuestion: { duration: false } }; return { title: requiredString(input.title, "title"), description: optionalString(input.description), questionItem: { question } }; }
function formsBatch(token: string, input: Record<string, unknown>, requests: unknown[]) { return googleJson(token, formsUrl(`forms/${encodeURIComponent(requiredString(input.formId, "formId"))}:batchUpdate`), { method: "POST", body: jsonBody(compact({ requests, includeFormInResponse: true, writeControl: writeControl(input) })) }); }
function addFormQuestion(token: string, input: Record<string, unknown>) { return formsBatch(token, input, [{ createItem: { item: formQuestion(input), location: { index: boundedInteger(input.index, 0, 0, 10_000) } } }]); }
function updateFormQuestion(token: string, input: Record<string, unknown>) { return formsBatch(token, input, [{ updateItem: { item: { itemId: requiredString(input.itemId, "itemId"), ...formQuestion(input) }, location: { index: boundedInteger(input.index, 0, 0, 10_000) }, updateMask: "title,description,questionItem" } }]); }
function setFormPublishState(token: string, input: Record<string, unknown>) { const published = requiredBoolean(input.isPublished, "isPublished"); const accepting = requiredBoolean(input.isAcceptingResponses, "isAcceptingResponses"); if (!published && accepting) throw new Error("A form cannot accept responses while unpublished"); return googleJson(token, formsUrl(`forms/${encodeURIComponent(requiredString(input.formId, "formId"))}:setPublishSettings`), { method: "POST", body: jsonBody({ publishSettings: { publishState: { isPublished: published, isAcceptingResponses: accepting } }, updateMask: "publishState" }) }); }

function gmailSearchSchema(noun: string): Record<string, unknown> { return object({ query: string("Gmail search query."), maxResults: integer(`Maximum ${noun}.`, 1, 500), pageToken: string("Continuation token."), includeSpamTrash: boolean("Include spam and trash.") }); }
function gmailSearchQuery(input: Record<string, unknown>): Record<string, QueryValue> { return { q: optionalString(input.query), maxResults: boundedInteger(input.maxResults, 50, 1, 500), pageToken: optionalString(input.pageToken), includeSpamTrash: optionalBoolean(input.includeSpamTrash) }; }
function gmailGetSchema(id: string, raw = false): Record<string, unknown> { return object({ [id]: string("Gmail resource ID."), format: string("Response format.", { enum: raw ? ["full", "metadata", "minimal", "raw"] : ["full", "metadata", "minimal"] }), metadataHeaders: stringArray("Headers returned with metadata format.", 100) }, [id]); }
function gmailGetQuery(input: Record<string, unknown>): Record<string, QueryValue> { return { format: optionalString(input.format) ?? "full", metadataHeaders: optionalStringArray(input.metadataHeaders) }; }
function mailSchema(extra: Record<string, unknown> = {}, extraRequired: string[] = []): Record<string, unknown> { return object({ to: stringArray("To recipients.", 500), cc: stringArray("CC recipients.", 500), bcc: stringArray("BCC recipients.", 500), subject: string("Email subject."), body: string("Email body."), contentType: string("Body format.", { enum: ["text/plain", "text/html"] }), attachments: { type: "array", maxItems: 20, items: object({ filename: string("Filename."), mimeType: string("MIME type."), dataBase64: string("Base64 attachment data.") }, ["filename", "dataBase64"]) }, threadId: string("Optional thread ID."), inReplyTo: string("Optional parent Message-ID."), references: string("Optional References header."), ...extra }, ["to", "subject", "body", ...extraRequired]); }
function encodeMail(input: Record<string, unknown>): string { const to = requiredStringArray(input.to, "to"); const cc = optionalStringArray(input.cc) ?? []; const bcc = optionalStringArray(input.bcc) ?? []; if (to.length + cc.length + bcc.length > 500) throw new Error("Gmail allows at most 500 recipients per message"); const attachments = Array.isArray(input.attachments) ? input.attachments.map((value) => requiredObject(value, "attachment")) : []; const baseHeaders = [`To: ${safeHeaderList(to)}`, ...(cc.length ? [`Cc: ${safeHeaderList(cc)}`] : []), ...(bcc.length ? [`Bcc: ${safeHeaderList(bcc)}`] : []), `Subject: ${safeHeader(requiredString(input.subject, "subject"))}`, "MIME-Version: 1.0", ...(optionalString(input.inReplyTo) ? [`In-Reply-To: ${safeHeader(optionalString(input.inReplyTo)!)}`] : []), ...(optionalString(input.references) ? [`References: ${safeHeader(optionalString(input.references)!)}`] : [])]; const contentType = optionalString(input.contentType) ?? "text/plain"; let raw: string; if (!attachments.length) raw = `${baseHeaders.join("\r\n")}\r\nContent-Type: ${contentType}; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${stringValue(input.body)}`; else { const boundary = `berry_${randomUUID().replace(/-/g, "")}`; const parts = [`${baseHeaders.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${boundary}"`, `--${boundary}\r\nContent-Type: ${contentType}; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${stringValue(input.body)}`]; for (const attachment of attachments) { const filename = safeHeader(requiredString(attachment.filename, "attachment filename")).replace(/["\\]/g, "_"); const data = Buffer.from(requiredString(attachment.dataBase64, "attachment data"), "base64"); if (data.byteLength > 20 * 1024 * 1024) throw new Error("Each Gmail attachment is limited to 20 MB in Berry"); parts.push(`--${boundary}\r\nContent-Type: ${optionalString(attachment.mimeType) ?? "application/octet-stream"}; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${data.toString("base64").replace(/(.{76})/g, "$1\r\n")}`); } parts.push(`--${boundary}--`); raw = parts.join("\r\n"); } return Buffer.from(raw, "utf8").toString("base64url"); }
function gmailTargetSchema(): Record<string, unknown> { return object({ targetType: string("Message or thread.", { enum: ["message", "thread"] }), id: string("Message or thread ID.") }, ["targetType", "id"]); }
function gmailLabelsSchema(apply: boolean): Record<string, unknown> { return object({ ...gmailTargetSchema().properties as Record<string, unknown>, labelIds: stringArray(`${apply ? "Apply" : "Remove"} these label IDs.`, 100) }, ["targetType", "id", "labelIds"]); }
function modifyGmailLabels(token: string, input: Record<string, unknown>) { const target = requiredEnum(input.targetType, ["message", "thread"], "targetType"); const labels = requiredStringArray(input.labelIds, "labelIds").slice(0, 100); const remove = input.remove === true || input.targetAction === "remove" || false; const method = target === "message" ? "messages" : "threads"; return googleJson(token, gmailUrl(`users/me/${method}/${encodeURIComponent(requiredString(input.id, "id"))}/modify`), { method: "POST", body: jsonBody({ addLabelIds: remove ? [] : labels, removeLabelIds: remove ? labels : [] }) }); }

function calendarListEventsSchema(): Record<string, unknown> { return object({ calendarId: string("Calendar ID, normally primary."), query: string("Free-text query."), timeMin: string("RFC3339 lower bound."), timeMax: string("RFC3339 upper bound."), maxResults: integer("Maximum events.", 1, 2500), pageToken: string("Continuation token."), singleEvents: boolean("Expand recurring events."), orderBy: string("Ordering.", { enum: ["startTime", "updated"] }) }); }
function listCalendarEvents(token: string, input: Record<string, unknown>) { const singleEvents = optionalBoolean(input.singleEvents) ?? true; const orderBy = optionalString(input.orderBy) ?? (singleEvents ? "startTime" : "updated"); if (orderBy === "startTime" && !singleEvents) throw new Error("startTime ordering requires singleEvents=true"); return googleJson(token, calendarUrl(`calendars/${encodeURIComponent(optionalString(input.calendarId) ?? "primary")}/events`, { q: optionalString(input.query), timeMin: optionalString(input.timeMin), timeMax: optionalString(input.timeMax), maxResults: boundedInteger(input.maxResults, 100, 1, 2500), pageToken: optionalString(input.pageToken), singleEvents, orderBy })); }
function freeBusySchema(): Record<string, unknown> { return object({ timeMin: string("RFC3339 start."), timeMax: string("RFC3339 end."), timeZone: string("IANA time zone."), calendarIds: stringArray("Calendar IDs or attendee emails, maximum 50.", 50) }, ["timeMin", "timeMax", "calendarIds"]); }
function queryFreeBusy(token: string, input: Record<string, unknown>) { const ids = requiredStringArray(input.calendarIds, "calendarIds"); if (ids.length > 50) throw new Error("Free/busy supports at most 50 calendars per query"); return googleJson(token, calendarUrl("freeBusy"), { method: "POST", body: jsonBody(compact({ timeMin: requiredDate(input.timeMin, "timeMin").toISOString(), timeMax: requiredDate(input.timeMax, "timeMax").toISOString(), timeZone: optionalString(input.timeZone), groupExpansionMax: 100, calendarExpansionMax: 50, items: ids.map((id) => ({ id })) })) }); }
async function suggestCalendarTimes(token: string, input: Record<string, unknown>): Promise<unknown> { const response = await queryFreeBusy(token, input) as Record<string, unknown>; const calendars = record(response.calendars) ?? {}; const busy = Object.values(calendars).flatMap((calendar) => Array.isArray(record(calendar)?.busy) ? record(calendar)!.busy as unknown[] : []).flatMap((slot) => { const item = record(slot); if (!item) return []; const start = Date.parse(String(item.start)); const end = Date.parse(String(item.end)); return Number.isFinite(start) && Number.isFinite(end) ? [{ start, end }] : []; }).sort((a, b) => a.start - b.start); const min = requiredDate(input.timeMin, "timeMin").getTime(); const max = requiredDate(input.timeMax, "timeMax").getTime(); const duration = boundedInteger(input.durationMinutes, 30, 5, 480) * 60_000; const step = boundedInteger(input.intervalMinutes, 15, 5, 120) * 60_000; const suggestions: Array<{ start: string; end: string }> = []; for (let start = min; start + duration <= max && suggestions.length < 20; start += step) { if (!busy.some((slot) => start < slot.end && start + duration > slot.start)) suggestions.push({ start: new Date(start).toISOString(), end: new Date(start + duration).toISOString() }); } return { suggestions, busySource: response }; }
function calendarEventSchema(update: boolean): Record<string, unknown> { return object({ calendarId: string("Calendar ID, normally primary."), ...(update ? { eventId: string("Event ID.") } : { idempotencyKey: string("Stable idempotency key for retries.") }), summary: string("Event title."), description: string("Description."), location: string("Location."), start: string("RFC3339 date-time."), end: string("RFC3339 date-time."), timeZone: string("IANA time zone."), attendees: stringArray("Attendee emails.", 200), sendUpdates: string("Invitation email behavior.", { enum: ["all", "externalOnly", "none"] }), createMeet: boolean("Create Google Meet conference."), recurrence: stringArray("RFC5545 recurrence rules.", 20) }, [update ? "eventId" : "idempotencyKey", "summary", "start", "end"]); }
function eventResource(input: Record<string, unknown>): Record<string, unknown> { const start = requiredDate(input.start, "start"); const end = requiredDate(input.end, "end"); if (end <= start) throw new Error("Event end must be after start"); const meet = input.createMeet === true ? { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } : undefined; return compact({ summary: requiredString(input.summary, "summary"), description: optionalString(input.description), location: optionalString(input.location), start: compact({ dateTime: start.toISOString(), timeZone: optionalString(input.timeZone) }), end: compact({ dateTime: end.toISOString(), timeZone: optionalString(input.timeZone) }), attendees: optionalStringArray(input.attendees)?.map((email) => ({ email })), recurrence: optionalStringArray(input.recurrence), conferenceData: meet }); }
function createCalendarEvent(token: string, input: Record<string, unknown>) { const event = eventResource(input); const id = calendarEventId(requiredString(input.idempotencyKey, "idempotencyKey")); return googleJson(token, calendarUrl(`calendars/${encodeURIComponent(optionalString(input.calendarId) ?? "primary")}/events`, { sendUpdates: optionalString(input.sendUpdates) ?? "none", conferenceDataVersion: input.createMeet === true ? 1 : undefined }), { method: "POST", body: jsonBody({ id, ...event }) }); }
async function updateCalendarEvent(token: string, input: Record<string, unknown>): Promise<unknown> { const calendarId = optionalString(input.calendarId) ?? "primary"; const eventId = requiredString(input.eventId, "eventId"); const current = await googleJson(token, calendarUrl(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`)) as Record<string, unknown>; if (current.recurringEventId && optionalStringArray(input.recurrence)?.length) throw new Error("Changing recurrence on one occurrence is not supported"); const updated = { ...current, ...eventResource(input), id: current.id, etag: current.etag }; return googleJson(token, calendarUrl(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { sendUpdates: optionalString(input.sendUpdates) ?? "none", conferenceDataVersion: input.createMeet === true || current.conferenceData ? 1 : undefined }), { method: "PUT", ...(typeof current.etag === "string" ? { headers: { "if-match": current.etag } } : {}), body: jsonBody(updated) }); }
async function respondToEvent(token: string, input: Record<string, unknown>, context: ToolContext): Promise<unknown> { const calendarId = optionalString(input.calendarId) ?? "primary"; const eventId = requiredString(input.eventId, "eventId"); const event = await googleJson(token, calendarUrl(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`)) as Record<string, unknown>; const attendees = Array.isArray(event.attendees) ? event.attendees.map((value) => ({ ...requiredObject(value, "attendee") })) : []; const attendee = attendees.find((value) => value.self === true || (context.accountEmail && value.email === context.accountEmail)); if (!attendee) throw new Error("The connected account is not an attendee on this event"); attendee.responseStatus = requiredEnum(input.responseStatus, ["accepted", "declined", "tentative"], "responseStatus"); return googleJson(token, calendarUrl(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { sendUpdates: optionalString(input.sendUpdates) ?? "none" }), { method: "PUT", ...(typeof event.etag === "string" ? { headers: { "if-match": event.etag } } : {}), body: jsonBody({ ...event, attendees }) }); }

function defaultExportMime(mimeType: string): string { if (mimeType === "application/vnd.google-apps.document") return "text/plain"; if (mimeType === "application/vnd.google-apps.spreadsheet") return "text/csv"; return "application/pdf"; }
function escapeDriveQuery(value: string): string { return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function jsonBody(value: unknown): string { return JSON.stringify(value); }
function compact<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function requiredObject(value: unknown, name: string): Record<string, unknown> { const result = record(value); if (!result) throw new Error(`${name} is required`); return result; }
function requiredArray(value: unknown, name: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${name} is required`); return value; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`); return value.trim(); }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function requiredStringArray(value: unknown, name: string): string[] { const values = optionalStringArray(value); if (!values?.length) throw new Error(`${name} is required`); return values; }
function optionalStringArray(value: unknown): string[] | undefined { return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim()) ? value.map((item) => item.trim()) : undefined; }
function requiredBoolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw new Error(`${name} is required`); return value; }
function optionalBoolean(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function optionalInteger(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) ? value : undefined; }
function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number { const result = optionalInteger(value) ?? fallback; if (result < minimum || result > maximum) throw new Error(`Integer must be between ${minimum} and ${maximum}`); return result; }
function requiredEnum<const T extends readonly string[]>(value: unknown, values: T, name: string): T[number] { if (typeof value !== "string" || !values.includes(value)) throw new Error(`${name} must be one of ${values.join(", ")}`); return value as T[number]; }
function requiredDate(value: unknown, name: string): Date { const date = new Date(requiredString(value, name)); if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be an RFC3339 date-time`); return date; }
function safeHeader(value: string): string { return value.replace(/[\r\n]+/g, " ").trim(); }
function safeHeaderList(values: string[]): string { return values.map(safeHeader).join(", "); }
function googleObjectId(prefix: string): string { return `${prefix}_${randomUUID().replace(/-/g, "")}`.slice(0, 50); }
function calendarEventId(value: string): string { const normalized = Buffer.from(value).toString("hex").toLowerCase(); return `berry${normalized}`.slice(0, 128).padEnd(10, "0"); }
function hexColor(value: string): Record<string, number> { const match = /^#?([0-9a-f]{6})$/i.exec(value); if (!match) throw new Error("backgroundColorHex must be six hexadecimal digits"); const hex = match[1]!; return { red: parseInt(hex.slice(0, 2), 16) / 255, green: parseInt(hex.slice(2, 4), 16) / 255, blue: parseInt(hex.slice(4, 6), 16) / 255 }; }
