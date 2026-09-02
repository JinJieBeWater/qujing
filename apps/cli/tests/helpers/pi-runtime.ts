import type { PiRuntimeOptions } from "../../src/runtime/pi-runtime";
import { PiRuntime } from "../../src/runtime/pi-runtime";

export function makePiRuntime(options: PiRuntimeOptions): PiRuntime {
  return new PiRuntime(options);
}
