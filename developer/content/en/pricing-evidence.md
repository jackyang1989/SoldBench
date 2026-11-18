# Prices and research evidence

Prices are USD integer cents, with null for unknown. Default actual-price statistics exclude unknown accepted Best Offers, hard attribute mismatches and required unknown shipping. Type 7 quartiles, half-up final rounding and 5% per-tail trimming apply. Below 8 qualified records center statistics are null; 8–29 is limited, >=30 sufficient. Quality score stays null. IQR outlier flags explain observations and do not silently delete them.

Owner detail and diagnostics show permitted present/missing/withheld fields and inclusion decisions. Exports use complete allowed pricing rows, independent of display limit. Adjusted export can exclude selected event IDs without changing authority or billing. Images are controlled references with current permission checks; no upstream image URL is exposed. No data permission means no row/image delivery, even from a saved snapshot.

Related: [Quickstart](/docs/en/quickstart), [OpenAPI](/openapi.json), [Skill](/.well-known/skills/soldbench/SKILL.md).

For broad searches, use `quality.comparison_scope` and the stable `mixed_models` warning. A mixed sample describes the observed models together. Prompt for a model before presenting a model-specific price. `single_model_label_observed` indicates a shared source label that may still include different brands and configurations. `unresolved` means the sample lacks enough structured model evidence. The comparison scope may be absent on older snapshots or where current attribute permissions are unavailable.
