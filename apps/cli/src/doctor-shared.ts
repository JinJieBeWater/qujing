import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { Effect } from "effect";
import { processLockActiveEffect } from "./process-lock";
import { requireTransportBinaryEffect, transportBinaryPath } from "./transport/process";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export function transportCheckEffect(
  binaryPath?: string,
  unavailable = "Tailcat transport binary is unavailable",
): Effect.Effect<DoctorCheck> {
  return requireTransportBinaryEffect(binaryPath ?? transportBinaryPath()).pipe(
    Effect.flatMap((binary) => promiseEffect(() => access(binary, constants.X_OK))),
    Effect.as(doctorCheck("transport", "ok", "Tailcat transport binary is executable")),
    Effect.catchEager((error) =>
      Effect.succeed(doctorCheck("transport", "error", doctorMessage(error, unavailable))),
    ),
  );
}

export function portCheckEffect(
  lockPath: string,
  label: "Node" | "Agent",
  server: { host: string; port: number },
  probe = checkPortEffect,
) {
  return processLockActiveEffect(lockPath).pipe(
    Effect.flatMap((running) =>
      (running ? Effect.succeed(true) : probe(server.host, server.port)).pipe(
        Effect.map((available) =>
          doctorCheck(
            "port",
            available ? "ok" : "error",
            running
              ? `${label} is running`
              : available
                ? `${label} port is available`
                : `${label} port is already in use`,
          ),
        ),
      ),
    ),
    Effect.catchEager(() =>
      Effect.succeed(doctorCheck("port", "error", `${label} port is already in use`)),
    ),
  );
}

export function checkPortEffect(host: string, port: number) {
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => createServer()),
        (resource) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) =>
                resource.listening ? resource.close(() => resolve()) : resolve(),
              ),
          ),
      );
      return yield* promiseEffect(
        () =>
          new Promise<boolean>((resolve) => {
            server.once("error", () => resolve(false));
            server.listen(port, host, () => resolve(true));
          }),
      );
    }),
  );
}

export function promiseEffect<A>(try_: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: try_, catch: (error) => error });
}

export function doctorCheck(
  name: string,
  status: DoctorCheck["status"],
  message: string,
): DoctorCheck {
  return { name, status, message };
}

export function doctorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
