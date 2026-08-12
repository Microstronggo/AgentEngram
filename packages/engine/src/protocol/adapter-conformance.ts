import type { HostCapabilities } from "./capabilities.js";
import type { ContextIntegrationIntent, ContextMode } from "./context-view.js";

/** Framework-neutral surfaces observed from an adapter's real registrations. */
export interface AdapterObservedSurfaces {
  readonly contextHook: boolean;
  readonly replaceContext: boolean;
  readonly compactionHook: boolean;
  readonly replaceCompaction: boolean;
  readonly sessionLifecycle: boolean;
  readonly threadLifecycle: boolean;
  readonly toolLifecycle: boolean;
  readonly persistentCustomEntries: boolean;
  readonly currentModelInvocation: boolean;
  readonly subagents: boolean;
}

/** Fixture consumed by every host adapter's shared capability contract test. */
export interface AdapterConformanceFixture {
  readonly adapterName: string;
  readonly capabilities: HostCapabilities;
  readonly observed: AdapterObservedSurfaces;
  /** Must throw when an unsupported ownership transfer is requested. */
  readonly resolveMode: (intent: ContextIntegrationIntent) => ContextMode;
}

/** One actionable mismatch between declared capabilities and installed behavior. */
export interface AdapterConformanceIssue {
  readonly field: keyof AdapterObservedSurfaces | "autoMode" | "enhanceMode" | "managedMode" | "schemaVersion";
  readonly message: string;
}

/** Human- and machine-readable upstream compatibility evidence published by an adapter. */
export interface AdapterCompatibilityDescriptor {
  readonly schemaVersion: 1;
  readonly adapterName: string;
  readonly adapterContractVersion: 1;
  readonly hostName: string;
  readonly integrationSchema: string;
  readonly testedHostVersions: readonly string[];
  readonly support: "experimental" | "supported";
}

/** Rejects vague compatibility claims that cannot be reproduced in release CI. */
export function assertAdapterCompatibilityDescriptor(value: AdapterCompatibilityDescriptor): void {
  for (const [name, field] of [
    ["adapterName", value.adapterName],
    ["hostName", value.hostName],
    ["integrationSchema", value.integrationSchema],
  ] as const) {
    if (!field.trim()) throw new Error(`${name} is required`);
  }
  if (value.schemaVersion !== 1 || value.adapterContractVersion !== 1) {
    throw new Error("unsupported adapter compatibility schema");
  }
  if (value.testedHostVersions.length === 0 || value.testedHostVersions.some((version) => !version.trim())) {
    throw new Error("testedHostVersions must contain at least one concrete version");
  }
  if (value.support !== "experimental" && value.support !== "supported") {
    throw new Error("adapter compatibility support level is invalid");
  }
}

/**
 * Evaluates host-neutral invariants without importing Pi, Codex, or a test
 * framework. Adapter tests derive `observed` from real hook registrations, so a
 * new adapter can reuse the same release gate.
 */
export function evaluateAdapterConformance(fixture: AdapterConformanceFixture): readonly AdapterConformanceIssue[] {
  const issues: AdapterConformanceIssue[] = [];
  const pairs: ReadonlyArray<readonly [keyof AdapterObservedSurfaces, keyof HostCapabilities]> = [
    ["contextHook", "contextHook"],
    ["replaceContext", "replaceContext"],
    ["compactionHook", "compactionHook"],
    ["replaceCompaction", "replaceCompaction"],
    ["sessionLifecycle", "sessionLifecycle"],
    ["threadLifecycle", "threadLifecycle"],
    ["toolLifecycle", "toolLifecycle"],
    ["persistentCustomEntries", "persistentCustomEntries"],
    ["currentModelInvocation", "canInvokeCurrentModel"],
    ["subagents", "supportsSubagents"],
  ];
  for (const [surface, capability] of pairs) {
    if (fixture.observed[surface] !== fixture.capabilities[capability]) {
      issues.push({ field: surface, message: `${fixture.adapterName} ${surface} does not match declared ${capability}` });
    }
  }
  if (fixture.capabilities.replaceContext && !fixture.capabilities.contextHook) {
    issues.push({ field: "replaceContext", message: "replaceContext requires contextHook" });
  }
  if (fixture.capabilities.replaceCompaction && !fixture.capabilities.compactionHook) {
    issues.push({ field: "replaceCompaction", message: "replaceCompaction requires compactionHook" });
  }
  if (!fixture.capabilities.schemaVersion?.trim()) {
    issues.push({ field: "schemaVersion", message: `${fixture.adapterName} must pin an upstream integration schema` });
  }

  captureMode(issues, "autoMode", () => fixture.resolveMode("auto"), "enhance");
  captureMode(issues, "enhanceMode", () => fixture.resolveMode("enhance"), "enhance");
  const supportsManaged = fixture.capabilities.replaceContext && fixture.capabilities.replaceCompaction;
  if (supportsManaged) captureMode(issues, "managedMode", () => fixture.resolveMode("managed-context"), "managed-context");
  else {
    try {
      fixture.resolveMode("managed-context");
      issues.push({ field: "managedMode", message: `${fixture.adapterName} must reject unsupported managed-context` });
    } catch {
      // Expected: ownership cannot silently downgrade to enhance.
    }
  }
  return issues;
}

/** Throws one aggregated error suitable for Vitest, CI, and external adapters. */
export function assertAdapterConformance(fixture: AdapterConformanceFixture): void {
  const issues = evaluateAdapterConformance(fixture);
  if (issues.length > 0) throw new Error(issues.map(({ message }) => message).join("\n"));
}

function captureMode(
  issues: AdapterConformanceIssue[],
  field: AdapterConformanceIssue["field"],
  operation: () => ContextMode,
  expected: ContextMode,
): void {
  try {
    const actual = operation();
    if (actual !== expected) issues.push({ field, message: `mode resolved to ${actual}; expected ${expected}` });
  } catch (error) {
    issues.push({ field, message: `mode resolution failed: ${errorMessage(error)}` });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
