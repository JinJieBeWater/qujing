import { expect, test } from "bun:test";
import { publishClientLineRetirement } from "../src/client-control";

test("removes stale acknowledgement before publishing a retirement request", async () => {
  const events: string[] = [];
  let finishRemoval!: () => void;
  const removal = new Promise<void>((resolve) => {
    finishRemoval = resolve;
  });
  const pending = publishClientLineRetirement(
    async () => {
      events.push("remove:start");
      await removal;
      events.push("remove:end");
    },
    async () => {
      events.push("write");
    },
  );

  await Bun.sleep(0);
  expect(events).toEqual(["remove:start"]);
  finishRemoval();
  await pending;
  expect(events).toEqual(["remove:start", "remove:end", "write"]);
});
