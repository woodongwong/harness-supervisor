// Harness-neutral, explicit updates. Missing fields never erase earlier work.
const states = {
  work: ["pending", "in_progress", "blocked", "done", "cancelled"],
  verification: ["pending", "passed", "failed", "skipped"],
  constraint: ["active", "retired"],
  decision: ["active", "retired"],
};
const terminal = new Set(["done", "cancelled", "passed", "skipped", "retired"]);
export const isOpenItem = item => !terminal.has(item.status);
export const hasPendingWork = progress => (progress?.items ?? []).some(item =>
  ["work", "verification"].includes(item.kind) && isOpenItem(item));

export function progressAssessment(progress) {
  if (!progress || !progress.revision) return "uninitialized";
  const work = (progress.items ?? []).filter(item => ["work", "verification"].includes(item.kind));
  if (!work.length) return "no_work_items";
  return work.some(isOpenItem) ? "pending" : "recorded_items_resolved";
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}
function string(value, label, bytes) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > bytes) throw new Error(`${label} must be nonempty and <= ${bytes} UTF-8 bytes`);
  return value.trim();
}
function fields(value, allowed) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown progress field: ${key}`);
}

export function mergeProgress(previous, patch, author, at = new Date().toISOString()) {
  object(patch, "patch");
  fields(patch, ["title", "goal", "items"]);
  const result = structuredClone(previous ?? { version: 1, revision: 0, items: [] });
  let changed = false;
  for (const key of ["title", "goal"]) if (Object.hasOwn(patch, key)) {
    result[key] = string(patch[key], key, key === "title" ? 160 : 1200);
    changed = true;
  }
  if (patch.items !== undefined) {
    if (!Array.isArray(patch.items) || patch.items.length > 100) throw new Error("items must be an array of at most 100 updates");
    const seen = new Set();
    for (const update of patch.items) {
      object(update, "item");
      fields(update, ["id", "kind", "text", "status", "evidence"]);
      if (typeof update.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(update.id) || seen.has(update.id)) throw new Error("Item IDs must be unique, stable, and alphanumeric with hyphens/underscores");
      seen.add(update.id);
      const index = result.items.findIndex(item => item.id === update.id);
      const existing = result.items[index];
      const item = { ...existing, ...update };
      if (!Object.hasOwn(states, item.kind) || !states[item.kind].includes(item.status)) throw new Error("Invalid item kind or status");
      if (existing && item.kind !== existing.kind) throw new Error("An item's kind cannot change");
      item.text = string(item.text, "item.text", 800);
      if (item.evidence !== undefined) item.evidence = string(item.evidence, "item.evidence", 800);
      if (item.status !== existing?.status && terminal.has(item.status) && !update.evidence) throw new Error("Resolving an item requires new evidence or a cancellation/retirement reason");
      item.updatedAt = at;
      item.author = { ...author };
      if (index < 0) result.items.push(item); else result.items[index] = item;
      changed = true;
    }
  }
  if (!changed) throw new Error("No progress updates supplied");
  result.revision += 1;
  result.updatedAt = at;
  result.author = { ...author };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error("Progress exceeds 256 KiB; shorten item text/evidence. Existing records were preserved.");
  return result;
}

// Keep blockers and outstanding work ahead of completed items in a small prompt.
export function orderedProgressItems(progress) {
  const rank = item => ["blocked", "failed"].includes(item.status) ? 0
    : ["constraint", "decision"].includes(item.kind) && item.status === "active" ? 1
    : isOpenItem(item) ? 2 : 3;
  return [...(progress?.items ?? [])].sort((a, b) => rank(a) - rank(b) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
