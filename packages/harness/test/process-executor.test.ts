import { describe, expect, it } from "vitest";
import { LocalProcessExecutor } from "../src/harness/env/process-executor.ts";

describe("LocalProcessExecutor", () => {
	it.skipIf(process.platform === "win32")("terminates a detached process group and stops new spawns", async () => {
		const executor = new LocalProcessExecutor();
		const child = executor.spawn("/bin/sh", ["-c", "sleep 30 & wait"], { stdio: "ignore" });
		expect(child.pid).toBeTypeOf("number");
		await executor.dispose(100);
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		expect(() => executor.spawn("/bin/sh", ["-c", "true"])).toThrow("shutting down");
	});
});
