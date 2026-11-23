import { z } from "zod";

export class ScheduledConnectionRequired extends Error {}

const checkpointSchema = z.object({
  completedThrough: z.string().datetime({ offset: true }),
  activity: z.object({ mailboxAddress: z.string().email(), hasPendingWork: z.boolean() }),
});
const pageSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).optional(),
  nextPageToken: z.string().optional(), resultSizeEstimate: z.number().int().nonnegative().optional(),
});

export async function idleMailboxSince(checkpoint: unknown, accountEmail: string | null,
  search: (args: Record<string, unknown>) => Promise<unknown>, timing: { overlapSeconds?: number; deliveryDelaySeconds?: number } = {}, now = Date.now()): Promise<boolean> {
  const parsed = checkpointSchema.safeParse(checkpoint);
  if (!parsed.success || !accountEmail) return false;
  const { activity, completedThrough } = parsed.data;
  const since = Date.parse(completedThrough);
  if (activity.hasPendingWork || !Number.isFinite(since) || since > now
      || activity.mailboxAddress.toLowerCase() !== accountEmail.toLowerCase()) return false;
  // Overlap one second at Gmail's date boundary. An extra wakeup is preferable to missing a message.
  const overlap = timing.overlapSeconds ?? 0, delay = timing.deliveryDelaySeconds ?? 0;
  if (![overlap, delay].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 86400)) return false;
  const upper = delay ? ` before:${Math.ceil(now / 1000 - delay) + 1}` : "";
  const page = pageSchema.safeParse(await search({ query: `after:${Math.floor(since / 1_000) - overlap - 1}${upper} -in:spam -in:trash`,
    maxResults: 1, includeSpamTrash: false }));
  if (!page.success || page.data.nextPageToken || (page.data.resultSizeEstimate ?? 0) > 0) return false;
  return page.data.messages === undefined ? page.data.resultSizeEstimate === 0 : page.data.messages.length === 0;
}
