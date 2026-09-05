import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { Effect } from "effect";
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
