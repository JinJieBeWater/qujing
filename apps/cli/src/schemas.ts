import { isAbsolute } from "node:path";
import { DateTime, Option, Schema } from "effect";

const isoDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const NonEmptyString = Schema.NonEmptyString;
export const BoundedString = Schema.String.check(Schema.isLengthBetween(1, 4_096));
export const Identifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
);
export const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
export const Uuid = Schema.String.check(Schema.isUUID());
export const Timestamp = Schema.String.check(
  Schema.makeFilter((value) =>
    isoDateTimePattern.test(value) && Option.isSome(DateTime.make(value))
      ? undefined
      : "Expected an ISO date-time",
  ),
);
export const AbsolutePath = Schema.String.check(
  Schema.makeFilter((value) => (isAbsolute(value) ? undefined : "Expected an absolute path")),
);

export const Server = Schema.Struct({
  host: Schema.Literal("127.0.0.1"),
  port: Port,
});

const NodeFields = {
  id: Identifier,
  name: NonEmptyString,
  summary: Schema.optionalKey(NonEmptyString),
};
export const Node = Schema.Struct(NodeFields);

export const Workspace = Schema.Struct({
  id: Identifier,
  name: NonEmptyString,
  summary: NonEmptyString,
  root: AbsolutePath,
});

export const PeerCredential = Schema.Struct({
  id: Identifier,
  tailcatKey: NonEmptyString,
  bearerHash: Hash,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const TANSTACK_ACP_AUTH_MODES = ["host", "api-key"] as const;
export const TANSTACK_ACP_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
] as const;
export const PI_MODEL_PATTERN = /^[^/]+\/.+$/;
export const PiModel = Schema.String.check(Schema.isPattern(PI_MODEL_PATTERN));

export const TanStackAcpRuntime = Schema.Struct({
  kind: Schema.Literal("tanstack-acp"),
  name: Identifier,
  model: NonEmptyString,
  command: NonEmptyString,
  authMode: Schema.optionalKey(Schema.Literals(TANSTACK_ACP_AUTH_MODES)),
  authMethodId: Schema.optionalKey(NonEmptyString),
  permissionMode: Schema.optionalKey(Schema.Literals(TANSTACK_ACP_PERMISSION_MODES)),
});

export const PiRpcRuntime = Schema.Struct({
  kind: Schema.Literal("pi-rpc"),
  model: PiModel,
  binary: Schema.optionalKey(NonEmptyString),
});

export const RuntimeConfig = Schema.Union([TanStackAcpRuntime, PiRpcRuntime]);

export const HostConfig = Schema.Struct({
  version: Schema.Literal(1),
  node: Node,
  server: Server,
  runtime: Schema.optionalKey(RuntimeConfig),
  workspaces: Schema.Array(Workspace),
  peers: Schema.Array(PeerCredential),
});

export const Tombstones = Schema.Struct({
  workspaces: Schema.Array(Identifier),
  peers: Schema.Array(Identifier),
});

const PeerFields = {
  id: Identifier,
  expectedNodeId: Identifier,
  remoteAgentId: Identifier,
  serverAddress: BoundedString,
  remotePort: Port,
  keyPath: AbsolutePath.check(Schema.isMaxLength(4_096)),
  remoteBearer: BoundedString,
};

export const PeerInput = Schema.Struct(PeerFields);

export const Peer = Schema.Struct({
  ...PeerFields,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const PeerCredentials = Schema.Struct({
  keyPath: AbsolutePath.check(Schema.isMaxLength(4_096)),
  remoteBearer: BoundedString,
});

export const PeerInvite = Schema.Struct({
  version: Schema.Literal(1),
  nodeId: Identifier,
  remoteAgentId: Identifier,
  serverAddress: BoundedString,
  remotePort: Port,
  remoteBearer: BoundedString,
});

export const AgentConfig = Schema.Struct({
  version: Schema.Literal(1),
  server: Server,
  localBearerHash: Hash,
  peers: Schema.Array(Peer).check(Schema.isMaxLength(64)),
});

export const RuntimeSession = Schema.Struct({
  id: Uuid,
  peerId: NonEmptyString,
  workspaceId: NonEmptyString,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const ReloadState = Schema.Struct({
  configFingerprint: Hash,
  updatedAt: Timestamp,
});

export const PeerRetirement = Schema.Struct({
  version: Schema.Literal(1),
  id: Uuid,
  peerId: NonEmptyString,
  peerFingerprint: Hash,
  configFingerprint: Hash,
  requesterPid: PositiveInt,
  createdAt: Timestamp,
  cancelled: Schema.optionalKey(Schema.Boolean),
});

export const PeerRetirementAcknowledgement = Schema.Struct({
  requestId: Uuid,
  updatedAt: Timestamp,
});

export const TailcatState = Schema.Struct({
  serverAddress: NonEmptyString,
  remotePort: Port,
});

export const LockOwner = Schema.Struct({
  pid: PositiveInt,
  nonce: BoundedString,
});

export const TransportReady = Schema.Struct({
  ready: Schema.Literal(true),
  serverAddress: Schema.optionalKey(BoundedString),
  remotePort: Schema.optionalKey(Port),
  localAddress: Schema.optionalKey(BoundedString),
  publicKey: Schema.optionalKey(BoundedString),
  keyPath: Schema.optionalKey(AbsolutePath.check(Schema.isMaxLength(4_096))),
});

export const PublicWorkspace = Schema.Struct({
  id: Identifier,
  name: NonEmptyString,
  summary: NonEmptyString,
  available: Schema.Boolean,
});

export const PeerWorkspaces = Schema.Struct({
  node: Node,
  workspaces: Schema.Array(PublicWorkspace),
});

export const PeerAskResult = Schema.Struct({
  workspace: Identifier,
  answer: Schema.String,
});

export const PeerCredentialIdentity = Schema.Struct({
  id: Identifier,
  credentialVersion: Schema.String,
});

export const AskRequest = Schema.Struct({
  peer: PeerCredentialIdentity,
  workspace: Schema.String,
  question: Schema.String,
});

export const AgentPeer = Schema.Struct({
  id: Identifier,
  available: Schema.Boolean,
  node: Schema.optionalKey(Node),
  workspaces: Schema.Array(PublicWorkspace),
});

export const AgentPeersResult = Schema.Struct({
  peers: Schema.Array(AgentPeer),
});

export const AgentAskResult = Schema.Struct({
  peer: Identifier,
  ...PeerAskResult.fields,
});

export const ErrorCodePayload = Schema.Struct({ code: Schema.String });

export const Question = Schema.String.check(
  Schema.isMaxLength(20_000),
  Schema.makeFilter((value) => (value.trim().length > 0 ? undefined : "Question is empty")),
);

export type HostConfig = typeof HostConfig.Type;
export type RuntimeConfig = typeof RuntimeConfig.Type;
export type TanStackAcpRuntime = typeof TanStackAcpRuntime.Type;
export type PiRpcRuntime = typeof PiRpcRuntime.Type;
export type Workspace = typeof Workspace.Type;
export type Tombstones = typeof Tombstones.Type;
export type AgentConfig = typeof AgentConfig.Type;
export type Peer = typeof Peer.Type;
export type PeerInput = typeof PeerInput.Type;
export type PeerCredentials = typeof PeerCredentials.Type;
export type PeerInvite = typeof PeerInvite.Type;
export type RuntimeSession = typeof RuntimeSession.Type;
export type ReloadState = typeof ReloadState.Type;
export type PeerRetirement = typeof PeerRetirement.Type;
export type TailcatState = typeof TailcatState.Type;
export type LockOwner = typeof LockOwner.Type;
export type TransportReady = typeof TransportReady.Type;
export type Node = typeof Node.Type;
export type PublicWorkspace = typeof PublicWorkspace.Type;
export type PeerWorkspaces = typeof PeerWorkspaces.Type;
export type PeerAskResult = typeof PeerAskResult.Type;
export type PeerCredentialIdentity = typeof PeerCredentialIdentity.Type;
export type AskRequest = typeof AskRequest.Type;
export type AgentPeer = typeof AgentPeer.Type;
export type AgentPeersResult = typeof AgentPeersResult.Type;
export type AgentAskResult = typeof AgentAskResult.Type;

export const decode = Schema.decodeUnknownSync;
