import type { MemoryCandidate, MemoryContentScanner } from "./long-term/index.js";

/** One secret or prompt-injection signal found in candidate memory text. */
export interface MemorySafetyFinding {
  readonly kind: "secret" | "prompt-injection";
  readonly label: string;
}

const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["generic-secret", /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{12,}/i],
];

const INJECTION_PATTERNS: readonly [string, RegExp][] = [
  ["ignore-instructions", /ignore (?:all |the )?(?:previous|prior|system) instructions/i],
  ["authority-escalation", /(?:you are now|act as) (?:the )?(?:system|developer|administrator)/i],
  ["hidden-prompt", /(?:reveal|print|exfiltrate).{0,40}(?:system prompt|credentials|secrets)/i],
];

/** Scans untrusted memory text before durable storage or model delivery. */
export function scanMemoryContent(content: string): readonly MemorySafetyFinding[] {
  const findings: MemorySafetyFinding[] = [];
  for (const [label, pattern] of SECRET_PATTERNS) if (pattern.test(content)) findings.push({ kind: "secret", label });
  for (const [label, pattern] of INJECTION_PATTERNS) if (pattern.test(content)) findings.push({ kind: "prompt-injection", label });
  return findings;
}

/** Rejects obvious credentials and instruction-injection text before persistence. */
export class DefaultMemoryContentScanner implements MemoryContentScanner {
  async scan(candidate: MemoryCandidate): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }> {
    const findings = scanMemoryContent(`${candidate.name}\n${candidate.description}\n${candidate.content}`);
    const secret = findings.find(({ kind }) => kind === "secret");
    if (secret) return { allowed: false, reason: `secret detected: ${secret.label}` };
    const injection = findings.find(({ kind }) => kind === "prompt-injection");
    if (injection) return { allowed: false, reason: `prompt injection detected: ${injection.label}` };
    return { allowed: true };
  }
}
