import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Duration, Effect, Layer, Path, Schedule } from "effect";

export const PlatformLayer = Layer.mergeAll(BunFileSystem.layer, Path.layer);

/** One poll tick. Clock/Schedule keep timing policy out of filesystem services. */
export const pollEvery = (milliseconds: number) => Schedule.spaced(Duration.millis(milliseconds));

export const sleep = (milliseconds: number) => Effect.sleep(Duration.millis(milliseconds));
