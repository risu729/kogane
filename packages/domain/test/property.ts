// Seeded generators for the property tests. Every run of a fixed seed draws
// the same cases, so a failure names a seed that reproduces it.

/** A seeded uniform draw in [0, 1) (mulberry32). */
export type Random = () => number;

export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

/** An integer in [from, to]. */
export function between(random: Random, from: number, to: number): number {
  return from + Math.floor(random() * (to - from + 1));
}

/** A uniformly shuffled copy (Fisher–Yates). */
export function shuffled<T>(random: Random, items: readonly T[]): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
}

/** The seeds a property runs over: `count` consecutive seeds from `first`. */
export function seeds(first: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => first + index);
}

export const pad2 = (value: number): string => String(value).padStart(2, "0");
