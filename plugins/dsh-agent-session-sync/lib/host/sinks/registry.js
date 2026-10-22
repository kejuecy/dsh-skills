/**
 * Export-sink registry — the mirror image of `providers/registry.js`.
 *
 * A *provider* reads a third-party agent's history **into** DSH.
 * A *sink* writes a DSH session **back out** to a third-party agent.
 *
 * Adding a new export target means dropping one module next to this file that
 * exports `{ id, label, description, status(), write(conversation, options) }`
 * and appending its entry to `SINK_ORDER` below. The panel lists it
 * automatically — the rest of the export pipeline is target-agnostic.
 *
 * Sinks receive the **same** neutral `Conversation` shape that providers
 * produce (see `providers/shared.js`), so one conversion layer serves both
 * directions and a new agent only needs one reader plus one writer.
 */
import * as workbuddy from './workbuddy.js';

/**
 * Display order of export targets. `workbuddy` ships with the package; every
 * other entry is imported lazily, so a missing module only removes that target
 * and never breaks the plugin.
 */
const SINK_ORDER = [
  { id: 'workbuddy', module: workbuddy },
  { id: 'claude-code', module: './claude-code.js' },
  { id: 'codex', module: './codex.js' },
  { id: 'cursor', module: './cursor.js' },
  { id: 'zcode', module: './zcode.js' },
  { id: 'kimi', module: './kimi.js' },
];

/** Resolved sink list (module load is idempotent). */
let resolved = null;

/**
 * Resolve every available sink module.
 * @returns sink modules in display order.
 */
export async function sinks() {
  if (resolved !== null) return resolved;
  const list = [];
  for (const entry of SINK_ORDER) {
    try {
      const module = typeof entry.module === 'string' ? await import(entry.module) : entry.module;
      // A module can be a read-only provider (no write function) — skip it as a
      // sink instead of failing, so the same file may serve both roles.
      if (typeof module.id === 'string' && typeof module.write === 'function') list.push(module);
    } catch {
      // Optional sink not shipped in this copy.
    }
  }
  resolved = list;
  return list;
}

/**
 * Look one sink up by id.
 * @param id - sink id.
 * @returns the sink module, or undefined.
 */
export async function sinkById(id) {
  const list = await sinks();
  return list.find((module) => module.id === id);
}

/** Descriptor text used by the export panel's target tabs. */
export async function sinkLabels() {
  const list = await sinks();
  return list.map((module) => ({
    id: module.id,
    label: typeof module.label === 'string' ? module.label : module.id,
    description: typeof module.description === 'string' ? module.description : '',
    // Whether this target replaces an existing transcript in place.
    overwrite: module.overwrite === true,
  }));
}
