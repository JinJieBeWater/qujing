#!/usr/bin/env bun

import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import packageJson from "../apps/cli/package.json";

const root = join(import.meta.dir, "..");
const appRoot = join(root, "apps", "cli");
const nativeRoot = join(appRoot, "native");
const destination = join(root, "dist");
const targets = {
  "darwin-arm64": {
    bun: "bun-darwin-arm64",
    goos: "darwin",
    goarch: "arm64",
    extension: "",
    preview: false,
  },
  "linux-x64": {
    bun: "bun-linux-x64",
    goos: "linux",
    goarch: "amd64",
    extension: "",
    preview: false,
  },
  "windows-x64": {
    bun: "bun-windows-x64",
    goos: "windows",
    goarch: "amd64",
    extension: ".exe",
    preview: true,
  },
} as const;
const requested = process.argv.slice(2);
const selected =
  requested.length === 0 || requested.includes("all") ? Object.keys(targets) : requested;
for (const name of selected) {
  if (!(name in targets)) throw new Error(`Unknown release target: ${name}`);
}
const required = ["bun", "go"];
if (selected.some((name) => name !== "windows-x64")) required.push("tar");
if (selected.includes("windows-x64")) required.push("zip");
const missing = required.filter((name) => !Bun.which(name));
if (missing.length)
  throw new Error(`Missing release tools: ${missing.join(", ")}. Install them and retry.`);
await mkdir(destination, { recursive: true });
const tags = (await readFile(join(nativeRoot, "transport", "build-tags.txt"), "utf8")).trim();
const archives: string[] = [];

for (const name of selected) {
  const target = targets[name as keyof typeof targets];
  const directory = join(destination, `qujing-${packageJson.version}-${name}`);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const app = join(directory, `qj${target.extension}`);
  const transport = join(directory, `qujing-transport${target.extension}`);
  await command([
    "bun",
    "build",
    "--compile",
    "--minify",
    `--target=${target.bun}`,
    join(appRoot, "src", "cli.ts"),
    "--outfile",
    app,
  ]);
  await command(
    ["go", "build", "-tags", tags, "-ldflags", "-s -w", "-o", transport, "."],
    join(nativeRoot, "transport"),
    {
      CGO_ENABLED: "0",
      GOOS: target.goos,
      GOARCH: target.goarch,
      GOTOOLCHAIN: "auto",
    },
  );
  if (name !== "windows-x64") await Promise.all([chmod(app, 0o755), chmod(transport, 0o755)]);
  await Promise.all([
    cp(join(root, "README.md"), join(directory, "README.md")),
    cp(join(root, "README.zh-CN.md"), join(directory, "README.zh-CN.md")),
    cp(join(root, "THIRD_PARTY_NOTICES.md"), join(directory, "THIRD_PARTY_NOTICES.md")),
    cp(join(root, "skills", "qujing-setup"), join(directory, "skills", "qujing-setup"), {
      recursive: true,
    }),
    writeFile(
      join(directory, "BUILD.json"),
      `${JSON.stringify(
        {
          name: "qujing",
          version: packageJson.version,
          target: name,
          preview: target.preview,
          support: target.preview ? "preview" : "supported",
          nativeAcceptance: target.preview ? "pending" : "passed",
          tailcatCommit: "4d50a34f315d593d03c31f12a20ba8d163cbf321",
        },
        null,
        2,
      )}\n`,
    ),
  ]);
  const archive = `qujing-v${packageJson.version}-${name}${
    name === "windows-x64" ? ".zip" : ".tar.gz"
  }`;
  await rm(join(destination, archive), { force: true });
  if (name === "windows-x64") {
    await command(["zip", "-qr", join(destination, archive), basename(directory)], destination);
  } else {
    await command([
      "tar",
      "-czf",
      join(destination, archive),
      "-C",
      destination,
      basename(directory),
    ]);
  }
  archives.push(archive);
  console.log(directory);
}

await writeFile(
  join(destination, "SHA256SUMS"),
  `${(
    await Promise.all(
      archives.map(async (archive) => `${await sha256(join(destination, archive))}  ${archive}`),
    )
  ).join("\n")}\n`,
);

async function command(
  command: string[],
  cwd = root,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, ...extraEnv },
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command[0]} exited ${code}`);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
