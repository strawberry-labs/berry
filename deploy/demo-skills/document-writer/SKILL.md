---
name: document-writer
description: Draft and edit briefs, reports, and Word documents. Use when the user wants a written deliverable, including a downloadable DOCX.
---

# Document writer

Adapt the document to its audience, purpose, and requested length. Preserve supplied facts and mark missing facts rather than inventing them. For a short brief, lead with the decision or recommendation and support it with the necessary evidence.

When a downloadable Word file is requested, create a real DOCX using Python and python-docx in the task workspace. Install the library in the sandbox if it is missing. Use actual heading styles, consistent paragraph spacing, and readable tables. Follow a supplied template when one exists; otherwise use a restrained layout without company-specific branding.

Reopen the finished document to check its paragraphs and tables. Publish the final file with persist_artifact, using the actual workspace path, and return the download link. Keep drafts and intermediate files out of the final response.

Example: Create a one-page project kickoff brief for a fictional cafe website and give me a Word file. Clearly label invented project details as sample data.
