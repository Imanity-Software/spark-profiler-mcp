import type { LoadedProfile } from "./model/profile.js";

/** In-memory store of loaded profiles, keyed by their content hash id. A spark file is
 * parsed once on load_profile; every other tool reads from here. */
const store = new Map<string, LoadedProfile>();

export function putProfile(p: LoadedProfile): void {
  store.set(p.id, p);
}

export function getProfile(id: string): LoadedProfile {
  const p = store.get(id);
  if (!p) {
    const known = [...store.keys()];
    throw new Error(
      `No loaded profile with id "${id}". ${
        known.length ? `Loaded ids: ${known.join(", ")}.` : "Call load_profile first."
      }`,
    );
  }
  return p;
}

export function listProfiles(): { id: string; type: string; label: string }[] {
  return [...store.values()].map((p) => ({ id: p.id, type: p.type, label: p.label }));
}
