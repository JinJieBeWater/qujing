import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import packageJson from "../package.json";
import { runCliEffect, type CliIo } from "../src/cli";

it.live("runs CLI through Effect entrypoint", () =>
  Effect.gen(function* () {
    let output = "";
    const io: CliIo = {
      configPath: "",
      stateRoot: "",
      clientConfigPath: "",
      clientStateRoot: "",
      writeOut: (text) => {
        output += text;
      },
      writeError: () => {},
      readStdinEffect: () => Effect.succeed(""),
      validateTailcatKeyEffect: () => Effect.void,
      verifyLineEffect: () => Effect.void,
      clientDoctorEffect: () => Effect.succeed({ ok: true, checks: [] }),
    };
    expect(yield* runCliEffect(["--help"], io)).toBe(0);
    expect(output).toContain("Usage: coll");
  }),
);

it.live("prints version", () =>
  Effect.gen(function* () {
    let output = "";
    const io: CliIo = {
      configPath: "",
      stateRoot: "",
      clientConfigPath: "",
      clientStateRoot: "",
      writeOut: (text) => {
        output += text;
      },
      writeError: () => {},
      readStdinEffect: () => Effect.succeed(""),
      validateTailcatKeyEffect: () => Effect.void,
      verifyLineEffect: () => Effect.void,
      clientDoctorEffect: () => Effect.succeed({ ok: true, checks: [] }),
    };
    expect(yield* runCliEffect(["--version"], io)).toBe(0);
    expect(output).toBe(`${packageJson.version}\n`);
  }),
);
