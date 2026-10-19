// Display only: radius and centre come from the game's WASM report.
// Terrain painting cannot change a radial sight boundary, unlike moving
// the base, resizing the map or changing the battle settings.
export const sightKey = (doc) => JSON.stringify([doc.width, doc.height, doc.base, doc.battle ?? null]);
export function sightPreview(doc, analysis) {
  if (!analysis.report || analysis.sightKey !== sightKey(doc)) return null;
  const round = analysis.report.rounds[analysis.round];
  if (!round) return null;
  return { base: analysis.report.base, radius: round.sight, number: round.number };
}
export const sightLabel = (radius) => radius == null ? "맵 전체" : `기지에서 ${Number(radius.toFixed(1))}칸`;
export const roundSightLabel = (round) => `${round.number}R · ${round.sight == null ? "전체" : `${Number(round.sight.toFixed(1))}칸`}`;
