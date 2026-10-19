// The ingress analysis runs here so a big map never freezes the editor.
import { loadBridge } from "./bridge.js?v=eea32584";

const bridge = fetch(new URL("../map.wasm?v=eea32584", import.meta.url))
  .then((r) => r.arrayBuffer())
  .then(loadBridge);

self.onmessage = async ({ data: { job, doc } }) => {
  try {
    const b = await bridge;
    self.postMessage({ job, report: b.analyze(doc) });
  } catch (e) {
    self.postMessage({ job, error: String(e.message ?? e) });
  }
};
