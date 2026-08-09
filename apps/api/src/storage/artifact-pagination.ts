import { z } from "zod";

export const ArtifactListQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
