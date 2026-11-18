/** Describe model coverage of the verified price input. The result does not establish SKU identity. */
export function comparisonScope(models: readonly unknown[]) {
  const byModel = new Map<string, number>();
  let known = 0;
  for (const raw of models) {
    if (typeof raw !== "string") continue;
    const model = raw.normalize("NFC").trim();
    if (!model || model.length > 120 || ["unknown", "n/a", "unspecified"].includes(model.toLowerCase()))
      continue;
    byModel.set(model, (byModel.get(model) ?? 0) + 1);
    known += 1;
  }
  const count = byModel.size;
  return {
    status:
      count > 1
        ? ("mixed_models" as const)
        : count === 1 && known === models.length
          ? ("single_model_label_observed" as const)
          : ("unresolved" as const),
    modeled_price_input_count: known,
    unknown_model_price_input_count: models.length - known,
    distinct_model_labels: count,
    model_options: [...byModel]
      .sort(([a, left], [b, right]) => right - left || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 10)
      .map(([model, price_input_count]) => ({ model, price_input_count })),
    model_options_truncated: count > 10,
  };
}
export type ComparisonScope = ReturnType<typeof comparisonScope>;
