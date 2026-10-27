import type { Logger } from '@pkgs/logger';

/** A logger that remembers everything, so tests can prove what was never logged. */
export function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const make = (
    bindings: Record<string, unknown>
  ): Logger & { readonly lines: string[] } => {
    const write =
      (level: string) => (msg: string, context?: Record<string, unknown>) => {
        lines.push(JSON.stringify({ level, msg, ...bindings, ...context }));
      };
    return {
      lines,
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      child: (extra) => make({ ...bindings, ...extra }),
    };
  };
  return make({});
}
