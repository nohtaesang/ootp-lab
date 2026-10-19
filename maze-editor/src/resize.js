// Editing transforms only. Playability remains the shared WASM check's job.
export function resizeOffset(doc, width, height, anchor = 4) {
  return [Math.trunc((width - doc.width) * (anchor % 3) / 2),
    Math.trunc((height - doc.height) * Math.floor(anchor / 3) / 2)];
}

/** A detached candidate: never modifies the document, even at the same size. */
export function resizeMap(doc, width, height, mode = "extent", anchor = 4) {
  if (![width, height].every((n) => Number.isInteger(n) && n > 0)) throw new Error("크기는 양의 정수여야 합니다.");
  if (!["extent", "scale"].includes(mode)) throw new Error("알 수 없는 크기 변경 모드입니다.");
  if (!Number.isInteger(anchor) || anchor < 0 || anchor > 8) throw new Error("올바르지 않은 기준점입니다.");
  const codes = new Uint8Array(width * height);
  let base;
  if (mode === "scale") {
    // Sample cell centres, without blending categorical terrain codes. This
    // keeps non-integer scales deterministic and treats both axes identically.
    for (let y = 0; y < height; y++) {
      const sy = Math.min(doc.height - 1, Math.floor((y + 0.5) * doc.height / height));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(doc.width - 1, Math.floor((x + 0.5) * doc.width / width));
        codes[y * width + x] = doc.codes[sy * doc.width + sx];
      }
    }
    // Only the centre moves; a stronghold's cell footprint never scales.
    base = doc.base?.map((v, axis) => Math.floor((v + 0.5) * [width / doc.width, height / doc.height][axis]));
  } else {
    const [dx, dy] = resizeOffset(doc, width, height, anchor);
    for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height) codes[ny * width + nx] = doc.codes[y * doc.width + x];
    }
    base = doc.base && [doc.base[0] + dx, doc.base[1] + dy];
  }
  return { ...doc, width, height, codes, base: base ?? null };
}
