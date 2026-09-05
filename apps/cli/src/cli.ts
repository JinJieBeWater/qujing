#!/usr/bin/env bun

import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Deferred, Effect, Exit, Scope } from "effect";
import packageJson from "../package.json";
import { AgentConfigStore, type PeerConfig, type PeerInput } from "./agent-config";
import {
  cancelPeerRetirementEffect,
  requestPeerRetirementEffect,
  waitForPeerRetirementEffect,
} from "./agent-control";
import { runAgentDoctorEffect } from "./agent-doctor";
import { startAgentServerEffect } from "./agent-server";
import { ConfigStore, type Config } from "./config";
import { createBearer } from "./credentials";
import { runDoctorEffect, type DoctorReport } from "./doctor";
import { waitForAgentReloadEffect, waitForNodeReloadEffect } from "./reload";
import { PeerRuntime } from "./peer-runtime";
import { defaultAgentPaths, defaultPaths } from "./paths";
import { assertPrivatePathEffect, writeNewPrivateJsonEffect } from "./private-files";
import { acquireProcessLockEffect, processLockActiveEffect } from "./process-lock";
import {
  purgePeerRuntimeSessionsEffect,
  purgeWorkspaceRuntimeSessionsEffect,
} from "./runtime/cleanup";
import { RuntimeSessionStore } from "./runtime/sessions";
import {
  decode,
  PeerInvite as PeerInviteSchema,
  TANSTACK_ACP_AUTH_MODES,
  TANSTACK_ACP_PERMISSION_MODES,
  type PeerInvite,
} from "./schemas";
import { currentServeCommand, installUserServiceEffect, removeUserServiceEffect } from "./service";
import { startServerEffect } from "./server";
import {
  createTransportKeyEffect,
  startConnectorEffect,
  validateTransportKeyEffect,
} from "./transport/process";
import { readTailcatStateEffect } from "./transport/supervisor";

const parsePeerInvite = decode(PeerInviteSchema);

export interface CliIo {
  configPath: string;
  stateRoot: string;
  agentConfigPath: string;
  agentStateRoot: string;
  writeOut(text: string): void;
  writeError(text: string): void;
  readStdinEffect(): Effect.Effect<string, unknown>;
  transportBinary?: string;
  nodeReloadTimeoutMs?: number;
  validateTailcatKeyEffect(key: string): Effect.Effect<void, unknown>;
  verifyPeerEffect(peer: PeerConfig): Effect.Effect<void, unknown>;
  agentDoctorEffect(): Effect.Effect<DoctorReport, unknown>;
}

class UsageError extends Error {}

const rootHelp = `Qujing

Usage: qj <command>

Options:
  -V, --version

Commands:
  init <node|agent>
  workspace <add|list|update|remove>
  peer <invite|accept|key-create|list|update|remove|rotate|revoke>
  runtime <set-pi|set-acp>
  token rotate
  doctor <node|agent>
  serve <node|agent>
  service <install|remove> <node|agent>

Examples:
  qj init node --node-id jinjiebewater --node-name JinJieBeWater
  qj peer invite alice-peer --key - --out ./alice-peer.pairing.json
  qj peer accept jinjiebewater --from ./alice-peer.pairing.json
  qj serve agent
`;

const help: Record<string, string> = {
  init: `Usage: qj init <node|agent>

Examples:
  qj init agent`,
  workspace: `Usage: qj workspace <add|list|update|remove>

Examples:
  qj workspace list --json`,
  peer: `Usage: qj peer <invite|accept|key-create|list|update|remove|rotate|revoke>

Examples:
  qj peer list --json`,
  runtime: `Usage: qj runtime <set-pi|set-acp>

Examples:
  qj runtime set-pi --model openai-codex/gpt-5.5
  qj runtime set-acp custom --model model-id --command 'agent --acp --model {model} --cwd {cwd}' --auth host`,
  token: `Usage: qj token rotate

Examples:
  qj token rotate`,
  doctor: `Usage: qj doctor <node|agent>

Examples:
  qj doctor agent`,
  serve: `Usage: qj serve <node|agent>

Examples:
  qj serve agent`,
  service: `Usage: qj service <install|remove> <node|agent>

Examples:
  qj service install agent --yes`,
  "init node": `Usage: qj init node --node-id <id> --node-name <name> [--node-summary <summary>]

Examples:
  qj init node --node-id jinjiebewater --node-name JinJieBeWater
`,
  "init agent": `Usage: qj init agent [--port <loopback-port>]

Examples:
  qj init agent
  qj init agent --port 43111
`,
  "workspace add": `Usage: qj workspace add <id> --name <name> --root <directory> --summary <summary>

Examples:
  qj workspace add runtime-tooling --name "Runtime Tooling" --root ~/src/runtime --summary "Runtime SDK and extensions"
`,
  "workspace list": `Usage: qj workspace list [--json]

Examples:
  qj workspace list --json
`,
  "workspace update": `Usage: qj workspace update <id> [--name <name>] [--summary <summary>]

Examples:
  qj workspace update runtime-tooling --summary "Runtime SDK and runtime"
`,
  "workspace remove": `Usage: qj workspace remove <id> --yes

Examples:
  qj workspace remove old-workspace --yes
`,
  "peer invite": `Usage: qj peer invite <id> --key <public-key|-> [--out <path|->]

Examples:
  printf '%s' 'nodekey:...' | qj peer invite alice-peer --key - --out ./alice-peer.pairing.json
`,
  "peer accept": `Usage: qj peer accept <peer-id> --from <path|-> [--key <private-key-path>]

Examples:
  qj peer accept jinjiebewater --from ./alice-peer.pairing.json
  cat ./alice-peer.pairing.json | qj peer accept jinjiebewater --from -
`,
  "peer rotate": `Usage: qj peer rotate <id> --key <new-public-key|-> --yes

Examples:
  printf '%s' 'nodekey:...' | qj peer rotate alice-peer --key - --yes
`,
  "peer revoke": `Usage: qj peer revoke <id> --yes

Examples:
  qj peer revoke alice-peer --yes
`,
  "runtime set-acp": `Usage: qj runtime set-acp <name> --model <model> --command <command> [--auth <host|api-key>] [--auth-method-id <id>] [--permission <default|acceptEdits|bypassPermissions>]

Examples:
  qj runtime set-acp custom --model model-id --command 'agent --acp --model {model} --cwd {cwd}' --auth host
`,
  "runtime set-pi": `Usage: qj runtime set-pi --model <provider/model> [--binary <pi>]

Examples:
  qj runtime set-pi --model openai-codex/gpt-5.5
`,
  "peer key-create": `Usage: qj peer key-create <peer-id> [--output <private-key-path>]

Examples:
  qj peer key-create jinjiebewater
`,
  "peer list": `Usage: qj peer list [--json]

Examples:
  qj peer list --json
`,
  "peer update": `Usage: qj peer update <peer-id> --key <private-key-path> --bearer <token|-> --yes

Examples:
  printf '%s' '<new-remote-bearer>' | qj peer update jinjiebewater --key ~/.local/share/qujing/agent/keys/jinjiebewater.json --bearer - --yes
`,
  "peer remove": `Usage: qj peer remove <peer-id> --yes

Examples:
  qj peer remove jinjiebewater --yes
`,
  "token rotate": `Usage: qj token rotate

Examples:
  qj token rotate
`,
  "doctor node": `Usage: qj doctor node [--json]

Examples:
  qj doctor node --json`,
  "doctor agent": `Usage: qj doctor agent [--json]

Examples:
  qj doctor agent --json`,
  "serve node": `Usage: qj serve node

Examples:
  qj serve node`,
  "serve agent": `Usage: qj serve agent

Examples:
  qj serve agent`,
  "service install node": `Usage: qj service install node --yes

Examples:
  qj service install node --yes`,
  "service install agent": `Usage: qj service install agent --yes

Examples:
  qj service install agent --yes`,
  "service remove node": `Usage: qj service remove node --yes

Examples:
  qj service remove node --yes`,
  "service remove agent": `Usage: qj service remove agent --yes

Examples:
  qj service remove agent --yes`,
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
    if (nodeCommands.has(command)) return yield* runNodeEffect(command, parsed, io);
    if (agentCommands.has(command)) return yield* runAgentEffect(command, parsed, io);
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

function runNodeEffect(command: string, parsed: ParsedArgs, io: CliIo) {
  const store = new ConfigStore(io);
  return Effect.gen(function* () {
    switch (command) {
      case "init node":
        yield* store.initEffect({ node: nodeInput(parsed, help[command]!) });
        out(io, `initialized Node: ${io.configPath}`);
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
        const handled = yield* waitIfNodeRunningEffect(
          store,
          io,
          (config) => !config.workspaces.some((workspace) => workspace.id === id),
        );
        if (!handled)
          yield* purgeWorkspaceRuntimeSessionsEffect(id, new RuntimeSessionStore(io.stateRoot));
        out(io, `removed workspace: ${id}`);
        return 0;
      }
      case "peer invite": {
        const id = positional(parsed, 0, help[command]!);
        const tailcatKey = yield* inputValueEffect(required(parsed, "key", help[command]!), io);
        yield* io.validateTailcatKeyEffect(tailcatKey);
        if (!(yield* processLockActiveEffect(join(io.stateRoot, "node.lock"))))
          return yield* Effect.fail(new Error("Node must be running before inviting a peer"));
        const [config, tailcat] = yield* Effect.all([
          store.readEffectiveEffect(),
          readTailcatStateEffect(io.stateRoot),
        ]);
        if (!tailcat)
          return yield* Effect.fail(
            new Error("Node transport is not ready; start Node before inviting a peer"),
          );
        const bearer = createBearer();
        const pairing = parsePeerInvite({
          version: 1,
          nodeId: config.node.id,
          remoteAgentId: id,
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
            const added = yield* Effect.exit(store.addAgentEffect({ id, tailcatKey }, bearer));
            if (Exit.isFailure(added)) {
              const committed = yield* store.authenticateEffect(bearer).pipe(
                Effect.map((agent) => agent?.id === id),
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
            yield* waitForNodeReloadEffect(
              store,
              io.stateRoot,
              (config) =>
                config.peers.some((agent) => agent.id === id && agent.tailcatKey === tailcatKey),
              io.nodeReloadTimeoutMs ?? 45_000,
            ).pipe(
              Effect.flatMap((reloaded) =>
                reloaded
                  ? Effect.void
                  : Effect.fail(new Error("Node stopped before peer invite became active")),
              ),
              Effect.onError(() => announce),
            );
            yield* announce;
          }),
        );
        return 0;
      }
      case "peer rotate": {
        confirm(parsed, help[command]!);
        const id = positional(parsed, 0, help[command]!);
        const tailcatKey = yield* inputValueEffect(required(parsed, "key", help[command]!), io);
        yield* io.validateTailcatKeyEffect(tailcatKey);
        const result = yield* store.rotateAgentEffect(id, tailcatKey);
        out(io, `peer: ${id}\nbearer: ${result.bearer}`);
        yield* waitIfNodeRunningEffect(store, io, (config) =>
          config.peers.some((agent) => agent.id === id && agent.tailcatKey === tailcatKey),
        );
        return 0;
      }
      case "peer revoke": {
        confirm(parsed, help[command]!);
        const id = positional(parsed, 0, help[command]!);
        if (!(yield* store.revokeAgentEffect(id))) throw new Error(`Peer not found: ${id}`);
        const handled = yield* waitIfNodeRunningEffect(
          store,
          io,
          (config) => !config.peers.some((agent) => agent.id === id),
        );
        if (!handled)
          yield* purgePeerRuntimeSessionsEffect(id, new RuntimeSessionStore(io.stateRoot));
        out(io, `revoked peer: ${id}`);
        return 0;
      }
      case "runtime set-acp": {
        const name = positional(parsed, 0, help[command]!);
        const authMode = optionalLiteral(
          parsed.values.get("auth"),
          TANSTACK_ACP_AUTH_MODES,
          help[command]!,
        );
        const permissionMode = optionalLiteral(
          parsed.values.get("permission"),
          TANSTACK_ACP_PERMISSION_MODES,
          help[command]!,
        );
        yield* store.setRuntimeEffect({
          kind: "tanstack-acp",
          name,
          model: required(parsed, "model", help[command]!),
          command: required(parsed, "command", help[command]!),
          ...(authMode === undefined ? {} : { authMode }),
          ...(parsed.values.get("auth-method-id") === undefined
            ? {}
            : { authMethodId: parsed.values.get("auth-method-id")! }),
          ...(permissionMode === undefined ? {} : { permissionMode }),
        });
        out(io, `runtime: tanstack-acp\nagent: ${name}`);
        yield* waitIfNodeRunningEffect(
          store,
          io,
          (config) => config.runtime?.kind === "tanstack-acp" && config.runtime.name === name,
        );
        return 0;
      }
      case "runtime set-pi": {
        const model = required(parsed, "model", help[command]!);
        yield* store.setRuntimeEffect({
          kind: "pi-rpc",
          model,
          ...(parsed.values.get("binary") === undefined
            ? {}
            : { binary: parsed.values.get("binary")! }),
        });
        out(io, `runtime: pi-rpc\nmodel: ${model}`);
        yield* waitIfNodeRunningEffect(
          store,
          io,
          (config) => config.runtime?.kind === "pi-rpc" && config.runtime.model === model,
        );
        return 0;
      }
      case "doctor node":
        return printDoctor(io, yield* runDoctorEffect(io), parsed.flags.has("json"));
      case "serve node": {
        yield* startServerEffect(io, yield* Scope.Scope);
        out(io, "node: ready");
        yield* waitForShutdownEffect();
        return 0;
      }
      case "service install node": {
        confirm(parsed, help[command]!);
        out(io, `service: ${yield* installUserServiceEffect(currentServeCommand("node"), "node")}`);
        return 0;
      }
      case "service remove node":
        confirm(parsed, help[command]!);
        out(io, `removed service: ${yield* removeUserServiceEffect("node")}`);
        return 0;
      default:
        throw new UsageError(rootHelp);
    }
  }).pipe(Effect.catchDefect((defect) => Effect.fail(defect)));
}

function runAgentEffect(command: string, parsed: ParsedArgs, io: CliIo) {
  const store = new AgentConfigStore({ configPath: io.agentConfigPath });
  return Effect.gen(function* () {
    switch (command) {
      case "init agent": {
        const port = portValue(parsed.values.get("port") ?? "43111", "port");
        const result = yield* store.initEffect({ port });
        if (!result.initialized) {
          out(io, `Agent already initialized: ${io.agentConfigPath}`);
          return 0;
        }
        out(
          io,
          `initialized Agent: ${io.agentConfigPath}\nlocal-bearer: ${result.bearer}\nmcp: http://127.0.0.1:${port}/mcp`,
        );
        return 0;
      }
      case "peer key-create": {
        const id = positional(parsed, 0, help[command]!);
        const output = resolve(
          parsed.values.get("output") ?? join(io.agentStateRoot, "keys", `${id}.json`),
        );
        const key = yield* createTransportKeyEffect(output, io.transportBinary);
        out(io, `key: ${key.keyPath}\npublic-key: ${key.publicKey}`);
        return 0;
      }
      case "peer accept": {
        const id = positional(parsed, 0, help[command]!);
        const pairing = yield* readPairingEffect(required(parsed, "from", help[command]!), io);
        const input: PeerInput = {
          id,
          expectedNodeId: pairing.nodeId,
          remoteAgentId: pairing.remoteAgentId,
          serverAddress: pairing.serverAddress,
          remotePort: pairing.remotePort,
          keyPath: resolve(
            parsed.values.get("key") ?? join(io.agentStateRoot, "keys", `${id}.json`),
          ),
          remoteBearer: pairing.remoteBearer,
        };
        const validated = yield* store.validateEffect(input);
        yield* withAgentMutationEffect(
          io,
          verifyPeerEffect(
            {
              ...validated,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            io,
          ).pipe(
            Effect.andThen(store.addEffect(validated)),
            Effect.andThen(waitIfAgentRunningEffect(store, io)),
          ),
        );
        out(io, `peer: ${validated.id}`);
        return 0;
      }
      case "peer list":
        printRows(io, yield* store.listEffect(), parsed.flags.has("json"));
        return 0;
      case "peer update": {
        confirm(parsed, help[command]!);
        const id = positional(parsed, 0, help[command]!);
        const credentials = yield* store.validateCredentialsEffect({
          keyPath: resolve(required(parsed, "key", help[command]!)),
          remoteBearer: yield* inputValueEffect(required(parsed, "bearer", help[command]!), io),
        });
        yield* withAgentMutationEffect(
          io,
          Effect.gen(function* () {
            const current = yield* store.getEffect(id);
            if (!current) return yield* Effect.fail(new Error(`Peer not found: ${id}`));
            yield* withRetiredAgentPeerEffect(
              store,
              io,
              current,
              Effect.gen(function* () {
                yield* verifyPeerEffect(
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
        out(io, `peer: ${id}`);
        return 0;
      }
      case "peer remove": {
        confirm(parsed, help[command]!);
        const id = positional(parsed, 0, help[command]!);
        yield* withAgentMutationEffect(
          io,
          Effect.gen(function* () {
            const current = yield* store.getEffect(id);
            if (!current) return yield* Effect.fail(new Error(`Peer not found: ${id}`));
            yield* withRetiredAgentPeerEffect(
              store,
              io,
              current,
              store
                .removeEffect(id)
                .pipe(
                  Effect.flatMap((removed) =>
                    removed ? Effect.void : Effect.fail(new Error(`Peer not found: ${id}`)),
                  ),
                ),
            );
          }),
        );
        out(io, `removed peer: ${id}`);
        return 0;
      }
      case "token rotate": {
        const result = yield* withAgentMutationEffect(
          io,
          store
            .rotateLocalBearerEffect()
            .pipe(Effect.tap(() => waitIfAgentRunningEffect(store, io))),
        );
        out(io, `local-bearer: ${result.bearer}`);
        return 0;
      }
      case "doctor agent": {
        const report = yield* io.agentDoctorEffect();
        return printDoctor(io, report, parsed.flags.has("json"));
      }
      case "serve agent": {
        yield* startAgentServerEffect(
          {
            configPath: io.agentConfigPath,
            stateRoot: io.agentStateRoot,
            ...(io.transportBinary === undefined ? {} : { transportBinary: io.transportBinary }),
          },
          yield* Scope.Scope,
        );
        out(io, "agent: ready");
        yield* waitForShutdownEffect();
        return 0;
      }
      case "service install agent": {
        confirm(parsed, help[command]!);
        out(
          io,
          `service: ${yield* installUserServiceEffect(currentServeCommand("agent"), "agent")}`,
        );
        return 0;
      }
      case "service remove agent":
        confirm(parsed, help[command]!);
        out(io, `removed service: ${yield* removeUserServiceEffect("agent")}`);
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
  "init node": {
    positionals: 0,
    values: ["node-id", "node-name", "node-summary"],
  },
  "init agent": { positionals: 0, values: ["port"] },
  "workspace add": {
    positionals: 1,
    values: ["name", "root", "summary"],
  },
  "workspace list": { positionals: 0, flags: ["json"] },
  "workspace update": { positionals: 1, values: ["name", "summary"] },
  "workspace remove": { positionals: 1, flags: ["yes"] },
  "peer invite": {
    positionals: 1,
    values: ["key", "out"],
  },
  "peer accept": {
    positionals: 1,
    values: ["from", "key"],
  },
  "peer rotate": {
    positionals: 1,
    values: ["key"],
    flags: ["yes"],
  },
  "peer revoke": { positionals: 1, flags: ["yes"] },
  "runtime set-acp": {
    positionals: 1,
    values: ["model", "command", "auth", "auth-method-id", "permission"],
  },
  "runtime set-pi": {
    positionals: 0,
    values: ["model", "binary"],
  },
  "peer key-create": { positionals: 1, values: ["output"] },
  "peer list": { positionals: 0, flags: ["json"] },
  "peer update": {
    positionals: 1,
    values: ["key", "bearer"],
    flags: ["yes"],
  },
  "peer remove": { positionals: 1, flags: ["yes"] },
  "token rotate": { positionals: 0 },
  "doctor node": { positionals: 0, flags: ["json"] },
  "doctor agent": { positionals: 0, flags: ["json"] },
  "serve node": { positionals: 0 },
  "serve agent": { positionals: 0 },
  "service install node": { positionals: 0, flags: ["yes"] },
  "service install agent": { positionals: 0, flags: ["yes"] },
  "service remove node": { positionals: 0, flags: ["yes"] },
  "service remove agent": { positionals: 0, flags: ["yes"] },
};

const nodeCommands = new Set([
  "init node",
  "workspace add",
  "workspace list",
  "workspace update",
  "workspace remove",
  "peer invite",
  "peer rotate",
  "peer revoke",
  "runtime set-pi",
  "runtime set-acp",
  "doctor node",
  "serve node",
  "service install node",
  "service remove node",
]);

const agentCommands = new Set([
  "init agent",
  "peer accept",
  "peer key-create",
  "peer list",
  "peer update",
  "peer remove",
  "token rotate",
  "doctor agent",
  "serve agent",
  "service install agent",
  "service remove agent",
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

function optionalLiteral<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  usage: string,
): T | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(usage);
}

function positional(parsed: ParsedArgs, index: number, usage: string): string {
  const value = parsed.positionals[index];
  if (value === undefined) throw new UsageError(usage);
  return value;
}

function nodeInput(parsed: ParsedArgs, usage: string) {
  const summary = parsed.values.get("node-summary");
  return {
    id: required(parsed, "node-id", usage),
    name: required(parsed, "node-name", usage),
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
        try: () => parsePeerInvite(JSON.parse(value)),
        catch: () => new UsageError("Invalid peer invite"),
      }),
    ),
  );
}

function announcePairingEffect(destination: string, pairing: PeerInvite, io: CliIo) {
  if (destination === "-") return Effect.sync(() => out(io, JSON.stringify(pairing)));
  return Effect.sync(() => out(io, `peer-invite: ${resolve(destination)}`));
}

function portValue(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new UsageError(`Invalid --${name}: ${value}`);
  return port;
}

function verifyPeerEffect(peer: PeerConfig, io: CliIo): Effect.Effect<void, unknown> {
  return io.verifyPeerEffect(peer);
}

function withAgentMutationEffect<A, E, R>(
  io: CliIo,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R> {
  return Effect.acquireUseRelease(
    acquireProcessLockEffect(
      join(io.agentStateRoot, "mutation.lock"),
      "Another Agent configuration change is in progress",
    ),
    () => operation,
    (release) => release,
  );
}

function withRetiredAgentPeerEffect<A, E, R>(
  store: AgentConfigStore,
  io: CliIo,
  peer: PeerConfig,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R> {
  return Effect.gen(function* () {
    const config = yield* store.readEffect();
    const running = yield* processLockActiveEffect(join(io.agentStateRoot, "agent.lock"));
    const request = running
      ? yield* requestPeerRetirementEffect(io.agentStateRoot, config, peer)
      : undefined;
    const guarded = Effect.gen(function* () {
      if (request)
        yield* waitForPeerRetirementEffect(
          io.agentStateRoot,
          request,
          io.nodeReloadTimeoutMs ?? 45_000,
        );
      const result = yield* operation;
      yield* waitIfAgentRunningEffect(store, io);
      return result;
    });
    return yield* guarded.pipe(
      Effect.onError(() =>
        request
          ? cancelPeerRetirementEffect(io.agentStateRoot, request).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
  });
}

function waitIfNodeRunningEffect(
  store: ConfigStore,
  io: CliIo,
  predicate: (config: Config) => boolean,
): Effect.Effect<boolean, unknown> {
  return processLockActiveEffect(join(io.stateRoot, "node.lock")).pipe(
    Effect.flatMap((running) =>
      running
        ? waitForNodeReloadEffect(store, io.stateRoot, predicate, io.nodeReloadTimeoutMs ?? 45_000)
        : Effect.succeed(false),
    ),
  );
}

function waitIfAgentRunningEffect(
  store: AgentConfigStore,
  io: CliIo,
): Effect.Effect<boolean, unknown> {
  return processLockActiveEffect(join(io.agentStateRoot, "agent.lock")).pipe(
    Effect.flatMap((running) =>
      running
        ? store
            .readEffect()
            .pipe(
              Effect.flatMap((config) =>
                waitForAgentReloadEffect(
                  store,
                  io.agentStateRoot,
                  config,
                  io.nodeReloadTimeoutMs ?? 45_000,
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
    ...defaultAgentPaths(),
    writeOut: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    readStdinEffect: () =>
      Effect.tryPromise({
        try: () => Bun.stdin.text(),
        catch: (error) => error,
      }),
    validateTailcatKeyEffect: (key) => validateTransportKeyEffect(key),
    verifyPeerEffect: (peer) => {
      const runtime = new PeerRuntime({
        peer,
        startConnectorEffect: (connector, signal) =>
          startConnectorEffect(connector, undefined, signal),
      });
      return Effect.acquireUseRelease(
        Effect.succeed(runtime),
        (active) => active.listWorkspacesEffect(AbortSignal.timeout(15_000)).pipe(Effect.asVoid),
        (active) => active.closeEffect(),
      );
    },
    agentDoctorEffect: () => runAgentDoctorEffect(defaultAgentPaths()),
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
