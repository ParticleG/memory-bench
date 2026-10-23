export type AxisScale = 'linear' | 'log';

export function isAxisValue(value: unknown, scale: AxisScale): value is number {
  return typeof value === 'number' && Number.isFinite(value) && (scale === 'linear' || value > 0);
}

export function logAxisMin(values: Iterable<number>): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (value > 0 && Number.isFinite(value) && value < minimum) minimum = value;
  }
  if (!Number.isFinite(minimum)) return 0.1;
  const bound = 10 ** (Math.ceil(Math.log10(minimum)) - 1);
  return bound > 0 ? bound : minimum;
}

// Input is sorted. Omitting non-positive coordinates must not renormalize the empirical CDF.
export function buildCdfPoints(values: readonly number[], xScale: AxisScale, yScale: AxisScale): Array<[number, number]> {
  if (values.length === 0) return [];
  const points: Array<[number, number]> = [];
  if (xScale === 'linear' && yScale === 'linear') points.push([0, 0]);
  let index = 0;
  while (index < values.length) {
    let end = index;
    while (end + 1 < values.length && values[end + 1] === values[index]) end += 1;
    const cumulative = (end + 1) / values.length;
    if (isAxisValue(values[end], xScale) && isAxisValue(cumulative, yScale)) {
      points.push([values[end], cumulative]);
    }
    index = end + 1;
  }
  return points;
}
