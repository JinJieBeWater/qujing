import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { JsonStore } from "../src/runtime/tanstack-persistence";

test("JSON listing bounds reads while preserving order, filtering and errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "qujing-json-list-"));
  const store = new JsonStore<number>(root);
  const get = store.getEffect.bind(store);
  let active = 0;
  let peak = 0;
  const reads = spyOn(store, "getEffect").mockImplementation((id) =>
    Effect.gen(function* () {
      active++;
      peak = Math.max(peak, active);
      return yield* Effect.sleep("1 millis").pipe(
        Effect.andThen(get(id)),
        Effect.ensuring(
          Effect.sync(() => {
            active--;
          }),
        ),
      );
    }),
  );
  try {
    expect(await Effect.runPromise(store.listEffect())).toEqual([]);
    await Promise.all(
      Array.from({ length: 40 }, (_, id) => writeFile(join(root, `${id}.json`), String(id))),
    );
    await writeFile(join(root, "ignored.txt"), "not JSON");
    const expected = (await readdir(root))
      .filter((name) => name.endsWith(".json"))
      .map((name) => Number(name.slice(0, -5)));
    expect(await Effect.runPromise(store.listEffect())).toEqual(expected);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
    expect(active).toBe(0);
    await writeFile(join(root, "broken.json"), "not JSON");
    await expect(Effect.runPromise(store.listEffect())).rejects.toThrow();
  } finally {
    reads.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
