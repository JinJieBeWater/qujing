#!/usr/bin/env bun

import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Deferred, Effect, Exit, Scope } from "effect";
import packageJson from "../package.json";
import { ClientConfigStore, type LineConfig, type LineInput } from "./client-config";
import {
  cancelClientLineRetirementEffect,
  requestClientLineRetirementEffect,
  waitForClientLineRetirementEffect,
} from "./client-control";
import { runClientDoctorEffect } from "./client-doctor";
import { startClientServerEffect } from "./client-server";
import { ConfigStore, type Config } from "./config";
import { createBearer } from "./credentials";
import { runDoctorEffect, type DoctorReport } from "./doctor";
import { waitForClientReloadEffect, waitForGatewayReloadEffect } from "./gateway-reload";
import { LineRuntime } from "./line-runtime";
import { defaultClientPaths, defaultPaths } from "./paths";
import { assertPrivatePathEffect, writeNewPrivateJsonEffect } from "./private-files";
import { acquireProcessLockEffect, processLockActiveEffect } from "./process-lock";
import {
  purgeClientRuntimeSessionsEffect,
  purgeWorkspaceRuntimeSessionsEffect,
} from "./runtime/cleanup";
import { RuntimeSessionStore } from "./runtime/sessions";
import { decode, LinePairing as LinePairingSchema, type LinePairing } from "./schemas";
import { currentServeCommand, installUserServiceEffect, removeUserServiceEffect } from "./service";
import { startServerEffect } from "./server";
import {
  createTransportKeyEffect,
  startConnectorEffect,
  validateTransportKeyEffect,
} from "./transport/process";
import { readTailcatStateEffect } from "./transport/supervisor";

const parseLinePairing = decode(LinePairingSchema);

export interface CliIo {
  configPath: string;
  stateRoot: string;
  clientConfigPath: string;
  clientStateRoot: string;
  writeOut(text: string): void;
  writeError(text: string): void;
  readStdinEffect(): Effect.Effect<string, unknown>;
  transportBinary?: string;
  gatewayReloadTimeoutMs?: number;
  validateTailcatKeyEffect(key: string): Effect.Effect<void, unknown>;
  verifyLineEffect(line: LineConfig): Effect.Effect<void, unknown>;
  clientDoctorEffect(): Effect.Effect<DoctorReport, unknown>;
}

class UsageError extends Error {}

const rootHelp = `Colleague Line

Usage: coll <command>

Options:
  -V, --version

Commands:
  init <gateway|client>
  workspace <add|list|update|remove>
  pair <create|accept|list|rotate|revoke>
  line <key-create|list|update|remove>
  token rotate
  doctor <gateway|client>
  serve <gateway|client>
  service <install|remove> <gateway|client>

Examples:
  coll init gateway --owner-id jason --owner-name Jason
  coll pair create alice-line --key - --out ./alice-line.pairing.json
  coll pair accept jason --from ./alice-line.pairing.json
  coll serve client
`;

const help: Record<string, string> = {
  init: `Usage: coll init <gateway|client>

Examples:
  coll init client`,
  workspace: `Usage: coll workspace <add|list|update|remove>

Examples:
  coll workspace list --json`,
  pair: `Usage: coll pair <create|accept|list|rotate|revoke>

Examples:
  coll pair list --json`,
  line: `Usage: coll line <key-create|list|update|remove>

Examples:
  coll line list --json`,
  token: `Usage: coll token rotate

Examples:
  coll token rotate`,
  doctor: `Usage: coll doctor <gateway|client>

Examples:
  coll doctor client`,
  serve: `Usage: coll serve <gateway|client>

Examples:
  coll serve client`,
  service: `Usage: coll service <install|remove> <gateway|client>

Examples:
  coll service install client --yes`,
  "init gateway": `Usage: coll init gateway --owner-id <id> --owner-name <name> [--owner-summary <summary>]

Examples:
  coll init gateway --owner-id jason --owner-name Jason
`,
  "init client": `Usage: coll init client [--port <loopback-port>]

Examples:
  coll init client
  coll init client --port 43111
`,
  "workspace add": `Usage: coll workspace add <id> --name <name> --root <directory> --summary <summary>

Examples:
  coll workspace add pi-tooling --name "Pi Tooling" --root ~/src/pi --summary "Pi SDK and extensions"
`,
  "workspace list": `Usage: coll workspace list [--json]

Examples:
  coll workspace list --json
`,
  "workspace update": `Usage: coll workspace update <id> [--name <name>] [--summary <summary>]

Examples:
  coll workspace update pi-tooling --summary "Pi SDK and runtime"
`,
  "workspace remove": `Usage: coll workspace remove <id> --yes

Examples:
  coll workspace remove old-workspace --yes
`,
  "pair create": `Usage: coll pair create <id> --key <public-key|-> [--out <path|->]

Examples:
  printf '%s' 'nodekey:...' | coll pair create alice-line --key - --out ./alice-line.pairing.json
`,
  "pair accept": `Usage: coll pair accept <line-id> --from <path|-> [--key <private-key-path>]

Examples:
  coll pair accept jason --from ./alice-line.pairing.json
  cat ./alice-line.pairing.json | coll pair accept jason --from -
`,
  "pair list": `Usage: coll pair list [--json]

Examples:
  coll pair list --json
`,
  "pair rotate": `Usage: coll pair rotate <id> --key <new-public-key|-> --yes

Examples:
  printf '%s' 'nodekey:...' | coll pair rotate alice-line --key - --yes
`,
  "pair revoke": `Usage: coll pair revoke <id> --yes

Examples:
  coll pair revoke alice-line --yes
`,
  "line key-create": `Usage: coll line key-create <line-id> [--output <private-key-path>]

Examples:
  coll line key-create jason
`,
  "line list": `Usage: coll line list [--json]

Examples:
  coll line list --json
`,
  "line update": `Usage: coll line update <line-id> --key <private-key-path> --bearer <token|-> --yes

Examples:
  printf '%s' '<new-remote-bearer>' | coll line update jason --key ~/.local/share/colleague-line/client/keys/jason.json --bearer - --yes
`,
  "line remove": `Usage: coll line remove <line-id> --yes

Examples:
  coll line remove jason --yes
`,
  "token rotate": `Usage: coll token rotate

Examples:
  coll token rotate
`,
  "doctor gateway": `Usage: coll doctor gateway [--json]

Examples:
  coll doctor gateway --json`,
  "doctor client": `Usage: coll doctor client [--json]

Examples:
  coll doctor client --json`,
  "serve gateway": `Usage: coll serve gateway

Examples:
  coll serve gateway`,
  "serve client": `Usage: coll serve client

Examples:
  coll serve client`,
  "service install gateway": `Usage: coll service install gateway --yes

Examples:
  coll service install gateway --yes`,
  "service install client": `Usage: coll service install client --yes

Examples:
  coll service install client --yes`,
  "service remove gateway": `Usage: coll service remove gateway --yes

Examples:
  coll service remove gateway --yes`,
  "service remove client": `Usage: coll service remove client --yes

Examples:
  coll service remove client --yes`,
};

/** Authoritative CLI orchestration. */
export function runCliEffect(args: string[], io: CliIo = defaultIo()) {
  return Effect.gen(function* () {
    if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
      io.writeOut(`${packageJson.version}\n`);
      return 0;
    }
    const command = yield* Effect.try({
      try: () => commandKey(args),
      catch: (error) => error,
    });
    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
      io.writeOut(command ? (help[command] ?? rootHelp) : rootHelp);
      return 0;
    }
    const parsed = yield* Effect.try({
      try: () => {
        const parsed = parseArgs(args.slice(command.split(" ").length));
        validateArgs(command, parsed, help[command] ?? rootHelp);
        return parsed;
      },
      catch: (error) => error,
    });
    if (gatewayCommands.has(command)) return yield* runGatewayEffect(command, parsed, io);
    if (clientCommands.has(command)) return yield* runClientEffect(command, parsed, io);
    return yield* Effect.fail(new UsageError(rootHelp));
  }).pipe(
    Effect.scoped,
    Effect.catchEager((error) =>
      Effect.sync(() => {
        if (error instanceof UsageError) {
          io.writeError(`${error.message.endsWith("\n") ? error.message : `${error.message}\n`}`);
          return 2;
        }
        io.writeError(`Error: ${error instanceof Error ? error.message : "Unknown failure"}\n`);
        return 1;
      }),
    ),
  );
}

function runGatewayEffect(command: string, parsed: ParsedArgs, io: CliIo) {
  const store = new ConfigStore(io);
  return Effect.gen(function* () {
    switch (command) {
      case "init gateway":
        yield* store.initEffect({ owner: ownerInput(parsed, help[command]!) });
        out(io, `initialized Gateway: ${io.configPath}`);
        return 0;
      case "workspace add": {
        const id = positional(parsed, 0, help[command]!);
        yield* store.addWorkspaceEffect({
          id,
          name: required(parsed, "name", help[command]!),
          root: required(parsed, "root", help[command]!),
          summary: required(parsed, "summary", help[command]!),
        });
        out(io, `workspace: ${id}`);
        return 0;
      }
      case "workspace list": {
        const [config, workspaces] = yield* Effect.all(
          [store.readEffectiveEffect(), store.listPublicWorkspacesEffect()],
          { concurrency: "unbounded" },
        );
        const availability = new Map(
          workspaces.map((workspace) => [workspace.id, workspace.available]),
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
      case "workspace update": {
        const id = positional(parsed, 0, help[command]!);
        const name = parsed.values.get("name");
        const summary = parsed.values.get("summary");
        if (name === undefined && summary === undefined) throw new UsageError(help[command]!);
        yield* store.updateWorkspaceEffect(id, {
          ...(name === undefined ? {} : { name }),
          ...(summary === undefined ? {} : { summary }),
        });
        out(io, `workspace: ${id}`);
        return 0;
      }
      case "workspace remove": {
        confirm(parsed, help[command]!);
        const id = positional(parsed, 0, help[command]!);
        if (!(yield* store.removeWorkspaceEffect(id)))
          throw new Error(`Workspace not found: ${id}`);
        const handled = yield* waitIfGatewayRunningEffect(
          store,
          io,
          (config) => !config.workspaces.some((workspace) => workspace.id === id),
        );
        if (!handled)
          yield* purgeWorkspaceRuntimeSessionsEffect(id, new RuntimeSessionStore(io.stateRoot));
        out(io, `removed workspace: ${id}`);
        return 0;
      }
      case "pair create": {
        const id = positional(parsed, 0, help[command]!);
        const tailcatKey = yield* inputValueEffect(required(parsed, "key", help[command]!), io);
        yield* io.validateTailcatKeyEffect(tailcatKey);
        if (!(yield* processLockActiveEffect(join(io.stateRoot, "gateway.lock"))))
          return yield* Effect.fail(new Error("Gateway must be running before pairing a Client"));
        const [config, tailcat] = yield* Effect.all([
          store.readEffectiveEffect(),
          readTailcatStateEffect(io.stateRoot),
        ]);
        if (!tailcat)
          return yield* Effect.fail(
            new Error("Gateway transport is not ready; start Gateway before pairing a Client"),
          );
        const bearer = createBearer();
        const pairing = parseLinePairing({
          version: 1,
          ownerId: config.owner.id,
          remoteClientId: id,
          serverAddress: tailcat.serverAddress,
          remotePort: tailcat.remotePort,
          remoteBearer: bearer,
        });
        const destination = parsed.values.get("out") ?? "-";
        const pairingPath = destination === "-" ? undefined : resolve(destination);
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (pairingPath) yield* writeNewPrivateJsonEffect(pairingPath, pairing);
            const announce = announcePairingEffect(destination, pairing, io);
            const added = yield* Effect.exit(store.addClientEffect({ id, tailcatKey }, bearer));
            if (Exit.isFailure(added)) {
              const committed = yield* store.authenticateEffect(bearer).pipe(
                Effect.map((client) => client?.id === id),
                Effect.catch(() => Effect.succeed(undefined)),
              );
              if (committed === false && pairingPath)
                yield* Effect.tryPromise({
                  try: () => rm(pairingPath, { force: true }),
                  catch: (error) => error,
                }).pipe(Effect.ignore);
              if (committed !== false) yield* announce;
              return yield* added;
            }
            yield* waitForGatewayReloadEffect(
              store,
              io.stateRoot,
              (config) =>
                config.clients.some(
                  (client) => client.id === id && client.tailcatKey === tailcatKey,
                ),
              io.gatewayReloadTimeoutMs ?? 45_000,
            ).pipe(
              Effect.flatMap((reloaded) =>
                reloaded
                  ? Effect.void
                  : Effect.fail(new Error("Gateway stopped before Client pairing became active")),
              ),
              Effect.onError(() => announce),
            );
            yield* announce;
          }),
        );
        return 0;
      }
      case "pair list": {
        const config = yield* store.readEffectiveEffect();
        printRows(
          io,
          config.clients.map(({ id, createdAt, updatedAt }) => ({
            id,
            createdAt,
            updatedAt,
          })),
          parsed.flags.has("json"),
        );
        return 0;
      }
      case "pair rotate": {
        confirm(parsed, help[command]!);
        const id = positional(parsed, 0, help[command]!);
        const tailcatKey = yield* inputValueEffect(required(parsed, "key", help[command]!), io);
        yield* io.validateTailcatKeyEffect(tailcatKey);
        const result = yield* store.rotateClientEffect(id, tailcatKey);
        out(io, `remote-client: ${id}\nbearer: ${result.bearer}`);
        yield* waitIfGatewayRunningEffect(store, io, (config) =>
          config.clients.some((client) => client.id === id && client.tailcatKey === tailcatKey),
        );
        return 0;
      }
      case "pair revoke": {
        confirm(parsed, help[command]!);
        const id = positional(parsed, 0, help[command]!);
        if (!(yield* store.revokeClientEffect(id)))
          throw new Error(`Remote Client not found: ${id}`);
        const handled = yield* waitIfGatewayRunningEffect(
          store,
          io,
          (config) => !config.clients.some((client) => client.id === id),
        );
        if (!handled)
          yield* purgeClientRuntimeSessionsEffect(id, new RuntimeSessionStore(io.stateRoot));
        out(io, `revoked remote-client: ${id}`);
        return 0;
      }
      case "doctor gateway":
        return printDoctor(io, yield* runDoctorEffect(io), parsed.flags.has("json"));
      case "serve gateway": {
        yield* startServerEffect(io, yield* Scope.Scope);
        out(io, "gateway: ready");
        yield* waitForShutdownEffect();
        return 0;
      }
      case "service install gateway":
        confirm(parsed, help[command]!);
        out(
          io,
          `service: ${yield* installUserServiceEffect(currentServeCommand("gateway"), "gateway")}`,
        );
        return 0;
      case "service remove gateway":
        confirm(parsed, help[command]!);
        out(io, `removed service: ${yield* removeUserServiceEffect("gateway")}`);
        return 0;
      default:
        throw new UsageError(rootHelp);
    }
  }).pipe(Effect.catchDefect((defect) => Effect.fail(defect)));
}

function runClientEffect(command: string, parsed: ParsedArgs, io: CliIo) {
  const store = new ClientConfigStore({ configPath: io.clientConfigPath });
  return Effect.gen(function* () {
    switch (command) {
      case "init client": {
        const port = portValue(parsed.values.get("port") ?? "43111", "port");
        const result = yield* store.initEffect({ port });
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
      case "line key-create": {
        const id = positional(parsed, 0, help[command]!);
        const output = resolve(
          parsed.values.get("output") ?? join(io.clientStateRoot, "keys", `${id}.json`),
        );
        const key = yield* createTransportKeyEffect(output, io.transportBinary);
        out(io, `key: ${key.keyPath}\npublic-key: ${key.publicKey}`);
        return 0;
      }
      case "pair accept": {
        const id = positional(parsed, 0, help[command]!);
        const pairing = yield* readPairingEffect(required(parsed, "from", help[command]!), io);
        const input: LineInput = {
          id,
          expectedOwnerId: pairing.ownerId,
          remoteClientId: pairing.remoteClientId,
          serverAddress: pairing.serverAddress,
          remotePort: pairing.remotePort,
          keyPath: resolve(
            parsed.values.get("key") ?? join(io.clientStateRoot, "keys", `${id}.json`),
          ),
          remoteBearer: pairing.remoteBearer,
        };
        const validated = yield* store.validateEffect(input);
        yield* withClientMutationEffect(
          io,
          verifyLineEffect(
            {
              ...validated,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            io,
          ).pipe(
            Effect.andThen(store.addEffect(validated)),
            Effect.andThen(waitIfClientRunningEffect(store, io)),
          ),
        );
        out(io, `line: ${validated.id}`);
        return 0;
      }
      case "line list":
        printRows(io, yield* store.listEffect(), parsed.flags.has("json"));
        return 0;
      case "line update": {
        confirm(parsed, help[command]!);
        const id = positional(parsed, 0, help[command]!);
        const credentials = yield* store.validateCredentialsEffect({
          keyPath: resolve(required(parsed, "key", help[command]!)),
          remoteBearer: yield* inputValueEffect(required(parsed, "bearer", help[command]!), io),
        });
        yield* withClientMutationEffect(
          io,
          Effect.gen(function* () {
            const current = yield* store.getEffect(id);
            if (!current) return yield* Effect.fail(new Error(`Line not found: ${id}`));
            yield* withRetiredClientLineEffect(
              store,
              io,
              current,
              Effect.gen(function* () {
                yield* verifyLineEffect(
                  {
                    ...current,
                    ...credentials,
                    updatedAt: new Date().toISOString(),
                  },
                  io,
                );
                return yield* store.updateCredentialsEffect(id, credentials);
              }),
            );
          }),
        );
        out(io, `line: ${id}`);
        return 0;
      }
      case "line remove": {
        confirm(parsed, help[command]!);
        const id = positional(parsed, 0, help[command]!);
        yield* withClientMutationEffect(
          io,
          Effect.gen(function* () {
            const current = yield* store.getEffect(id);
            if (!current) return yield* Effect.fail(new Error(`Line not found: ${id}`));
            yield* withRetiredClientLineEffect(
              store,
              io,
              current,
              store
                .removeEffect(id)
                .pipe(
                  Effect.flatMap((removed) =>
                    removed ? Effect.void : Effect.fail(new Error(`Line not found: ${id}`)),
                  ),
                ),
            );
          }),
        );
        out(io, `removed line: ${id}`);
        return 0;
      }
      case "token rotate": {
        const result = yield* withClientMutationEffect(
          io,
          store
            .rotateLocalBearerEffect()
            .pipe(Effect.tap(() => waitIfClientRunningEffect(store, io))),
        );
        out(io, `local-bearer: ${result.bearer}`);
        return 0;
      }
      case "doctor client": {
        const report = yield* io.clientDoctorEffect();
        return printDoctor(io, report, parsed.flags.has("json"));
      }
      case "serve client": {
        yield* startClientServerEffect(
          {
            configPath: io.clientConfigPath,
            stateRoot: io.clientStateRoot,
            ...(io.transportBinary === undefined ? {} : { transportBinary: io.transportBinary }),
          },
          yield* Scope.Scope,
        );
        out(io, "client: ready");
        yield* waitForShutdownEffect();
        return 0;
      }
      case "service install client":
        confirm(parsed, help[command]!);
        out(
          io,
          `service: ${yield* installUserServiceEffect(currentServeCommand("client"), "client")}`,
        );
        return 0;
      case "service remove client":
        confirm(parsed, help[command]!);
        out(io, `removed service: ${yield* removeUserServiceEffect("client")}`);
        return 0;
      default:
        throw new UsageError(rootHelp);
    }
  }).pipe(Effect.catchDefect((defect) => Effect.fail(defect)));
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
  "init gateway": {
    positionals: 0,
    values: ["owner-id", "owner-name", "owner-summary"],
  },
  "init client": { positionals: 0, values: ["port"] },
  "workspace add": {
    positionals: 1,
    values: ["name", "root", "summary"],
  },
  "workspace list": { positionals: 0, flags: ["json"] },
  "workspace update": { positionals: 1, values: ["name", "summary"] },
  "workspace remove": { positionals: 1, flags: ["yes"] },
  "pair create": {
    positionals: 1,
    values: ["key", "out"],
  },
  "pair accept": {
    positionals: 1,
    values: ["from", "key"],
  },
  "pair list": { positionals: 0, flags: ["json"] },
  "pair rotate": {
    positionals: 1,
    values: ["key"],
    flags: ["yes"],
  },
  "pair revoke": { positionals: 1, flags: ["yes"] },
  "line key-create": { positionals: 1, values: ["output"] },
  "line list": { positionals: 0, flags: ["json"] },
  "line update": {
    positionals: 1,
    values: ["key", "bearer"],
    flags: ["yes"],
  },
  "line remove": { positionals: 1, flags: ["yes"] },
  "token rotate": { positionals: 0 },
  "doctor gateway": { positionals: 0, flags: ["json"] },
  "doctor client": { positionals: 0, flags: ["json"] },
  "serve gateway": { positionals: 0 },
  "serve client": { positionals: 0 },
  "service install gateway": { positionals: 0, flags: ["yes"] },
  "service install client": { positionals: 0, flags: ["yes"] },
  "service remove gateway": { positionals: 0, flags: ["yes"] },
  "service remove client": { positionals: 0, flags: ["yes"] },
};

const gatewayCommands = new Set([
  "init gateway",
  "workspace add",
  "workspace list",
  "workspace update",
  "workspace remove",
  "pair create",
  "pair list",
  "pair rotate",
  "pair revoke",
  "doctor gateway",
  "serve gateway",
  "service install gateway",
  "service remove gateway",
]);

const clientCommands = new Set([
  "init client",
  "pair accept",
  "line key-create",
  "line list",
  "line update",
  "line remove",
  "token rotate",
  "doctor client",
  "serve client",
  "service install client",
  "service remove client",
]);

function commandKey(args: string[]): string {
  for (let length = Math.min(3, args.length); length > 0; length--) {
    const candidate = args.slice(0, length).join(" ");
    if (candidate in help || candidate in commandSpecs) return candidate;
  }
  return args[0] ?? "";
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positionals: [],
    values: new Map(),
    flags: new Set(),
  };
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

function inputValueEffect(value: string, io: CliIo) {
  if (value !== "-") return Effect.succeed(value);
  return io.readStdinEffect().pipe(
    Effect.map((input) => input.trim()),
    Effect.flatMap((input) =>
      input ? Effect.succeed(input) : Effect.fail(new UsageError("stdin value is empty")),
    ),
  );
}

function readPairingEffect(source: string, io: CliIo) {
  const text =
    source === "-"
      ? io.readStdinEffect()
      : assertPrivatePathEffect(resolve(source), false).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () => readFile(resolve(source), "utf8"),
              catch: (error) => error,
            }),
          ),
        );
  return text.pipe(
    Effect.flatMap((value) =>
      Effect.try({
        try: () => parseLinePairing(JSON.parse(value)),
        catch: () => new UsageError("Invalid pairing bundle"),
      }),
    ),
  );
}

function announcePairingEffect(destination: string, pairing: LinePairing, io: CliIo) {
  if (destination === "-") return Effect.sync(() => out(io, JSON.stringify(pairing)));
  return Effect.sync(() => out(io, `pairing: ${resolve(destination)}`));
}

function portValue(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new UsageError(`Invalid --${name}: ${value}`);
  return port;
}

function verifyLineEffect(line: LineConfig, io: CliIo): Effect.Effect<void, unknown> {
  return io.verifyLineEffect(line);
}

function withClientMutationEffect<A, E, R>(
  io: CliIo,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R> {
  return Effect.acquireUseRelease(
    acquireProcessLockEffect(
      join(io.clientStateRoot, "mutation.lock"),
      "Another Client configuration change is in progress",
    ),
    () => operation,
    (release) => release,
  );
}

function withRetiredClientLineEffect<A, E, R>(
  store: ClientConfigStore,
  io: CliIo,
  line: LineConfig,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R> {
  return Effect.gen(function* () {
    const config = yield* store.readEffect();
    const running = yield* processLockActiveEffect(join(io.clientStateRoot, "client.lock"));
    const request = running
      ? yield* requestClientLineRetirementEffect(io.clientStateRoot, config, line)
      : undefined;
    const guarded = Effect.gen(function* () {
      if (request)
        yield* waitForClientLineRetirementEffect(
          io.clientStateRoot,
          request,
          io.gatewayReloadTimeoutMs ?? 45_000,
        );
      const result = yield* operation;
      yield* waitIfClientRunningEffect(store, io);
      return result;
    });
    return yield* guarded.pipe(
      Effect.onError(() =>
        request
          ? cancelClientLineRetirementEffect(io.clientStateRoot, request).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
  });
}

function waitIfGatewayRunningEffect(
  store: ConfigStore,
  io: CliIo,
  predicate: (config: Config) => boolean,
): Effect.Effect<boolean, unknown> {
  return processLockActiveEffect(join(io.stateRoot, "gateway.lock")).pipe(
    Effect.flatMap((running) =>
      running
        ? waitForGatewayReloadEffect(
            store,
            io.stateRoot,
            predicate,
            io.gatewayReloadTimeoutMs ?? 45_000,
          )
        : Effect.succeed(false),
    ),
  );
}

function waitIfClientRunningEffect(
  store: ClientConfigStore,
  io: CliIo,
): Effect.Effect<boolean, unknown> {
  return processLockActiveEffect(join(io.clientStateRoot, "client.lock")).pipe(
    Effect.flatMap((running) =>
      running
        ? store
            .readEffect()
            .pipe(
              Effect.flatMap((config) =>
                waitForClientReloadEffect(
                  store,
                  io.clientStateRoot,
                  config,
                  io.gatewayReloadTimeoutMs ?? 45_000,
                ),
              ),
            )
        : Effect.succeed(false),
    ),
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

function out(io: CliIo, text: string): void {
  io.writeOut(`${text}\n`);
}

function defaultIo(): CliIo {
  return {
    ...defaultPaths(),
    ...defaultClientPaths(),
    writeOut: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    readStdinEffect: () =>
      Effect.tryPromise({
        try: () => Bun.stdin.text(),
        catch: (error) => error,
      }),
    validateTailcatKeyEffect: (key) => validateTransportKeyEffect(key),
    verifyLineEffect: (line) => {
      const runtime = new LineRuntime({
        line,
        startConnectorEffect: (connector, signal) =>
          startConnectorEffect(connector, undefined, signal),
      });
      return Effect.acquireUseRelease(
        Effect.succeed(runtime),
        (active) => active.listWorkspacesEffect(AbortSignal.timeout(15_000)).pipe(Effect.asVoid),
        (active) => active.closeEffect(),
      );
    },
    clientDoctorEffect: () => runClientDoctorEffect(defaultClientPaths()),
  };
}

interface SignalTarget {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

function waitForShutdownEffect(target: SignalTarget = process) {
  return Effect.gen(function* () {
    const shutdown = yield* Deferred.make<void>();
    const finish = () => void Effect.runSync(Deferred.succeed(shutdown, undefined));
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        target.once("SIGINT", finish);
        target.once("SIGTERM", finish);
      }),
      () =>
        Effect.sync(() => {
          target.removeListener("SIGINT", finish);
          target.removeListener("SIGTERM", finish);
        }),
    );
    yield* Deferred.await(shutdown);
  });
}

if (import.meta.main)
  process.exitCode = await Effect.runPromise(runCliEffect(process.argv.slice(2)));
