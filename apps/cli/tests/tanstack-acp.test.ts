import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryLockStore } from "@tanstack/ai/locks";
import { Effect } from "effect";
import { startManagedTanStackAcpSessionEffect, renderCommand } from "../src/runtime/tanstack-acp";
import {
  createTanStackInstanceStore,
  createTanStackPersistence,
} from "../src/runtime/tanstack-persistence";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TanStack ACP Runtime", () => {
  test("quotes command placeholders", () => {
    expect(
      renderCommand("agent --model {model} --cwd {cwd}", { model: "m'1", cwd: "/tmp/a b" }),
    ).toBe("agent --model 'm'\\''1' --cwd '/tmp/a b'");
  });

  test("runs ACP harness through TanStack persistence and resumes ACP session", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-tanstack-acp-"));
    roots.push(root);
    const binary = join(root, "fake-acp");
    const log = join(root, "acp.log");
    await writeFile(
      binary,
      `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const log = process.env.LOG;
const argCwd = process.argv[process.argv.indexOf("--cwd") + 1];
const model = process.argv[process.argv.indexOf("--model") + 1];
let buffer = "";
function send(value) { console.log(JSON.stringify(value)); }
async function record(value) { await appendFile(log, JSON.stringify(value) + "\\n"); }
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    await record({ method: message.method, params: message.params, argv: process.argv.slice(2), cwd: process.cwd() });
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "acp-session-1" } });
    } else if (message.method === "session/load") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    } else if (message.method === "session/prompt") {
      const text = message.params.prompt.map((part) => part.text ?? "").join("");
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ["answer", model, process.cwd(), argCwd, text.includes("取经"), text.includes("second")].join(":") } } } });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
  }
}
`,
    );
    await chmod(binary, 0o700);
    const persistence = createTanStackPersistence({ stateRoot: root });
    const session = await Effect.runPromise(
      startManagedTanStackAcpSessionEffect({
        cwd: root,
        stateRoot: root,
        sessionId: "00000000-0000-4000-8000-000000000001",
        runtime: {
          kind: "tanstack-acp",
          name: "fake",
          model: "model-one",
          command: `LOG=${log} ${binary} --model {model} --cwd {cwd}`,
        },
        persistence,
        instances: createTanStackInstanceStore({ stateRoot: root }),
        locks: new InMemoryLockStore(),
      }),
    );

    await Effect.runPromise(session.promptEffect("first"));
    expect(session.getLastAssistantText()).toContain(`answer:model-one:${root}:${root}:true:false`);
    await Effect.runPromise(session.promptEffect("second"));
    expect(session.getLastAssistantText()).toContain(`answer:model-one:${root}:${root}:true:true`);

    const records = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      records.some(
        (record) => record.method === "session/load" && record.params.sessionId === "acp-session-1",
      ),
    ).toBe(true);
    const messages = await persistence.stores.messages.loadThread(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });
});
