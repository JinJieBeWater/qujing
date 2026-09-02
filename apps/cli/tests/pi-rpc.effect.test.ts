import { expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPiRpcSessionEffect } from "../src/runtime/pi-rpc";

const waitForFile = (path: string): Effect.Effect<void, unknown, never> =>
  Effect.tryPromise({
    try: () =>
      access(path).then(
        () => true,
        () => false,
      ),
    catch: (error) => error,
  }).pipe(
    Effect.flatMap((exists) =>
      exists
        ? Effect.void
        : Effect.sleep(Duration.millis(5)).pipe(Effect.andThen(waitForFile(path))),
    ),
  );

it.live("releases Pi when scoped Effect completes", () =>
  Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "colleague-line-pi-effect-")),
      catch: (error) => error,
    });
    const binary = join(root, "pi");
    const stopped = join(root, "stopped");
    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          binary,
          `#!/usr/bin/env bun
const sessionId = process.argv[process.argv.indexOf("--session-id") + 1];
process.on("SIGTERM", () => { Bun.write("${stopped}", "stopped").then(() => process.exit()); });
for await (const chunk of Bun.stdin.stream()) for (const line of new TextDecoder().decode(chunk).split("\\n")) if (line) {
  const message = JSON.parse(line);
  if (message.type === "get_state") console.log(JSON.stringify({ type: "response", id: message.id, success: true, data: { sessionId } }));
}
`,
        ),
      catch: (error) => error,
    });
    yield* Effect.tryPromise({ try: () => chmod(binary, 0o700), catch: (error) => error });
    yield* Effect.scoped(
      startPiRpcSessionEffect({ cwd: root, sessionId: "effect-session", binary }),
    );
    yield* Effect.tryPromise({
      try: async () => {
        for (let i = 0; i < 20; i++) {
          if (
            await access(stopped).then(
              () => true,
              () => false,
            )
          )
            return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("Pi scoped finalizer did not stop child");
      },
      catch: (error) => error,
    });
    expect(
      yield* Effect.tryPromise({ try: () => readFile(stopped, "utf8"), catch: (error) => error }),
    ).toBe("stopped");
    yield* Effect.tryPromise({
      try: () => rm(root, { recursive: true, force: true }),
      catch: (error) => error,
    });
  }),
);

it.live("serializes stdout chunks while UI response write blocks", () =>
  Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "colleague-line-pi-stdout-order-")),
      catch: (error) => error,
    });
    const binary = join(root, "pi");
    const emitted = join(root, "settled-emitted");
    const release = join(root, "release-stdin");
    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          binary,
          `#!/usr/bin/env bun
const sessionId = process.argv[process.argv.indexOf("--session-id") + 1];
let input = "";
process.stdin.on("data", (chunk) => {
  input += new TextDecoder().decode(chunk);
  for (const line of input.split("\\n")) {
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "get_state") console.log(JSON.stringify({ type: "response", id: message.id, success: true, data: { sessionId } }));
    if (message.type === "prompt") {
      console.log(JSON.stringify({ type: "response", id: message.id, success: true }));
      setTimeout(async () => {
        process.stdin.pause();
        process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "blocked", method: "editor", prefill: "x".repeat(10_000_000) }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        await Bun.write("${emitted}", "yes");
        const timer = setInterval(async () => {
          if (await Bun.file("${release}").exists()) {
            clearInterval(timer);
            process.stdin.resume();
          }
        }, 5);
      }, 0);
    }
  }
  input = input.slice(input.lastIndexOf("\\n") + 1);
});
`,
        ),
      catch: (error) => error,
    });
    yield* Effect.tryPromise({ try: () => chmod(binary, 0o700), catch: (error) => error });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* startPiRpcSessionEffect({ cwd: root, sessionId: "ordered", binary });
        let settled = false;
        const prompt = yield* session.promptEffect("question").pipe(
          Effect.ensuring(
            Effect.sync(() => {
              settled = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* waitForFile(emitted);
        expect(settled).toBe(false);
        yield* Effect.tryPromise({ try: () => writeFile(release, "go"), catch: (error) => error });
        yield* Fiber.join(prompt);
      }),
    );
    yield* Effect.tryPromise({
      try: () => rm(root, { recursive: true, force: true }),
      catch: (error) => error,
    });
  }),
);
