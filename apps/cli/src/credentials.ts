import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createBearer(): string {
  return randomBytes(32).toString("base64url");
}

export function hashBearer(bearer: string): string {
  return createHash("sha256").update(bearer).digest("hex");
}

export function sameBearerHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
