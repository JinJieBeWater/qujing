import type { Effect } from "effect";

export interface RuntimeNodeSession {
  getLastAssistantText(): string | undefined;
  isAlive(): boolean;
  promptEffect(question: string): Effect.Effect<void, Error>;
  clearQueueEffect(): Effect.Effect<void, Error>;
  abortEffect(): Effect.Effect<void, Error>;
  waitForIdleEffect(): Effect.Effect<void, Error>;
  disposeEffect(): Effect.Effect<void>;
}
