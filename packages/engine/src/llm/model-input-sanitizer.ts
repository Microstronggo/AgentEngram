/** Size and security controls applied before content reaches an LLM. */
export interface ModelInputSanitizerOptions {
  /** Maximum characters retained for each rendered tool-result line/block. */
  readonly toolResultCharacterBudget?: number;
  /** Final deterministic cap applied after secret redaction and tool budgeting. */
  readonly maxCharacters?: number;
}

/** Safe model projection plus findings retained for diagnostics. */
export interface ModelInputSanitizationResult {
  /** Safe projection sent to an LLM; never persisted as transcript truth. */
  readonly text: string;
  /** Non-sensitive reason codes exposed to tests and diagnostics. */
  readonly findings: readonly ("secret-redacted" | "tool-result-truncated" | "untrusted-instruction" | "input-truncated")[];
}

/** Converts untrusted transcript evidence into a bounded model input view. */
export interface ModelInputSanitizer {
  sanitize(text: string, options?: ModelInputSanitizerOptions): ModelInputSanitizationResult;
}

/**
 * Deterministic security projection used before transcript-derived text reaches an LLM.
 * It does not mutate raw transcript, Cell, or memory records.
 */
export class DefaultModelInputSanitizer implements ModelInputSanitizer {
  public sanitize(text: string, options: ModelInputSanitizerOptions = {}): ModelInputSanitizationResult {
    const findings = new Set<ModelInputSanitizationResult["findings"][number]>();
    let projected = redactSecrets(text, findings);
    projected = budgetToolResults(projected, options.toolResultCharacterBudget ?? 2_000, findings);
    if (looksLikeUntrustedInstruction(projected)) {
      findings.add("untrusted-instruction");
      projected = [
        '<untrusted-evidence reason="instruction-like transcript content">',
        projected,
        "</untrusted-evidence>",
      ].join("\n");
    }
    const maxCharacters = Math.max(1, options.maxCharacters ?? 32_000);
    if (projected.length > maxCharacters) {
      const omitted = projected.length - maxCharacters;
      projected = `${projected.slice(0, maxCharacters)}\n[AGENTENGRAM_INPUT_TRUNCATED:${omitted}_CHARS]`;
      findings.add("input-truncated");
    }
    return { text: projected, findings: [...findings] };
  }
}

function redactSecrets(
  text: string,
  findings: Set<ModelInputSanitizationResult["findings"][number]>,
): string {
  let output = text;
  const replace = (pattern: RegExp, replacement: string | ((...args: string[]) => string)) => {
    output = output.replace(pattern, (...args: string[]) => {
      findings.add("secret-redacted");
      return typeof replacement === "string" ? replacement : replacement(...args);
    });
  };
  replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[REDACTED_PRIVATE_KEY]");
  replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/giu, "Bearer <redacted>");
  replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{8,}/gu, "<redacted-token>");
  // Preserve the configuration key so the model understands which credential
  // was discussed while removing only the value.
  replace(
    /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL))\s*([=:]\s*)(["']?)([^\s"',;]{8,})\3/gu,
    (_match, name, separator) => `${name}${separator}<redacted>`,
  );
  return output;
}

function budgetToolResults(
  text: string,
  budget: number,
  findings: Set<ModelInputSanitizationResult["findings"][number]>,
): string {
  const safeBudget = Math.max(0, budget);
  return text.split("\n").map((line) => {
    if (!/^\s*(?:tool:|\[tool-result:|<message\b[^>]*role="tool")/iu.test(line) || line.length <= safeBudget) return line;
    findings.add("tool-result-truncated");
    return `${line.slice(0, safeBudget)} [AGENTENGRAM_TOOL_RESULT_TRUNCATED:${line.length - safeBudget}_CHARS]`;
  }).join("\n");
}

function looksLikeUntrustedInstruction(text: string): boolean {
  return /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system)\s+(?:instructions?|prompts?)|system\s+prompt|jailbreak|忽略(?:之前|以上|系统).*指令|覆盖系统提示/iu.test(text);
}
