// The game's map rules (crate maze3-map) as bare-ABI WASM (crate maze3-map-wasm).
// JSON in, JSON out; the reply's first 4 bytes are its little-endian length.
// crowd_core links wgpu, whose web backend leaves wasm-bindgen placeholder
// imports in the module. The map rules never reach them; each stub throws if
// one ever does.
export async function loadBridge(bytes) {
  const module = await WebAssembly.compile(bytes);
  const imports = {};
  for (const { module: m, name } of WebAssembly.Module.imports(module)) {
    if (!m.startsWith("__wbindgen")) throw new Error(`map.wasm: 예상하지 못한 import ${m}.${name}`);
    (imports[m] ??= {})[name] = () => { throw new Error(`map.wasm: ${m}.${name} 호출됨`); };
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const x = instance.exports;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const read = (ptr) => {
    const len = new DataView(x.memory.buffer).getUint32(ptr, true);
    const text = dec.decode(new Uint8Array(x.memory.buffer, ptr + 4, len));
    x.dealloc(ptr, len + 4);
    const value = JSON.parse(text);
    if (value && typeof value === "object" && "error" in value) throw new Error(value.error);
    return value;
  };
  const call = (name, request) => {
    const bytes = enc.encode(JSON.stringify(request));
    const ptr = x.alloc(bytes.length);
    new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
    return read(x[name](ptr, bytes.length));
  };
  return {
    config: () => read(x.config()),
    check: (map) => call("check", map),
    base: (map, cell) => call("base", { map, cell }).reason,
    ramp: (map, cells) => call("ramp", { map, cells }).cells,
    analyze: (doc) => call("analyze", doc),
    exportRon: (doc) => call("export", doc),
    importRon: (text) => call("import", { text }),
  };
}
