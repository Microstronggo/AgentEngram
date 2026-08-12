import type { AgentMessage, ContextMode, ContextRequest } from "../protocol/index.js";

/** One ordered projector invocation over the current context candidate. */
export interface ProjectionInput {
  readonly request: ContextRequest;
  readonly mode: ContextMode;
  readonly messages: readonly AgentMessage[];
}

/** Named, deterministic stage that may transform a context candidate. */
export interface ContextProjector {
  readonly name?: string;
  readonly modes?: readonly ContextMode[];
  project(input: ProjectionInput): Promise<readonly AgentMessage[]>;
}

/** Functional projector form used by small stateless context stages. */
export type ContextProjection = (
  input: ProjectionInput,
) => Promise<readonly AgentMessage[]> | readonly AgentMessage[];

/** Wraps a functional projection with a stable diagnostic stage name. */
export function projector(
  projection: ContextProjection,
  options: Pick<ContextProjector, "name" | "modes"> = {},
): ContextProjector {
  return { ...options, project: async (input) => projection(input) };
}
