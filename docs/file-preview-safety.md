# Browser file-preview safety

Berry treats the browser as an untrusted rendering boundary. The API returns
both the upload declaration and its detected media type; web preview decisions
prefer the detected value and fail closed when the two values are inconsistent.
Historical rows without a stored detection may use the declared passive type,
but they still must pass bounded byte/header validation before any image is
shown inline.

## Budgets

| Preview | Uploaded bytes | Expanded bytes | Other bounds |
| --- | ---: | ---: | --- |
| Images | 25 MiB | — | passive signature-validated formats, max 16M decoded pixels |
| Code/text | 2 MiB | — | bounded streaming response |
| XLSX/CSV/TSV | 25 MiB | 50 MiB | 50 sheets, 10,000 rows, 100 columns, 200,000 cells, 256 KiB per cell / 8 MiB output |
| Legacy XLS | 2 MiB | — | bounded SheetJS window; larger files download only |
| DOCX | 1 MiB | 4 MiB | 2 MiB entry, 20 pages; larger files download only |
| PPTX | 50 MiB | 200 MiB | 5,000 entries, 25 MiB per entry, 200 slides |

Office archives are checked for safe paths, encryption, duplicate names,
entry counts, declared and actual expansion, required OOXML parts, and local
header signatures/bounds. DOCX/PPTX relationship targets and embedded image
headers are bounded as well; legacy VML/active CSS and unsupported embedded
media are download-only. PPTX external media relationships are rejected while
ordinary hyperlinks remain available, so a preview cannot make untrusted
network requests. ZIP payloads are streamed through per-entry and aggregate
budgets before a renderer receives them. Spreadsheet workers return only the
bounded visible window; the full matrix is never cloned to the main thread.

DOCX rendering remains intentionally conservative because `docx-preview` is a
main-thread renderer. Its low source/expanded/page ceilings make larger or
complex documents download-only. AltChunk content is disabled and rendered
hyperlinks are restricted to `http`, `https`, and `mailto` schemes.

All preview requests use authenticated credentials and have a 15-second
deadline. Timeout, worker failure, malformed archives, MIME mismatches, and
budget violations render an explicit download-only fallback. Thumbnail Blob
URLs are revoked when cards leave the viewport and a 64 MiB retained-source
budget prevents a long library scroll from accumulating unbounded image data.
Local, not-yet-uploaded attachments do not receive an inline image preview until
they have a bounded source that can be checked safely. Generated-image editing
also uses the bounded image reader; only same-origin URLs receive Berry
credentials.

Generated images embedded in task messages use the existing generated-image
gallery path and are not generic uploaded-file previews; their bytes come from
the server-side image-generation/upload pipeline. The policy above applies to
uploaded files, library thumbnails, attachments, and document previews.

Focused coverage lives in `file-preview-policy.test.ts`, the worker entrypoint
fixtures, and `office-preview-gate.test.tsx`; the production web build also
emits the office and spreadsheet workers as separate assets.
