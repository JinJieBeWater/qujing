import type { RuntimePoolOptions } from "../../src/runtime/runtime-pool";
import { RuntimePool } from "../../src/runtime/runtime-pool";

export function makeRuntimePool(options: RuntimePoolOptions): RuntimePool {
  return new RuntimePool(options);
}
