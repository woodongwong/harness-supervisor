// The handoff data model is harness-neutral. This registry lists integrations
// actually implemented here; adding a name alone does not implement an adapter.
export const HARNESS_INTEGRATIONS = Object.freeze({
  codex: { displayName: "Codex", stopAfterTool: true },
  zcode: { displayName: "ZCode", stopAfterTool: false },
});
