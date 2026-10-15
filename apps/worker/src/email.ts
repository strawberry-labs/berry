import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { redactSecrets } from "@berry/router-client";

/**
 * Administrator email delivery (H-005). `BERRY_EMAIL_PROVIDER=none`, the
 * default, sends nothing. `ses` sends through Amazon SES v2 with the standard
 * AWS credential chain (the EC2 instance role in production), so no AWS keys
 * are configured here.
 */
export interface EmailMessage {
  to: readonly string[];
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  readonly provider: "ses";
  send(message: EmailMessage): Promise<{ messageId: string | null }>;
}

/** The part of the SES client the sender uses, so tests can replace it. */
export interface SesSendClient {
  send(command: SendEmailCommand, options?: { abortSignal?: AbortSignal }): Promise<{ MessageId?: string | undefined }>;
}

export type EmailConfig =
  | { provider: "none" }
  | { provider: "ses"; from: string; region: string; configurationSet: string | null };

/** SES accepts at most 50 recipients per message. */
const MAX_RECIPIENTS = 50;
const SEND_TIMEOUT_MS = 20_000;
const EMAIL_ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && EMAIL_ADDRESS.test(value);
}

/**
 * Reads the email settings. An unusable value disables email and reports why
 * instead of failing the worker: alerts must never stop runs from executing.
 */
export function emailConfigFromEnv(env: NodeJS.ProcessEnv): { config: EmailConfig; problem: string | null } {
  const provider = env.BERRY_EMAIL_PROVIDER?.trim().toLowerCase() || "none";
  if (provider === "none") return { config: { provider: "none" }, problem: null };
  if (provider !== "ses") {
    return { config: { provider: "none" }, problem: "BERRY_EMAIL_PROVIDER must be ses or none; email is disabled" };
  }
  const from = env.BERRY_EMAIL_FROM?.trim() ?? "";
  const address = /<([^<>]+)>\s*$/.exec(from)?.[1]?.trim() ?? from;
  if (!isEmailAddress(address)) {
    return { config: { provider: "none" }, problem: "BERRY_EMAIL_FROM must be an email address verified in SES; email is disabled" };
  }
  const region = env.BERRY_SES_REGION?.trim() || env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || "";
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) {
    return { config: { provider: "none" }, problem: "BERRY_SES_REGION must name an AWS region such as eu-west-1; email is disabled" };
  }
  const configurationSet = env.BERRY_SES_CONFIGURATION_SET?.trim() || null;
  return { config: { provider: "ses", from, region, configurationSet }, problem: null };
}

export function createEmailSender(config: EmailConfig, client?: SesSendClient): EmailSender | null {
  if (config.provider === "none") return null;
  return new SesEmailSender(client ?? new SESv2Client({ region: config.region }), config);
}

export class SesEmailSender implements EmailSender {
  readonly provider = "ses" as const;

  constructor(
    private readonly client: SesSendClient,
    private readonly options: { from: string; configurationSet?: string | null; timeoutMs?: number },
  ) {}

  async send(message: EmailMessage): Promise<{ messageId: string | null }> {
    const unique = new Map<string, string>();
    for (const address of message.to.map((value) => value.trim()).filter(isEmailAddress)) {
      if (!unique.has(address.toLowerCase())) unique.set(address.toLowerCase(), address);
    }
    const to = [...unique.values()].slice(0, MAX_RECIPIENTS);
    if (to.length === 0) throw new Error("The email has no valid recipients");
    const input: SendEmailCommandInput = {
      FromEmailAddress: this.options.from,
      Destination: { ToAddresses: to },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: message.text, Charset: "UTF-8" },
            Html: { Data: message.html, Charset: "UTF-8" },
          },
        },
      },
      ...(this.options.configurationSet ? { ConfigurationSetName: this.options.configurationSet } : {}),
    };
    const response = await this.client.send(new SendEmailCommand(input), {
      abortSignal: AbortSignal.timeout(this.options.timeoutMs ?? SEND_TIMEOUT_MS),
    });
    return { messageId: response.MessageId ?? null };
  }
}

/**
 * A bounded, single-line failure description for `delivery_attempts.error`.
 * SES errors name the problem (for example an unverified identity); anything
 * resembling a credential is removed before it is stored.
 */
export function emailErrorMessage(error: unknown): string {
  const name = error instanceof Error && error.name && error.name !== "Error" ? `${error.name}: ` : "";
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(`${name}${message}`)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500) || "Email delivery failed";
}
