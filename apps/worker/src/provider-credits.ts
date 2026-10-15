/**
 * Wording for an AI provider account that has run out of credit or quota
 * (H-005). The user cannot fix this, so the text names the cause, sends them to
 * support or their administrator, and says that retrying will not help.
 */

/** Shown to the user when a model call fails with HTTP 402. */
export const PROVIDER_CREDIT_EXHAUSTED_MESSAGE =
  "The AI provider is out of credit, so Berry can't respond right now. Please contact support or your administrator. Trying again or choosing another model from the same provider won't help until credit is added.";

/**
 * Returned to the model when image generation fails for the same reason. The
 * model relays it, so it says what to tell the user and to stop calling the tool.
 */
export const IMAGE_PROVIDER_CREDIT_EXHAUSTED_MESSAGE =
  "Image generation is unavailable because the AI provider is out of credit. Tell the user this plainly and that they should contact support or their administrator; do not suggest other fixes. Changing the prompt or retrying will not help, so do not call create_image again";

/** A provider credit problem reported for one tenant; administrators are emailed about it. */
export interface ProviderCreditAlert {
  tenantId: string;
  event: "exhausted" | "low";
  surface: "chat" | "image" | "balance";
  /** Omitted when the run did not record its provider; the deployment's router is assumed. */
  providerId?: string | undefined;
  providerName?: string | undefined;
  providerHost?: string | null | undefined;
  detectedAt: string;
  status?: number | null | undefined;
  balance?: { remaining: number; threshold: number; currency: string } | null | undefined;
}

export interface ProviderCreditAlertSink {
  raise(alert: ProviderCreditAlert): Promise<void>;
}

/**
 * Raises an alert without waiting for it. Recording it, and any failure while
 * doing so, never delays or changes the run that noticed the problem.
 */
export function raiseProviderCreditAlert(
  sink: ProviderCreditAlertSink | undefined,
  alert: ProviderCreditAlert,
): void {
  if (!sink) return;
  try {
    void sink.raise(alert).catch(() => undefined);
  } catch {
    // A synchronous failure is ignored as well.
  }
}

export function urlHost(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
