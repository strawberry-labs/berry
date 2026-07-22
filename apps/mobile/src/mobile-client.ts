import { BerryApiClient } from "@berry/api-client";
import type { ApprovalRequest, Message, MobileDeviceRegistration, MobileDeviceRegistrationCreate, Task } from "@berry/shared";

export interface BerryMobileClientOptions {
  baseUrl: string;
  sessionToken?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class BerryMobileClient {
  readonly #client: BerryApiClient;

  constructor(options: BerryMobileClientOptions) {
    this.#client = new BerryApiClient({
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      headers: options.sessionToken ? { Authorization: `Bearer ${options.sessionToken}` } : undefined,
    });
  }

  listTasks(): Promise<Task[]> {
    return this.#client.listTasks();
  }

  listMessages(sessionId: string): Promise<Message[]> {
    return this.#client.listMessages(sessionId);
  }

  listApprovals(): Promise<ApprovalRequest[]> {
    return this.#client.listApprovals();
  }

  approve(approvalId: string): Promise<{ ok: boolean }> {
    return this.#client.decideApproval(approvalId, { decision: "approved_once" });
  }

  deny(approvalId: string): Promise<{ ok: boolean }> {
    return this.#client.decideApproval(approvalId, { decision: "denied" });
  }

  registerDevice(input: MobileDeviceRegistrationCreate): Promise<MobileDeviceRegistration> {
    return this.#client.registerMobileDevice(input);
  }
}
