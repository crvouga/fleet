/** What the post-deploy check found, in the order it found it. */
export interface Report {
  readonly failures: string[];
  readonly warnings: string[];
  passed: number;
  pass(name: string, detail: string): void;
  warn(name: string, detail: string): void;
  fail(name: string, detail: string): void;
}

export function createReport(
  write: (line: string) => void,
  redact: (text: string) => string
): Report {
  const report: Report = {
    failures: [],
    warnings: [],
    passed: 0,
    pass(name, detail) {
      report.passed += 1;
      write(redact(`ok    ${name}: ${detail}`));
    },
    warn(name, detail) {
      report.warnings.push(`${name}: ${detail}`);
      write(redact(`warn  ${name}: ${detail}`));
    },
    fail(name, detail) {
      report.failures.push(`${name}: ${detail}`);
      write(redact(`FAIL  ${name}: ${detail}`));
    },
  };
  return report;
}
