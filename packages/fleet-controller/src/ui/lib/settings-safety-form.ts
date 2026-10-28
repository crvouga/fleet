import type { FormBody } from './settings-form';

export interface SafetyFields {
  /** Absent when the form did not carry the revision (an old page or a script). */
  readonly expectedRevision: number | undefined;
  readonly acknowledge: readonly string[];
  readonly preview: boolean;
}

const CODE = /^[a-z0-9_]{1,60}$/;

function all(body: FormBody, name: string): string[] {
  const value = body[name];
  return (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .filter((item): item is string => typeof item === 'string')
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** The concurrency token, acknowledged warning codes and preview intent of a settings form. */
export function readSafetyFields(body: FormBody): SafetyFields {
  const [raw] = all(body, 'expectedRevision');
  const revision = raw === undefined ? NaN : Number(raw);
  return {
    expectedRevision:
      Number.isInteger(revision) && revision >= 0 ? revision : undefined,
    acknowledge: all(body, 'acknowledge').filter((code) => CODE.test(code)),
    preview: all(body, 'intent').includes('preview'),
  };
}
