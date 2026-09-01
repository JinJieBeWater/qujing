import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { securePrivatePath, writePrivateJson } from "../private-files";
import {
  startServerTransport,
  type ServerTransportOptions,
  type TransportProcess,
} from "./process";

const stateSchema = z.object({
  serverAddress: z.string().min(1),
  remotePort: z.number().int().min(1).max(65_535),
});
export type TailcatState = z.infer<typeof stateSchema>;

export async function readTailcatState(stateRoot: string): Promise<TailcatState | undefined> {
  try {
    return stateSchema.parse(
      JSON.parse(await readFile(join(stateRoot, "transport", "server.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface TailcatSupervisorOptions {
  stateRoot: string;
  port: number;
  binary?: string;
  start?: (options: ServerTransportOptions, binary?: string) => Promise<TransportProcess>;
  onFatal?: (error: Error) => void;
}

export class TailcatSupervisor {
  private readonly statePath: string;
  private readonly keyPath: string;
  private process: TransportProcess | undefined;
  private signature?: string;
  private tail = Promise.resolve();
  private closed = false;

  constructor(private readonly options: TailcatSupervisorOptions) {
    this.statePath = join(options.stateRoot, "transport", "server.json");
    this.keyPath = join(options.stateRoot, "transport", "server-key.json");
  }

  reload(allowedKeys: string[]): Promise<TailcatState> {
    const keys = [...new Set(allowedKeys)].sort();
    const signature = JSON.stringify(keys);
    const operation = this.tail.then(async () => {
      if (this.closed) throw new Error("Tailcat transport is closed");
      if (signature === this.signature) return this.state();
      const previousProcess = this.process;
      this.process = undefined;
      await previousProcess?.close();
      const process = await (this.options.start ?? startServerTransport)(
        {
          keyPath: this.keyPath,
          port: this.options.port,
          allowedKeys: keys,
        },
        this.options.binary,
      );
      const serverAddress = process.ready.serverAddress;
      if (!serverAddress) {
        await process.close();
        throw new Error("Tailcat transport returned no server address");
      }
      const previous = await this.readState();
      if (previous && previous.serverAddress !== serverAddress) {
        await process.close();
        throw new Error("Tailcat server address changed despite persistent key");
      }
      const state = { serverAddress, remotePort: this.options.port };
      await securePrivatePath(this.keyPath, false);
      await writePrivateJson(this.statePath, state);
      this.process = process;
      this.signature = signature;
      void process.exited.then((code) => {
        if (this.closed || this.process !== process) return;
        (this.options.onFatal ?? defaultFatal)(new Error(`Tailcat transport exited (${code})`));
      });
      return state;
    });
    this.tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  async state(): Promise<TailcatState> {
    const state = await this.readState();
    if (!state) throw new Error("Tailcat server has not started");
    return state;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    await this.process?.close();
    this.process = undefined;
  }

  private async readState(): Promise<TailcatState | undefined> {
    return readTailcatState(this.options.stateRoot);
  }
}

function defaultFatal(): void {
  process.exit(1);
}
