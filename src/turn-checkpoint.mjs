import { HARNESS_INTEGRATIONS } from "./harness-integrations.mjs";

export const eventHarness = event => event.harness ?? String(event.source ?? "").replace(/-hook$/, "");
const hook = p => p.hook_event_name ?? p.hookEventName;
const session = p => p.session_id ?? p.sessionId ?? null;

// Structured observations, not a model-generated claim that the whole task is done.
export function completedTurns(events, saved = {}) {
  const active = new Map();
  const result = { ...saved };
  for (let i = 0; i < events.length; i++) {
    const event = events[i], p = event.payload ?? {}, harness = eventHarness(event);
    if (!harness || !/^[a-z][a-z0-9-]*$/.test(harness) || ["__proto__", "constructor", "prototype"].includes(harness)) continue;
    const key = `${harness}:${session(p)}`;
    if (hook(p) === "UserPromptSubmit") active.set(key, { request: p.prompt ?? "", startAt: event.at ?? null, startIndex: i });
    if (hook(p) !== "Stop") continue;
    const previous = result[harness];
    const request = active.get(key);
    // Retain the stored request when the journal window starts after its prompt.
    const same = previous?.sessionId === session(p) && previous?.at === event.at;
    const turn = {
      harness, sessionId: session(p), turnId: p.turn_id ?? null,
      request: request?.request ?? (same ? previous.request : ""),
      reply: p.last_assistant_message ?? p.lastAssistantMessage ?? "",
      startAt: request?.startAt ?? (same ? previous.startAt : null),
      at: event.at ?? null, ended: true,
    };
    if (!previous?.at || !turn.at || turn.at >= previous.at) result[harness] = turn;
  }
  return result;
}

export function selectPreviousTurn(events, target, saved = {}) {
  const turns = completedTurns(events, saved);
  const prompt = [...events].reverse().find(e => hook(e.payload ?? {}) === "UserPromptSubmit")?.payload?.prompt ?? "";
  // Explicitly naming the other harness disambiguates which conversation to resume.
  const names = new Set([...Object.keys(HARNESS_INTEGRATIONS), ...Object.keys(turns)]);
  const mentions = [...new Set((prompt.toLowerCase().match(/[a-z][a-z0-9-]*/g) ?? []).filter(name => names.has(name)))];
  if (mentions.length === 1 && mentions[0] !== target) return turns[mentions[0]] ?? null;
  return Object.values(turns).sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? ""))).at(-1) ?? null;
}

export function turnEvents(events, turn) {
  if (!turn) return events;
  return events.filter(event => {
    const p = event.payload ?? {};
    if (eventHarness(event) !== turn.harness || session(p) !== turn.sessionId) return false;
    if (turn.turnId && p.turn_id && p.turn_id !== turn.turnId) return false;
    if (event.at && turn.startAt && event.at < turn.startAt) return false;
    if (event.at && turn.at && event.at > turn.at) return false;
    return true;
  });
}
