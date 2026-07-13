// Reasoning effort / max mode → RequestedModel parameters

export type EffortConfig = {
  reasoningEffort?: string
  maxMode?: boolean
}

/**
 * Build RequestedModel parameter list from a model's variant parameters
 * and optional overrides from providerOptions.
 */
export function buildRequestedModelParams(
  variantParameters: Array<{ id: string; value: string }>,
  options?: EffortConfig,
): Array<{ id: string; value: string }> {
  // Start with variant's parameters as base
  const params = variantParameters.map((p) => ({ ...p }))

  // Override effort if specified
  if (options?.reasoningEffort) {
    const effortIdx = params.findIndex((p) => p.id === "effort" || p.id === "reasoning")
    if (effortIdx >= 0) {
      params[effortIdx] = { ...params[effortIdx], value: options.reasoningEffort }
    }
  }

  return params
}
