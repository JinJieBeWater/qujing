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

export const Owner = Schema.Struct({
  id: Identifier,
  name: NonEmptyString,
  summary: Schema.optionalKey(NonEmptyString),
});

export const Workspace = Schema.Struct({
  id: Identifier,
  name: NonEmptyString,
  summary: NonEmptyString,
  root: AbsolutePath,
});

export const GatewayClient = Schema.Struct({
  id: Identifier,
  tailcatKey: NonEmptyString,
  bearerHash: Hash,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const GatewayConfig = Schema.Struct({
  version: Schema.Literal(1),
  owner: Owner,
  server: Server,
  workspaces: Schema.Array(Workspace),
  clients: Schema.Array(GatewayClient),
});

export const Tombstones = Schema.Struct({
  workspaces: Schema.Array(Identifier),
  clients: Schema.Array(Identifier),
});

export const Line = Schema.Struct({
  id: Identifier,
  expectedOwnerId: Identifier,
  remoteClientId: Identifier,
  serverAddress: BoundedString,
  remotePort: Port,
  keyPath: AbsolutePath.check(Schema.isMaxLength(4_096)),
  remoteBearer: BoundedString,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const LineInput = Schema.Struct({
  id: Identifier,
  expectedOwnerId: Identifier,
  remoteClientId: Identifier,
  serverAddress: BoundedString,
  remotePort: Port,
  keyPath: AbsolutePath.check(Schema.isMaxLength(4_096)),
  remoteBearer: BoundedString,
});

export const LineCredentials = Schema.Struct({
  keyPath: AbsolutePath.check(Schema.isMaxLength(4_096)),
  remoteBearer: BoundedString,
});

export const LinePairing = Schema.Struct({
  version: Schema.Literal(1),
  ownerId: Identifier,
  remoteClientId: Identifier,
  serverAddress: BoundedString,
  remotePort: Port,
  remoteBearer: BoundedString,
});

export const ClientConfig = Schema.Struct({
  version: Schema.Literal(1),
  server: Server,
  localBearerHash: Hash,
  lines: Schema.Array(Line).check(Schema.isMaxLength(64)),
});

export const RuntimeSession = Schema.Struct({
  id: Uuid,
  clientId: NonEmptyString,
  workspaceId: NonEmptyString,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const ReloadState = Schema.Struct({
  configFingerprint: Hash,
  updatedAt: Timestamp,
});

export const ClientLineRetirement = Schema.Struct({
  version: Schema.Literal(1),
  id: Uuid,
  lineId: NonEmptyString,
  lineFingerprint: Hash,
  configFingerprint: Hash,
  requesterPid: PositiveInt,
  createdAt: Timestamp,
  cancelled: Schema.optionalKey(Schema.Boolean),
});

export const ClientLineRetirementAcknowledgement = Schema.Struct({
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

export const LineWorkspaces = Schema.Struct({
  owner: Owner,
  workspaces: Schema.Array(PublicWorkspace),
});

export const LineAskResult = Schema.Struct({
  workspace: Identifier,
  answer: Schema.String,
});

export const ClientIdentity = Schema.Struct({
  id: Identifier,
  credentialVersion: Schema.String,
});

export const AskRequest = Schema.Struct({
  client: ClientIdentity,
  workspace: Schema.String,
  question: Schema.String,
});

export const ClientLine = Schema.Struct({
  id: Identifier,
  available: Schema.Boolean,
  owner: Schema.optionalKey(Owner),
  workspaces: Schema.Array(PublicWorkspace),
});

export const ClientLinesResult = Schema.Struct({
  lines: Schema.Array(ClientLine),
});

export const ClientAskResult = Schema.Struct({
  line: Identifier,
  ...LineAskResult.fields,
});

export const ErrorCodePayload = Schema.Struct({ code: Schema.String });

export const Question = Schema.String.check(
  Schema.isMaxLength(20_000),
  Schema.makeFilter((value) => (value.trim().length > 0 ? undefined : "Question is empty")),
);

export type GatewayConfig = typeof GatewayConfig.Type;
export type Workspace = typeof Workspace.Type;
export type Tombstones = typeof Tombstones.Type;
export type ClientConfig = typeof ClientConfig.Type;
export type Line = typeof Line.Type;
export type LineInput = typeof LineInput.Type;
export type LineCredentials = typeof LineCredentials.Type;
export type LinePairing = typeof LinePairing.Type;
export type RuntimeSession = typeof RuntimeSession.Type;
export type ReloadState = typeof ReloadState.Type;
export type ClientLineRetirement = typeof ClientLineRetirement.Type;
export type TailcatState = typeof TailcatState.Type;
export type LockOwner = typeof LockOwner.Type;
export type TransportReady = typeof TransportReady.Type;
export type Owner = typeof Owner.Type;
export type PublicWorkspace = typeof PublicWorkspace.Type;
export type LineWorkspaces = typeof LineWorkspaces.Type;
export type LineAskResult = typeof LineAskResult.Type;
export type ClientIdentity = typeof ClientIdentity.Type;
export type AskRequest = typeof AskRequest.Type;
export type ClientLine = typeof ClientLine.Type;
export type ClientLinesResult = typeof ClientLinesResult.Type;
export type ClientAskResult = typeof ClientAskResult.Type;

export const decode = Schema.decodeUnknownSync;
