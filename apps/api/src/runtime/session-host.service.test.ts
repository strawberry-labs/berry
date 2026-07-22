import "reflect-metadata";
import type { SessionHost, StartTurnOptions } from "@berry/local-agent";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";

import { SessionHostModule } from "./session-host.module.ts";
import { SessionHostService } from "./session-host.service.ts";

describe("SessionHostModule", () => {
  it("injects one runtime driver, delegates turns, and disposes it once", async () => {
    const startTurn = vi.fn(() => ({ turnId: "turn_cloud_1" }));
    const dispose = vi.fn(async () => {});
    const driver = { startTurn, dispose } as unknown as SessionHost;
    const moduleRef = await Test.createTestingModule({ imports: [SessionHostModule.register({ useValue: driver })] }).compile();
    const service = moduleRef.get(SessionHostService);
    const input = { sessionId: "session_1" } as StartTurnOptions;

    expect(service.startTurn(input)).toEqual({ turnId: "turn_cloud_1" });
    expect(startTurn).toHaveBeenCalledWith(input);
    await Promise.all([service.dispose(), service.onApplicationShutdown()]);
    expect(dispose).toHaveBeenCalledTimes(1);
    await moduleRef.close();
  });
});
