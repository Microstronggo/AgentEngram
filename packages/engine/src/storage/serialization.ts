import { createHash } from "node:crypto";

/** JSON scalar accepted by durable Engine formats. */
export type JsonPrimitive = string | number | boolean | null;
/** Recursive JSON value used instead of unconstrained runtime objects. */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Serializes JSON with recursively sorted object keys for stable hashing. */
export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

/** Returns a lowercase SHA-256 digest for stable JSON or literal text. */
export function sha256(value: JsonValue | string): string {
  const serialized = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(serialized).digest("hex");
}
