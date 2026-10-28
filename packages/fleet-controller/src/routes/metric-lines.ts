/** Prometheus text-format helpers shared by the metric groups. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** One sample line, or nothing for an unknown value: unavailable is omitted, never zero. */
export function series(
  name: string,
  value: number | null,
  labels: Record<string, string>
): string[] {
  return value === null
    ? []
    : [
        `${name}{${Object.entries(labels)
          .map(([key, text]) => `${key}=${quoted(text)}`)
          .join(',')}} ${value}`,
      ];
}
