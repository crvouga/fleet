/**
 * Marks a string constant as a Tailwind class list. It returns its input; the
 * tag exists so the stylesheet test can find class literals that are not
 * written inline in a `class` attribute.
 */
export function tw(classes: string): string {
  return classes;
}

type ClassPart = string | false | null | undefined;

/** Joins class lists, skipping falsy parts. */
export function cx(...parts: readonly ClassPart[]): string {
  return parts
    .filter((part) => typeof part === 'string' && part !== '')
    .join(' ');
}
