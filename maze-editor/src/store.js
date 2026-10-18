// The browser's own map library (localStorage). Files are the game's format
// only when exported; here a map is the editor's JSON with base64 tiles.
const PREFIX = "maze3-map-editor/map/";
const WORK = "maze3-map-editor/work";

const b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export const pack = (doc) => ({ ...doc, codes: b64(doc.codes) });
export const unpack = (raw) => ({ ...raw, codes: typeof raw.codes === "string" ? unb64(raw.codes) : Uint8Array.from(raw.codes) });

/** The plain object the WASM bridge reads. */
export const wire = (doc) => ({ ...doc, codes: Array.from(doc.codes) });

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    throw new Error("브라우저 저장 공간이 부족합니다. 안 쓰는 맵을 내보낸 뒤 지워 주세요.");
  }
}

export function list() {
  const maps = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      maps.push(unpack(JSON.parse(localStorage.getItem(key))));
    } catch {
      // A broken entry stays in storage; it is not shown as a map.
    }
  }
  return maps.sort((a, b) => a.name.localeCompare(b.name, "ko") || a.id.localeCompare(b.id));
}
export const load = (id) => {
  const raw = localStorage.getItem(PREFIX + id);
  return raw ? unpack(JSON.parse(raw)) : null;
};
export const has = (id) => localStorage.getItem(PREFIX + id) !== null;
export const put = (doc) => write(PREFIX + doc.id, pack(doc));
export const remove = (id) => localStorage.removeItem(PREFIX + id);

/** The latest unsaved work, separate from saved maps (EDT-05 recovery). */
export function saveWork(work) {
  try {
    write(WORK, { ...work, doc: pack(work.doc) });
    return true;
  } catch {
    return false;
  }
}
export function loadWork() {
  try {
    const raw = JSON.parse(localStorage.getItem(WORK));
    return raw ? { ...raw, doc: unpack(raw.doc) } : null;
  } catch {
    return null;
  }
}
export const clearWork = () => localStorage.removeItem(WORK);
