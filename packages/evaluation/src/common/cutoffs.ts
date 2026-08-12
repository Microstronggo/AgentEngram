export function parseCutoffs(value: string): readonly number[] {
  const parsed = value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((part) => Number.isFinite(part) && part > 0);
  return [...new Set(parsed)].sort((a, b) => a - b);
}

export function cutoffLabel(value: number): string {
  return `top_${value}`;
}
