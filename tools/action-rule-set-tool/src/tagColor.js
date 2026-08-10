// Ruleset/actionset name -> categorical tag color (see --tag-c0..15 and
// .tag-c0..15 / .ruleset-chip.tag-c0..15 in styles.css). buildTagColorMap
// assigns colors by sorted position within the given name list, so every
// name in view gets a distinct color as long as the list has 16 or fewer
// entries (the current scenario has 12 rulesets, 4 actionsets) — a plain
// hash-per-name can coincidentally collide two names on the same color,
// which is exactly what this replaces.
const TAG_COLOR_COUNT = 16;

export function buildTagColorMap(names) {
  const sorted = [...new Set(names)].sort();
  const map = {};
  sorted.forEach((name, i) => { map[name] = `tag-c${i % TAG_COLOR_COUNT}`; });
  return map;
}
