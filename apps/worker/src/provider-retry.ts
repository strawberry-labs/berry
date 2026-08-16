/**
 * Compatibility exports for worker call sites. The classifier lives in the
 * shared package so router fallbacks, durable turns, compaction, and queues
 * cannot silently drift apart.
 */
export {
  classifyProviderFailure,
  isRetryableProviderFailure,
  isRetryableProviderStatus,
  type ProviderFailureCategory,
  type ProviderRetryClassification,
} from "@berry/shared";
