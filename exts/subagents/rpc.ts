import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";

const MAX_STDERR_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export interface PiInvocation {
	command: string;
	argsPrefix: string[];
}

export type RpcEventHandler = (event: Record<string, any>) => Promise<void> | void;
export type RpcExitHandler = (error: Error | undefined) => void;

export function resolvePiInvocation(): PiInvocation {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, argsPrefix: [currentScript] };
	}

	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) {
		return { command: process.execPath, argsPrefix: [] };
	}
	return { command: "pi", argsPrefix: [] };
}

export class RpcProcess {
	private process?: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<
		string,
		{ resolve: (response: Record<string, any>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	private requestId = 0;
	private stderr = "";
	private eventQueue = Promise.resolve();
	private stopping = false;
	private stopPromise?: Promise<void>;

	constructor(
		private readonly invocation: PiInvocation,
		private readonly cwd: string,
		private readonly env: NodeJS.ProcessEnv,
		private readonly onEvent: RpcEventHandler,
		private readonly onExit: RpcExitHandler,
	) {}

	async start(args: string[]): Promise<void> {
		if (this.process) throw new Error("RPC process already started");
		const child = spawn(this.invocation.command, [...this.invocation.argsPrefix, ...args], {
			cwd: this.cwd,
			env: this.env,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;

		const decoder = new StringDecoder("utf8");
		let buffer = "";
		const processLine = (raw: string) => {
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (!line) return;
			let event: Record<string, any>;
			try {
				event = JSON.parse(line) as Record<string, any>;
			} catch {
				return;
			}

			if (event.type === "response" && typeof event.id === "string") {
				const request = this.pending.get(event.id);
				if (request) {
					this.pending.delete(event.id);
					clearTimeout(request.timer);
					request.resolve(event);
					return;
				}
			}

			this.eventQueue = this.eventQueue.then(() => this.onEvent(event)).catch((error) => {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			});
		};

		child.stdout.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				processLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
			}
		});
		child.stdout.on("end", () => {
			buffer += decoder.end();
			if (buffer) processLine(buffer);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString();
			if (Buffer.byteLength(this.stderr, "utf8") > MAX_STDERR_BYTES) {
				this.stderr = this.stderr.slice(-MAX_STDERR_BYTES);
			}
		});

		child.once("error", (error) => this.fail(new Error(`Could not start subagent: ${error.message}`)));
		child.once("exit", (code, signal) => {
			const error =
				this.stopping || code === 0
					? undefined
					: new Error(
							`Subagent process exited (code=${code ?? "null"}, signal=${signal ?? "none"})${
								this.stderr ? `: ${this.stderr.trim()}` : ""
							}`,
						);
			this.rejectPending(error ?? new Error("Subagent process stopped"));
			this.onExit(error);
		});

		await this.send({ type: "get_state" });
	}

	async send(command: Record<string, unknown>): Promise<Record<string, any>> {
		const child = this.process;
		if (!child || child.exitCode !== null || child.signalCode !== null || !child.stdin.writable) {
			throw new Error(`Subagent process is not running${this.stderr ? `: ${this.stderr.trim()}` : ""}`);
		}

		const id = `req_${++this.requestId}`;
		const message = `${JSON.stringify({ ...command, id })}\n`;
		return new Promise<Record<string, any>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for RPC response to ${String(command.type)}`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			child.stdin.write(message, (error) => {
				if (!error) return;
				const request = this.pending.get(id);
				if (!request) return;
				this.pending.delete(id);
				clearTimeout(request.timer);
				request.reject(error);
			});
		}).then((response) => {
			if (!response.success) throw new Error(response.error || `RPC command ${String(command.type)} failed`);
			return response;
		});
	}

	async flushEvents(): Promise<void> {
		await this.eventQueue;
	}

	sendUiResponse(response: Record<string, unknown>): void {
		const child = this.process;
		if (!child || child.exitCode !== null || child.signalCode !== null || !child.stdin.writable) {
			throw new Error("Subagent process is not running");
		}
		child.stdin.write(`${JSON.stringify(response)}\n`);
	}

	async stop(): Promise<void> {
		const child = this.process;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		if (this.stopPromise) return this.stopPromise;
		this.stopping = true;
		child.kill("SIGTERM");
		this.stopPromise = new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				resolve();
			}, 1_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		return this.stopPromise;
	}

	private fail(error: Error): void {
		this.rejectPending(error);
		this.onExit(error);
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
	}
}
