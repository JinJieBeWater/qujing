import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPiRpcSession } from "../src/runtime/pi-rpc";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("global Pi RPC", () => {
  test("uses global Pi session id, strict LF JSONL, and full extension UI", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-pi-rpc-"));
    roots.push(root);
    const binary = join(root, "pi");
    await writeFile(
      binary,
      `#!/usr/bin/env bun
const sessionId = process.argv[process.argv.indexOf("--session-id") + 1];
if (!process.argv.includes("--mode") || !process.argv.includes("rpc") || !process.argv.includes("--approve")) process.exit(2);
let buffer = "";
let promptId;
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.type === "get_state") {
      console.log(JSON.stringify({ type: "response", id: message.id, command: message.type, success: true, data: { sessionId } }));
    } else if (message.type === "prompt") {
      promptId = message.id;
      console.log(JSON.stringify({ type: "extension_ui_request", id: "permission", method: "confirm", title: "Allow?", message: "full Pi" }));
      console.log(JSON.stringify({ type: "response", id: promptId, command: message.type, success: true }));
    } else if (message.type === "extension_ui_response" && message.id === "permission") {
      globalThis.confirmed = message.confirmed;
      console.log(JSON.stringify({ type: "extension_ui_request", id: "choice", method: "select", title: "Choose", options: ["first", "second"] }));
    } else if (message.type === "extension_ui_response" && message.id === "choice") {
      globalThis.choice = message.value;
      console.log(JSON.stringify({ type: "extension_ui_request", id: "input", method: "input", title: "Input" }));
    } else if (message.type === "extension_ui_response" && message.id === "input") {
      globalThis.input = message.value;
      console.log(JSON.stringify({ type: "extension_ui_request", id: "editor", method: "editor", title: "Editor", prefill: "draft" }));
    } else if (message.type === "extension_ui_response" && message.id === "editor") {
      const text = [globalThis.confirmed, globalThis.choice, globalThis.input, message.value, process.cwd()].join(":");
      console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "full\\u2028Pi:" + text }] } }));
      console.log(JSON.stringify({ type: "agent_settled" }));
    }
  }
}
`,
    );
    await chmod(binary, 0o700);
    const sessionId = "00000000-0000-4000-8000-000000000123";
    const session = await startPiRpcSession({ cwd: root, sessionId, binary });

    await session.prompt("hello");

    expect(session.getLastAssistantText()).toBe(
      `full\u2028Pi:true:first::draft:${await realpath(root)}`,
    );
    await session.dispose();
  });

  test("kills a silent Pi after the startup deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-pi-timeout-"));
    roots.push(root);
    const binary = join(root, "pi");
    const pidFile = join(root, "pid");
    await writeFile(
      binary,
      `#!/bin/sh
printf '%s' $$ > "${pidFile}"
while IFS= read -r line; do :; done
`,
    );
    await chmod(binary, 0o700);

    await expect(
      startPiRpcSession({
        cwd: root,
        sessionId: "00000000-0000-4000-8000-000000000124",
        binary,
        startupTimeoutMs: 3_000,
      }),
    ).rejects.toThrow("startup timed out");
    const pid = Number(await Bun.file(pidFile).text());
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
