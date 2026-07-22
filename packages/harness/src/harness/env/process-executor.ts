import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export const PROCESS_TERMINATION_GRACE_MS = 750;

export class LocalProcessExecutor {
	readonly #children = new Map<ChildProcess, boolean>();
	#accepting = true;

	spawn(command: string, args: string[] = [], options: SpawnOptions = {}): ChildProcess {
		if (!this.#accepting) throw new Error("Process executor is shutting down");
		const detached = options.detached ?? process.platform !== "win32";
		const child = spawn(command, args, {
			windowsHide: true,
			...options,
			detached,
		});
		this.#children.set(child, detached);
		const forget = () => this.#children.delete(child);
		child.once("close", forget);
		child.once("error", forget);
		return child;
	}

	stopAccepting(): void {
		this.#accepting = false;
	}

	killNow(child: ChildProcess): void {
		this.#signal(child, "SIGKILL");
	}

	async terminate(child: ChildProcess, graceMs = PROCESS_TERMINATION_GRACE_MS): Promise<void> {
		if (!isRunning(child)) return;
		this.#signal(child, "SIGTERM");
		if (await this.waitForExit(child, graceMs)) return;
		this.#signal(child, "SIGKILL");
		await this.waitForExit(child, Math.max(graceMs, 250));
	}

	async waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
		if (!isRunning(child)) return true;
		return await new Promise((resolve) => {
			let settled = false;
			const finish = (exited: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.off("close", onClose);
				child.off("error", onClose);
				resolve(exited);
			};
			const onClose = () => finish(true);
			const timer = setTimeout(() => finish(!isRunning(child)), timeoutMs);
			timer.unref?.();
			child.once("close", onClose);
			child.once("error", onClose);
			if (!isRunning(child)) finish(true);
		});
	}

	async dispose(graceMs = PROCESS_TERMINATION_GRACE_MS): Promise<void> {
		this.stopAccepting();
		await Promise.allSettled([...this.#children.keys()].map((child) => this.terminate(child, graceMs)));
		this.#children.clear();
	}

	#signal(child: ChildProcess, signal: NodeJS.Signals): void {
		if (!child.pid || !isRunning(child)) return;
		if (process.platform === "win32") {
			if (signal === "SIGKILL") {
				try {
					spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", detached: true, windowsHide: true });
				} catch {
					child.kill(signal);
				}
			} else {
				child.kill(signal);
			}
			return;
		}
		try {
			if (this.#children.get(child)) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				// The process already exited.
			}
		}
	}
}

function isRunning(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}
