---
name: gmail-mcp
description: Find and read Gmail threads, download attachments, draft and send messages, reply in a thread, and manage labels using Berry’s Gmail connector.
---

# Gmail

Use `tool_search` with connector `Gmail` and the requested operation. Use the returned schema and `use_tool` for a deferred tool. Follow Berry’s **Reconnect** card when sign-in is required. If a read-only connection hides write tools, direct the user to **Settings → Connectors → Grant write access**, then discover the write tool after access is granted.

## Read mail

- Use `gmail_search_threads` for conversations and `gmail_search_messages` for individual messages. Pass a bounded Gmail `query` such as `is:unread newer_than:7d`. Search results can contain IDs only. Read headers and exact receive times for up to 25 IDs with `gmail_get_messages_metadata`. Request only the headers needed. Check each ID’s result before acting.
- Use `gmail_read_message` for the body, headers and MIME inventory. Follow text and inventory cursors when complete coverage matters. Inspect additional plain-text or HTML parts for forwards and original link targets. Stage long text parts or original files with `gmail_get_attachment` using their exact part IDs. Use `gmail_get_thread` or the original `gmail_get_message` representation when the task needs it.
- To read an attachment, call `gmail_get_attachment` with `messageId` and the `partId` from the message payload. Use the staged file for the task. Set `saveToLibrary: true` when the user asks to keep it for future work.

## Draft and send

- Resolve recipients, subject, body, and requested attachments. Use `gmail_create_draft` to save a draft, `gmail_update_draft` with the existing `draftId` to revise it, and `gmail_send_message` for a new send. For an existing draft, read it with `gmail_get_draft` before proposing `gmail_send_draft`. Show the recipients and subject in chat for the user to review.
- For `gmail_reply_to_thread`, read the parent message. Pass the Gmail `threadId`, the parent’s RFC `Message-ID` header as `inReplyTo`, the reply chain as `references`, the matching subject, recipients, and body. For reply-all, resolve To and Cc from the thread and show them in the proposal.
- Use `gmail_list_labels` to resolve labels to their IDs. `gmail_apply_labels` and `gmail_remove_labels` take `targetType`, `id`, and `labelIds`. Gmail deletion and trash actions are unavailable.
- Each Gmail write opens Berry’s inline approval card. Wait for the decision and report a draft saved or a message sent based on the actual tool result. If a send response is lost, check Sent mail for the same recipients, subject, and message before proposing a retry.

Adapted from the Workspace CLI [Gmail read and send workflows](https://github.com/googleworkspace/cli/blob/main/skills/gws-gmail/SKILL.md) and [threaded reply workflow](https://github.com/googleworkspace/cli/blob/main/skills/gws-gmail-reply/SKILL.md).
