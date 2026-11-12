import { describe, expect, it, vi } from "vitest";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { SesEmailSender, createEmailSender, emailConfigFromEnv, emailErrorMessage, emailSendRejected, type SesSendClient } from "./email.js";

describe("administrator email configuration (H-005)", () => {
  it("sends nothing by default", () => {
    const { config, problem } = emailConfigFromEnv({});
    expect(config).toEqual({ provider: "none" });
    expect(problem).toBeNull();
    expect(createEmailSender(config)).toBeNull();
    expect(createEmailSender(emailConfigFromEnv({ BERRY_EMAIL_PROVIDER: "none", BERRY_EMAIL_FROM: "alerts@example.com" }).config)).toBeNull();
  });

  it("configures SES from the sender, region and optional configuration set", () => {
    expect(emailConfigFromEnv({
      BERRY_EMAIL_PROVIDER: "SES",
      BERRY_EMAIL_FROM: "Berry Alerts <alerts@example.com>",
      BERRY_SES_REGION: "eu-west-1",
      BERRY_SES_CONFIGURATION_SET: "berry-alerts",
    })).toEqual({
      config: { provider: "ses", from: "Berry Alerts <alerts@example.com>", region: "eu-west-1", configurationSet: "berry-alerts" },
      problem: null,
    });
    expect(emailConfigFromEnv({ BERRY_EMAIL_PROVIDER: "ses", BERRY_EMAIL_FROM: "alerts@example.com", AWS_REGION: "us-east-1" }).config)
      .toMatchObject({ provider: "ses", region: "us-east-1", configurationSet: null });
  });

  it("disables email, without failing the worker, when the settings are unusable", () => {
    for (const env of [
      { BERRY_EMAIL_PROVIDER: "smtp", BERRY_EMAIL_FROM: "alerts@example.com", BERRY_SES_REGION: "eu-west-1" },
      { BERRY_EMAIL_PROVIDER: "ses", BERRY_SES_REGION: "eu-west-1" },
      { BERRY_EMAIL_PROVIDER: "ses", BERRY_EMAIL_FROM: "not-an-address", BERRY_SES_REGION: "eu-west-1" },
      { BERRY_EMAIL_PROVIDER: "ses", BERRY_EMAIL_FROM: "alerts@example.com" },
    ]) {
      const result = emailConfigFromEnv(env);
      expect(result.config).toEqual({ provider: "none" });
      expect(result.problem).toMatch(/email is disabled/);
    }
  });
});

describe("SES email sender (H-005)", () => {
  it("sends one SES v2 message with text and HTML bodies and returns the message ID", async () => {
    const send = vi.fn(async (_command: SendEmailCommand, _options?: { abortSignal?: AbortSignal }) => ({ MessageId: "0100018f-ses-message" }));
    const sender = createEmailSender(
      { provider: "ses", from: "Berry <alerts@example.com>", region: "eu-west-1", configurationSet: "berry-alerts" },
      { send } satisfies SesSendClient,
    );

    await expect(sender?.send({
      to: ["owner@example.com", "OWNER@example.com", "not an address", "admin@example.com"],
      subject: "Berry: OpenRouter is out of credit",
      text: "Plain text",
      html: "<p>HTML</p>",
    })).resolves.toEqual({ messageId: "0100018f-ses-message" });

    expect(send).toHaveBeenCalledTimes(1);
    const [command, options] = send.mock.calls[0]!;
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command.input).toEqual({
      FromEmailAddress: "Berry <alerts@example.com>",
      Destination: { ToAddresses: ["owner@example.com", "admin@example.com"] },
      Content: {
        Simple: {
          Subject: { Data: "Berry: OpenRouter is out of credit", Charset: "UTF-8" },
          Body: {
            Text: { Data: "Plain text", Charset: "UTF-8" },
            Html: { Data: "<p>HTML</p>", Charset: "UTF-8" },
          },
        },
      },
      ConfigurationSetName: "berry-alerts",
    });
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("omits the configuration set when none is configured and refuses a message without recipients", async () => {
    const send = vi.fn(async () => ({}));
    const sender = new SesEmailSender({ send }, { from: "alerts@example.com" });
    await expect(sender.send({ to: ["a@example.com"], subject: "s", text: "t", html: "h" })).resolves.toEqual({ messageId: null });
    expect((send.mock.calls[0] as unknown as [SendEmailCommand])[0].input).not.toHaveProperty("ConfigurationSetName");
    await expect(sender.send({ to: ["nobody"], subject: "s", text: "t", html: "h" })).rejects.toThrow("no valid recipients");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("propagates SES failures and describes them without credentials", async () => {
    const rejected = Object.assign(new Error("Email address is not verified. The following identities failed the check in region EU-WEST-1: alerts@example.com"), { name: "MessageRejected" });
    const sender = new SesEmailSender({ send: async () => { throw rejected; } }, { from: "alerts@example.com" });
    const failure = await sender.send({ to: ["a@example.com"], subject: "s", text: "t", html: "h" }).catch((error: unknown) => error);
    expect(emailErrorMessage(failure)).toBe("MessageRejected: Email address is not verified. The following identities failed the check in region EU-WEST-1: alerts@example.com");
    expect(emailErrorMessage(new Error("signed with AKIAABCDEFGHIJKLMNOP and Bearer sk-secret-value\nnext line")))
      .toBe("signed with [redacted] and Bearer [redacted] next line");
  });

  it("never lets the SDK retry a send on its own", async () => {
    const sender = createEmailSender({ provider: "ses", from: "alerts@example.com", region: "eu-west-1", configurationSet: null });
    const client = (sender as unknown as { client: { config: { maxAttempts: () => Promise<number> } } }).client;
    await expect(client.config.maxAttempts()).resolves.toBe(1);
  });

  it("tells a definite rejection from a send whose result is unknown", async () => {
    const sender = new SesEmailSender({ send: vi.fn() }, { from: "alerts@example.com" });
    const noRecipients = await sender.send({ to: ["nobody"], subject: "s", text: "t", html: "h" }).catch((error: unknown) => error);
    for (const rejected of [
      noRecipients,
      Object.assign(new Error("Email address is not verified"), { name: "MessageRejected", $metadata: { httpStatusCode: 400 } }),
      Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException", $metadata: { httpStatusCode: 429 } }),
      Object.assign(new Error("User is not authorized to perform ses:SendEmail"), { name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } }),
      Object.assign(new Error("Account sending paused"), { name: "SendingPausedException" }),
      Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" }),
      Object.assign(new Error("getaddrinfo ENOTFOUND email.eu-west-1.amazonaws.com"), { code: "ENOTFOUND" }),
    ]) {
      expect(emailSendRejected(rejected)).toBe(true);
    }
    for (const unknown of [
      // SES can accept a message and still answer with a server or gateway error.
      Object.assign(new Error("We encountered an internal error"), { name: "InternalFailure", $metadata: { httpStatusCode: 500 } }),
      Object.assign(new Error("Bad gateway"), { $metadata: { httpStatusCode: 502 } }),
      Object.assign(new Error("Service unavailable"), { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } }),
      Object.assign(new Error("Gateway timeout"), { $metadata: { httpStatusCode: 504 } }),
      Object.assign(new Error("Request timeout"), { name: "RequestTimeout", $metadata: { httpStatusCode: 408 } }),
      Object.assign(new Error("We encountered an internal error"), { name: "InternalFailure" }),
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      Object.assign(new Error("Request aborted"), { name: "AbortError" }),
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      // SES answered 200 but the body could not be read: it accepted the message.
      Object.assign(new Error("Deserialization error"), { $metadata: { httpStatusCode: 200 } }),
      new Error("Unexpected failure"),
      "not an error",
    ]) {
      expect(emailSendRejected(unknown)).toBe(false);
    }
  });
});
