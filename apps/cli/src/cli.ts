#!/usr/bin/env bun

import { resolve, join } from "node:path";
import { ClientConfigStore, type LineConfig, type LineInput } from "./client-config";
import {
  cancelClientLineRetirement,
  requestClientLineRetirement,
  waitForClientLineRetirement,
} from "./client-control";
import { runClientDoctor } from "./client-doctor";
import { startClientServer } from "./client-server";
import { ConfigStore } from "./config";
import { runDoctor, type DoctorReport } from "./doctor";
import { waitForClientReload, waitForGatewayReload } from "./gateway-reload";
import { LineRuntime } from "./line-runtime";
import { defaultClientPaths, defaultPaths } from "./paths";
import { acquireProcessLock, processLockActive } from "./process-lock";
import { purgeClientRuntimeSessions, purgeWorkspaceRuntimeSessions } from "./runtime/cleanup";
import { RuntimeSessionStore } from "./runtime/sessions";
import { currentServeCommand, installUserService, removeUserService } from "./service";
import { startServer } from "./server";
import { createTransportKey, startConnector, validateTransportKey } from "./transport/process";
import { readTailcatState } from "./transport/supervisor";

export interface CliIo {
  configPath: string;
  stateRoot: string;
  clientConfigPath: string;
  clientStateRoot: string;
  writeOut(text: string): void;
  writeError(text: string): void;
  readStdin(): Promise<string>;
  transportBinary?: string;
  gatewayReloadTimeoutMs?: number;
  validateTailcatKey?: (key: string) => Promise<void>;
  verifyLine?: (line: LineConfig) => Promise<void>;
  clientDoctor?: () => Promise<DoctorReport>;
}

class UsageError extends Error {}

const rootHelp = `Usage: colleague-line <gateway|client> <command>

Owner Gateway:
  gateway init|workspace|client|doctor|serve|service

Agent Client:
  client init|line|token|doctor|serve|service

Examples:
  colleague-line gateway init --owner-id jason --owner-name Jason
  colleague-line gateway serve
  colleague-line client init
  colleague-line client line list --json
  colleague-line client serve
`;

const help: Record<string, string> = {
  gateway: `Usage: colleague-line gateway <command>

Examples:
  colleague-line gateway init --owner-id jason --owner-name Jason
  colleague-line gateway serve
`,
  "gateway workspace": `Usage: colleague-line gateway workspace <add|list|update|remove>

Examples:
  colleague-line gateway workspace list --json
`,
  "gateway client": `Usage: colleague-line gateway client <add|list|rotate|revoke>

Examples:
  colleague-line gateway client list --json
`,
  "gateway service": `Usage: colleague-line gateway service <install|remove> --yes

Examples:
  colleague-line gateway service install --yes
`,
  "gateway init": `Usage: colleague-line gateway init --owner-id <id> --owner-name <name> [--owner-summary <summary>]

Examples:
  colleague-line gateway init --owner-id jason --owner-name Jason
`,
  "gateway workspace add": `Usage: colleague-line gateway workspace add <id> --name <name> --root <directory> --summary <summary>

Examples:
  colleague-line gateway workspace add pi-tooling --name "Pi Tooling" --root ~/src/pi --summary "Pi SDK and extensions"
`,
  "gateway workspace list": `Usage: colleague-line gateway workspace list [--json]

Examples:
  colleague-line gateway workspace list --json
`,
  "gateway workspace update": `Usage: colleague-line gateway workspace update <id> [--name <name>] [--summary <summary>]

Examples:
  colleague-line gateway workspace update pi-tooling --summary "Pi SDK and runtime"
`,
  "gateway workspace remove": `Usage: colleague-line gateway workspace remove <id> --yes

Examples:
  colleague-line gateway workspace remove old-workspace --yes
`,
  "gateway client add": `Usage: colleague-line gateway client add <id> --tailcat-key <public-key>

Examples:
  printf '%s' 'nodekey:...' | colleague-line gateway client add alice-line --tailcat-key -
`,
  "gateway client list": `Usage: colleague-line gateway client list [--json]

Examples:
  colleague-line gateway client list --json
`,
  "gateway client rotate": `Usage: colleague-line gateway client rotate <id> --tailcat-key <new-public-key> --yes

Examples:
  printf '%s' 'nodekey:...' | colleague-line gateway client rotate alice-line --tailcat-key - --yes
`,
  "gateway client revoke": `Usage: colleague-line gateway client revoke <id> --yes

Examples:
  colleague-line gateway client revoke alice-line --yes
`,
  "gateway doctor": `Usage: colleague-line gateway doctor [--json]

Examples:
  colleague-line gateway doctor --json
`,
  "gateway serve": `Usage: colleague-line gateway serve

Examples:
  colleague-line gateway serve
`,
  "gateway service install": `Usage: colleague-line gateway service install --yes

Examples:
  colleague-line gateway service install --yes
`,
  "gateway service remove": `Usage: colleague-line gateway service remove --yes

Examples:
  colleague-line gateway service remove --yes
`,
  client: `Usage: colleague-line client <command>

Examples:
  colleague-line client init
  colleague-line client line list --json
  colleague-line client serve
`,
  "client line": `Usage: colleague-line client line <key-create|add|list|update|remove>

Examples:
  colleague-line client line list --json
`,
  "client token": `Usage: colleague-line client token rotate

Examples:
  colleague-line client token rotate
`,
  "client service": `Usage: colleague-line client service <install|remove> --yes

Examples:
  colleague-line client service install --yes
`,
  "client init": `Usage: colleague-line client init [--port <loopback-port>]

Examples:
  colleague-line client init
  colleague-line client init --port 43111
`,
  "client line key-create": `Usage: colleague-line client line key-create <line-id> [--output <private-key-path>]

Examples:
  colleague-line client line key-create jason
`,
  "client line add": `Usage: colleague-line client line add <line-id> --owner-id <id> --remote-client-id <id> --server <tailcat-address> --port <remote-port> --key <private-key-path> --bearer <token|->

Examples:
  printf '%s' '<remote-bearer>' | colleague-line client line add jason --owner-id jason --remote-client-id alice-line --server <tailcat-address> --port 43110 --key ~/.local/share/colleague-line/client/keys/jason.json --bearer -
`,
  "client line list": `Usage: colleague-line client line list [--json]

Examples:
  colleague-line client line list --json
`,
  "client line update": `Usage: colleague-line client line update <line-id> --key <private-key-path> --bearer <token|-> --yes

Examples:
  printf '%s' '<new-remote-bearer>' | colleague-line client line update jason --key ~/.local/share/colleague-line/client/keys/jason.json --bearer - --yes
`,
  "client line remove": `Usage: colleague-line client line remove <line-id> --yes

Examples:
  colleague-line client line remove jason --yes
`,
  "client token rotate": `Usage: colleague-line client token rotate

Examples:
  colleague-line client token rotate
`,
  "client doctor": `Usage: colleague-line client doctor [--json]

Examples:
  colleague-line client doctor --json
`,
  "client serve": `Usage: colleague-line client serve

Examples:
  colleague-line client serve
`,
  "client service install": `Usage: colleague-line client service install --yes

Examples:
  colleague-line client service install --yes
`,
  "client service remove": `Usage: colleague-line client service remove --yes

Examples:
  colleague-line client service remove --yes
`,
};

export async function runCli(args: string[], io: CliIo = defaultIo()): Promise<number> {
  try {
    const command = commandKey(args);
    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
      io.writeOut(command ? (help[command] ?? rootHelp) : rootHelp);
      return 0;
    }
    const parsed = parseArgs(args.slice(command.split(" ").length));
    validateArgs(command, parsed, help[command] ?? rootHelp);
    if (command.startsWith("gateway ")) return await runGateway(command, parsed, io);
    if (command.startsWith("client ")) return await runClient(command, parsed, io);
    throw new UsageError(rootHelp);
  } catch (error) {
    if (error instanceof UsageError) {
      io.writeError(`${error.message.endsWith("\n") ? error.message : `${error.message}\n`}`);
      return 2;
    }
    io.writeError(`Error: ${error instanceof Error ? error.message : "Unknown failure"}\n`);
    return 1;
  }
}

async function runGateway(command: string, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const store = new ConfigStore(io);
  switch (command) {
    case "gateway init":
      await store.init({ owner: ownerInput(parsed, help[command]!) });
      out(io, `initialized Gateway: ${io.configPath}`);
      return 0;
    case "gateway workspace add": {
      const id = positional(parsed, 0, help[command]!);
      await store.addWorkspace({
        id,
        name: required(parsed, "name", help[command]!),
        root: required(parsed, "root", help[command]!),
        summary: required(parsed, "summary", help[command]!),
      });
      out(io, `workspace: ${id}`);
      return 0;
    }
    case "gateway workspace list": {
      const config = await store.readEffective();
      const availability = new Map(
        (await store.listPublicWorkspaces()).map((workspace) => [
          workspace.id,
          workspace.available,
        ]),
      );
      printRows(
        io,
        config.workspaces.map((workspace) => ({
          ...workspace,
          available: availability.get(workspace.id) ?? false,
        })),
        parsed.flags.has("json"),
      );
      return 0;
    }
    case "gateway workspace update": {
      const id = positional(parsed, 0, help[command]!);
      const name = parsed.values.get("name");
      const summary = parsed.values.get("summary");
      if (name === undefined && summary === undefined) throw new UsageError(help[command]!);
      await store.updateWorkspace(id, {
        ...(name === undefined ? {} : { name }),
        ...(summary === undefined ? {} : { summary }),
      });
      out(io, `workspace: ${id}`);
      return 0;
    }
    case "gateway workspace remove": {
      confirm(parsed, help[command]!);
      const id = positional(parsed, 0, help[command]!);
      if (!(await store.removeWorkspace(id))) throw new Error(`Workspace not found: ${id}`);
      const handled = await waitIfGatewayRunning(
        store,
        io,
        (config) => !config.workspaces.some((workspace) => workspace.id === id),
      );
      if (!handled) await purgeWorkspaceRuntimeSessions(id, new RuntimeSessionStore(io.stateRoot));
      out(io, `removed workspace: ${id}`);
      return 0;
    }
    case "gateway client add": {
      const id = positional(parsed, 0, help[command]!);
      const tailcatKey = await inputValue(required(parsed, "tailcat-key", help[command]!), io);
      await (io.validateTailcatKey ?? ((key) => validateTransportKey(key, io.transportBinary)))(
        tailcatKey,
      );
      const result = await store.addClient({ id, tailcatKey });
      out(io, `remote-client: ${id}\nbearer: ${result.bearer}`);
      await waitIfGatewayRunning(store, io, (config) =>
        config.clients.some((client) => client.id === id && client.tailcatKey === tailcatKey),
      );
      const tailcat = await readTailcatState(io.stateRoot);
      if (tailcat) out(io, `tailcat: ${tailcat.serverAddress}\nremote-port: ${tailcat.remotePort}`);
      return 0;
    }
    case "gateway client list":
      printRows(
        io,
        (await store.readEffective()).clients.map(({ id, createdAt, updatedAt }) => ({
          id,
          createdAt,
          updatedAt,
        })),
        parsed.flags.has("json"),
      );
      return 0;
    case "gateway client rotate": {
      confirm(parsed, help[command]!);
      const id = positional(parsed, 0, help[command]!);
      const tailcatKey = await inputValue(required(parsed, "tailcat-key", help[command]!), io);
      await (io.validateTailcatKey ?? ((key) => validateTransportKey(key, io.transportBinary)))(
        tailcatKey,
      );
      const result = await store.rotateClient(id, tailcatKey);
      out(io, `remote-client: ${id}\nbearer: ${result.bearer}`);
      await waitIfGatewayRunning(store, io, (config) =>
        config.clients.some((client) => client.id === id && client.tailcatKey === tailcatKey),
      );
      return 0;
    }
    case "gateway client revoke": {
      confirm(parsed, help[command]!);
      const id = positional(parsed, 0, help[command]!);
      if (!(await store.revokeClient(id))) throw new Error(`Remote Client not found: ${id}`);
      const handled = await waitIfGatewayRunning(
        store,
        io,
        (config) => !config.clients.some((client) => client.id === id),
      );
      if (!handled) await purgeClientRuntimeSessions(id, new RuntimeSessionStore(io.stateRoot));
      out(io, `revoked remote-client: ${id}`);
      return 0;
    }
    case "gateway doctor":
      return printDoctor(io, await runDoctor(io), parsed.flags.has("json"));
    case "gateway serve": {
      const running = await startServer(io);
      out(io, "gateway: ready");
      await serveUntilSignal(running.close);
      return 0;
    }
    case "gateway service install":
      confirm(parsed, help[command]!);
      out(io, `service: ${await installUserService(currentServeCommand("gateway"), "gateway")}`);
      return 0;
    case "gateway service remove":
      confirm(parsed, help[command]!);
      out(io, `removed service: ${await removeUserService("gateway")}`);
      return 0;
    default:
      throw new UsageError(rootHelp);
  }
}

async function runClient(command: string, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const store = new ClientConfigStore({ configPath: io.clientConfigPath });
  switch (command) {
    case "client init": {
      const port = portValue(parsed.values.get("port") ?? "43111", "port");
      const result = await store.init({ port });
      if (!result.initialized) {
        out(io, `Client already initialized: ${io.clientConfigPath}`);
        return 0;
      }
      out(
        io,
        `initialized Client: ${io.clientConfigPath}\nlocal-bearer: ${result.bearer}\nmcp: http://127.0.0.1:${port}/mcp`,
      );
      return 0;
    }
    case "client line key-create": {
      const id = positional(parsed, 0, help[command]!);
      const output = resolve(
        parsed.values.get("output") ?? join(io.clientStateRoot, "keys", `${id}.json`),
      );
      const key = await createTransportKey(output, io.transportBinary);
      out(io, `key: ${key.keyPath}\npublic-key: ${key.publicKey}`);
      return 0;
    }
    case "client line add": {
      const input: LineInput = {
        id: positional(parsed, 0, help[command]!),
        expectedOwnerId: required(parsed, "owner-id", help[command]!),
        remoteClientId: required(parsed, "remote-client-id", help[command]!),
        serverAddress: await inputValue(required(parsed, "server", help[command]!), io),
        remotePort: portValue(required(parsed, "port", help[command]!), "port"),
        keyPath: resolve(required(parsed, "key", help[command]!)),
        remoteBearer: await inputValue(required(parsed, "bearer", help[command]!), io),
      };
      const validated = await store.validate(input);
      await withClientMutation(io, async () => {
        await verifyLine(
          {
            ...validated,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          io,
        );
        await store.add(validated);
        await waitIfClientRunning(store, io);
      });
      out(io, `line: ${validated.id}`);
      return 0;
    }
    case "client line list":
      printRows(io, await store.list(), parsed.flags.has("json"));
      return 0;
    case "client line update": {
      confirm(parsed, help[command]!);
      const id = positional(parsed, 0, help[command]!);
      const credentials = await store.validateCredentials({
        keyPath: resolve(required(parsed, "key", help[command]!)),
        remoteBearer: await inputValue(required(parsed, "bearer", help[command]!), io),
      });
      await withClientMutation(io, async () => {
        const current = await store.get(id);
        if (!current) throw new Error(`Line not found: ${id}`);
        await verifyLine({ ...current, ...credentials, updatedAt: new Date().toISOString() }, io);
        await withRetiredClientLine(store, io, current, async () => {
          await store.updateCredentials(id, credentials);
        });
      });
      out(io, `line: ${id}`);
      return 0;
    }
    case "client line remove": {
      confirm(parsed, help[command]!);
      const id = positional(parsed, 0, help[command]!);
      await withClientMutation(io, async () => {
        const current = await store.get(id);
        if (!current) throw new Error(`Line not found: ${id}`);
        await withRetiredClientLine(store, io, current, async () => {
          if (!(await store.remove(id))) throw new Error(`Line not found: ${id}`);
        });
      });
      out(io, `removed line: ${id}`);
      return 0;
    }
    case "client token rotate": {
      const result = await withClientMutation(io, async () => {
        const rotated = await store.rotateLocalBearer();
        await waitIfClientRunning(store, io);
        return rotated;
      });
      out(io, `local-bearer: ${result.bearer}`);
      return 0;
    }
    case "client doctor":
      return printDoctor(
        io,
        await (io.clientDoctor ?? (() => runClientDoctor(io)))(),
        parsed.flags.has("json"),
      );
    case "client serve": {
      const running = await startClientServer({
        configPath: io.clientConfigPath,
        stateRoot: io.clientStateRoot,
        ...(io.transportBinary === undefined ? {} : { transportBinary: io.transportBinary }),
      });
      out(io, "client: ready");
      await serveUntilSignal(running.close);
      return 0;
    }
    case "client service install":
      confirm(parsed, help[command]!);
      out(io, `service: ${await installUserService(currentServeCommand("client"), "client")}`);
      return 0;
    case "client service remove":
      confirm(parsed, help[command]!);
      out(io, `removed service: ${await removeUserService("client")}`);
      return 0;
    default:
      throw new UsageError(rootHelp);
  }
}

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}
interface CommandSpec {
  positionals: number;
  values?: readonly string[];
  flags?: readonly string[];
}

const commandSpecs: Record<string, CommandSpec> = {
  "gateway init": { positionals: 0, values: ["owner-id", "owner-name", "owner-summary"] },
  "gateway workspace add": { positionals: 1, values: ["name", "root", "summary"] },
  "gateway workspace list": { positionals: 0, flags: ["json"] },
  "gateway workspace update": { positionals: 1, values: ["name", "summary"] },
  "gateway workspace remove": { positionals: 1, flags: ["yes"] },
  "gateway client add": { positionals: 1, values: ["tailcat-key"] },
  "gateway client list": { positionals: 0, flags: ["json"] },
  "gateway client rotate": { positionals: 1, values: ["tailcat-key"], flags: ["yes"] },
  "gateway client revoke": { positionals: 1, flags: ["yes"] },
  "gateway doctor": { positionals: 0, flags: ["json"] },
  "gateway serve": { positionals: 0 },
  "gateway service install": { positionals: 0, flags: ["yes"] },
  "gateway service remove": { positionals: 0, flags: ["yes"] },
  "client init": { positionals: 0, values: ["port"] },
  "client line key-create": { positionals: 1, values: ["output"] },
  "client line add": {
    positionals: 1,
    values: ["owner-id", "remote-client-id", "server", "port", "key", "bearer"],
  },
  "client line list": { positionals: 0, flags: ["json"] },
  "client line update": { positionals: 1, values: ["key", "bearer"], flags: ["yes"] },
  "client line remove": { positionals: 1, flags: ["yes"] },
  "client token rotate": { positionals: 0 },
  "client doctor": { positionals: 0, flags: ["json"] },
  "client serve": { positionals: 0 },
  "client service install": { positionals: 0, flags: ["yes"] },
  "client service remove": { positionals: 0, flags: ["yes"] },
};

function commandKey(args: string[]): string {
  const role = args[0];
  if (role !== "gateway" && role !== "client") return role ?? "";
  const second = args[1];
  if (!second || second.startsWith("-")) return role;
  const grouped =
    role === "gateway" ? ["workspace", "client", "service"] : ["line", "token", "service"];
  if (!grouped.includes(second)) return `${role} ${second}`;
  const third = args[2];
  return !third || third.startsWith("-") ? `${role} ${second}` : `${role} ${second} ${third}`;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], values: new Map(), flags: new Set() };
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      parsed.positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    if (name === "yes" || name === "json") {
      parsed.flags.add(name);
      continue;
    }
    const next = args[++index];
    if (next === undefined || next.startsWith("--"))
      throw new UsageError(`Missing value for --${name}`);
    parsed.values.set(name, next);
  }
  return parsed;
}

function validateArgs(command: string, parsed: ParsedArgs, usage: string): void {
  const spec = commandSpecs[command];
  if (!spec) return;
  const allowedValues = new Set(spec.values ?? []);
  const allowedFlags = new Set(spec.flags ?? []);
  for (const name of parsed.values.keys())
    if (!allowedValues.has(name)) throw new UsageError(`Unknown option --${name}\n\n${usage}`);
  for (const name of parsed.flags)
    if (!allowedFlags.has(name)) throw new UsageError(`Unknown flag --${name}\n\n${usage}`);
  if (parsed.positionals.length !== spec.positionals) throw new UsageError(usage);
}

function required(parsed: ParsedArgs, name: string, usage: string): string {
  const value = parsed.values.get(name);
  if (value === undefined) throw new UsageError(`Missing required --${name}\n\n${usage}`);
  return value;
}

function positional(parsed: ParsedArgs, index: number, usage: string): string {
  const value = parsed.positionals[index];
  if (value === undefined) throw new UsageError(usage);
  return value;
}

function ownerInput(parsed: ParsedArgs, usage: string) {
  const summary = parsed.values.get("owner-summary");
  return {
    id: required(parsed, "owner-id", usage),
    name: required(parsed, "owner-name", usage),
    ...(summary === undefined ? {} : { summary }),
  };
}

async function inputValue(value: string, io: CliIo): Promise<string> {
  if (value !== "-") return value;
  const input = (await io.readStdin()).trim();
  if (!input) throw new UsageError("stdin value is empty");
  return input;
}

function portValue(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new UsageError(`Invalid --${name}: ${value}`);
  return port;
}

async function verifyLine(line: LineConfig, io: CliIo): Promise<void> {
  if (io.verifyLine) return io.verifyLine(line);
  const runtime = new LineRuntime({
    line,
    startConnector: (connector, signal) => startConnector(connector, io.transportBinary, signal),
  });
  try {
    await runtime.listWorkspaces(AbortSignal.timeout(15_000));
  } finally {
    await runtime.close();
  }
}

async function withClientMutation<T>(io: CliIo, operation: () => Promise<T>): Promise<T> {
  const release = await acquireProcessLock(
    join(io.clientStateRoot, "mutation.lock"),
    "Another Client configuration change is in progress",
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function withRetiredClientLine<T>(
  store: ClientConfigStore,
  io: CliIo,
  line: LineConfig,
  operation: () => Promise<T>,
): Promise<T> {
  const config = await store.read();
  const running = await processLockActive(join(io.clientStateRoot, "client.lock"));
  const request = running
    ? await requestClientLineRetirement(io.clientStateRoot, config, line)
    : undefined;
  try {
    if (request)
      await waitForClientLineRetirement(
        io.clientStateRoot,
        request,
        io.gatewayReloadTimeoutMs ?? 45_000,
      );
    const result = await operation();
    await waitIfClientRunning(store, io);
    return result;
  } catch (error) {
    if (request) await cancelClientLineRetirement(io.clientStateRoot, request).catch(() => {});
    throw error;
  }
}

async function waitIfGatewayRunning(
  store: ConfigStore,
  io: CliIo,
  predicate: (config: Awaited<ReturnType<ConfigStore["readEffective"]>>) => boolean,
): Promise<boolean> {
  if (!(await processLockActive(join(io.stateRoot, "gateway.lock")))) return false;
  return waitForGatewayReload(store, io.stateRoot, predicate, io.gatewayReloadTimeoutMs ?? 45_000);
}

async function waitIfClientRunning(store: ClientConfigStore, io: CliIo): Promise<boolean> {
  if (!(await processLockActive(join(io.clientStateRoot, "client.lock")))) return false;
  return waitForClientReload(
    store,
    io.clientStateRoot,
    await store.read(),
    io.gatewayReloadTimeoutMs ?? 45_000,
  );
}

function confirm(parsed: ParsedArgs, usage: string): void {
  if (!parsed.flags.has("yes"))
    throw new UsageError(`Destructive command requires --yes\n\n${usage}`);
}

function printRows(io: CliIo, rows: object[], json: boolean): void {
  if (json) out(io, JSON.stringify(rows));
  else
    out(
      io,
      rows.length === 0 ? "(none)" : rows.map((row) => Object.values(row).join("\t")).join("\n"),
    );
}

function printDoctor(io: CliIo, report: DoctorReport, json: boolean): number {
  out(
    io,
    json
      ? JSON.stringify(report)
      : report.checks.map((check) => `${check.status}\t${check.name}\t${check.message}`).join("\n"),
  );
  return report.ok ? 0 : 1;
}

async function serveUntilSignal(close: () => Promise<void>): Promise<void> {
  const shutdown = createShutdownWaiter();
  try {
    await shutdown.promise;
  } finally {
    shutdown.dispose();
    await close();
  }
}

function out(io: CliIo, text: string): void {
  io.writeOut(`${text}\n`);
}

function defaultIo(): CliIo {
  return {
    ...defaultPaths(),
    ...defaultClientPaths(),
    writeOut: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    readStdin: async () => Bun.stdin.text(),
  };
}

interface SignalTarget {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function createShutdownWaiter(target: SignalTarget = process): {
  promise: Promise<void>;
  dispose(): void;
} {
  let resolve!: () => void;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    target.removeListener("SIGINT", finish);
    target.removeListener("SIGTERM", finish);
  };
  const finish = () => {
    dispose();
    resolve();
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
    target.once("SIGINT", finish);
    target.once("SIGTERM", finish);
  });
  return { promise, dispose };
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
