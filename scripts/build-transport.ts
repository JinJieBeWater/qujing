#!/usr/bin/env bun

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const transport = join(root, "apps", "cli", "native", "transport");
const output =
  process.env.COLLEAGUE_LINE_TRANSPORT_OUT ??
  join(
    transport,
    "bin",
    process.platform === "win32" ? "colleague-line-transport.exe" : "colleague-line-transport",
  );
await mkdir(join(transport, "bin"), { recursive: true });
const tags = (await readFile(join(transport, "build-tags.txt"), "utf8")).trim();
const child = Bun.spawn(["go", "build", "-tags", tags, "-ldflags", "-s -w", "-o", output, "."], {
  cwd: transport,
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, CGO_ENABLED: "0", GOTOOLCHAIN: "auto" },
});
process.exitCode = await child.exited;
if (process.exitCode === 0) console.log(output);
