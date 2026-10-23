/** Linear-interpolated quantile of finite values sorted in ascending order. */
export function quantileSorted(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const position = (values.length - 1) * fraction;
  const lower = Math.floor(position);
  return values[lower] + (values[Math.ceil(position)] - values[lower]) * (position - lower);
}
