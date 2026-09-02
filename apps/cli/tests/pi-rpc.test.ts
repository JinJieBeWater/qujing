import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startManagedPiRpcSessionEffect } from "../src/runtime/pi-rpc";
import { PiRuntime } from "../src/runtime/pi-runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("global Pi RPC", () => {
  test("uses global Pi with Colleague Line context and strict LF JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-pi-rpc-"));
    roots.push(root);
    const binary = join(root, "pi");
    await writeFile(
      binary,
      `#!/usr/bin/env bun
const sessionId = process.argv[process.argv.indexOf("--session-id") + 1];
const systemPrompt = process.argv[process.argv.indexOf("--append-system-prompt") + 1];
if (!process.argv.includes("--mode") || !process.argv.includes("rpc") || !process.argv.includes("--approve")) process.exit(2);
const requiredPrompt = [
  "Colleague Line 是同事之间的私密咨询通道",
  "回答前先按需取证",
  "当前代码",
  "可用 Skills",
  "Agent 历史",
  "全程只读",
  "不执行更改",
];
const forbidden = ["--model", "--provider", "--settings", "--tools", "--no-extensions", "--extension", "--extensions", "--skill", "--skills", "--session-dir"];
if (!requiredPrompt.every((part) => systemPrompt.includes(part)) || forbidden.some((flag) => process.argv.includes(flag))) process.exit(3);
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
    const session = await Effect.runPromise(
      startManagedPiRpcSessionEffect({ cwd: root, sessionId, binary }),
    );

    await Effect.runPromise(session.promptEffect("hello"));

    expect(session.getLastAssistantText()).toBe(
      `full\u2028Pi:true:first::draft:${await realpath(root)}`,
    );
    await Effect.runPromise(session.disposeEffect());
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
      Effect.runPromise(
        startManagedPiRpcSessionEffect({
          cwd: root,
          sessionId: "00000000-0000-4000-8000-000000000124",
          binary,
          startupTimeoutMs: 3_000,
        }),
      ),
    ).rejects.toThrow("startup timed out");
    const pid = Number(await Bun.file(pidFile).text());
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("waits for agent_settled after abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-pi-settle-"));
    roots.push(root);
    const binary = join(root, "pi");
    const promptMarker = join(root, "prompted");
    await writeFile(
      binary,
      `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const sessionId = process.argv[process.argv.indexOf("--session-id") + 1];
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.type === "get_state") {
      console.log(JSON.stringify({ type: "response", id: message.id, success: true, data: { sessionId } }));
    } else if (message.type === "prompt") {
      await appendFile(${JSON.stringify(promptMarker)}, "prompt\\n");
      console.log(JSON.stringify({ type: "response", id: message.id, success: true }));
    } else if (message.type === "clear_queue") {
      console.log(JSON.stringify({ type: "response", id: message.id, success: true }));
    } else if (message.type === "abort") {
      console.log(JSON.stringify({ type: "response", id: message.id, success: true }));
      setTimeout(() => console.log(JSON.stringify({ type: "agent_settled" })), 100);
    }
  }
}
`,
    );
    await chmod(binary, 0o700);
    const sessionId = "00000000-0000-4000-8000-000000000125";
    const runtime = new PiRuntime({
      createSessionEffect: (_workspace, session) =>
        startManagedPiRpcSessionEffect({ cwd: root, sessionId: session.id, binary }),
      abortTimeoutMs: 1_000,
      fatal: () => {},
    });
    const controller = new AbortController();
    const pending = Effect.runPromise(
      runtime.answerEffect({
        workspace: { id: "docs", name: "Docs", summary: "Docs", root },
        session: {
          id: sessionId,
          clientId: "client",
          workspaceId: "docs",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        question: "wait",
        signal: controller.signal,
      }),
    );
    while (!(await readFile(promptMarker, "utf8").catch(() => ""))) await Bun.sleep(1);
    const started = performance.now();

    controller.abort(new DOMException("Aborted", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(75);
    await Effect.runPromise(runtime.disposeEffect());
  });

  test("rejects CRLF from global Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-pi-crlf-"));
    roots.push(root);
    const binary = join(root, "pi");
    await writeFile(
      binary,
      `#!/usr/bin/env bun
const sessionId = process.argv[process.argv.indexOf("--session-id") + 1];
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.type === "get_state")
      process.stdout.write(JSON.stringify({ type: "response", id: message.id, success: true, data: { sessionId } }) + "\\r\\n");
  }
}
`,
    );
    await chmod(binary, 0o700);

    await expect(
      Effect.runPromise(
        startManagedPiRpcSessionEffect({
          cwd: root,
          sessionId: "00000000-0000-4000-8000-000000000126",
          binary,
          startupTimeoutMs: 1_000,
        }),
      ),
    ).rejects.toThrow("non-LF JSONL");
  });
});
