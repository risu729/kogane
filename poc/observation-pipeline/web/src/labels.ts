/** Unknown source values stay visible; inherited object keys are not labels. */
export function displayLabel(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? (labels[value] ?? value) : value;
}
