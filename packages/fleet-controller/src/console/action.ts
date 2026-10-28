import { useState } from 'react';
import { messageOf } from './model';
import { navigate } from './router';
export function useAction(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [problem, setProblem] = useState<ActionProblem | null>(null);
  async function run(path: string, values: Record<string, string>) {
    setBusy(true);
    setError('');
    setSuccess('');
    setProblem(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(values),
      });
      if (response.redirected) {
        window.location.assign(response.url);
        return false;
      }
      const result = await readActionResponse(response);
      setSuccess(result.flash?.text ?? 'Changes saved.');
      if (
        result.redirect &&
        result.redirect !== location.pathname + location.search
      )
        navigate(result.redirect, true);
      reload();
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      setProblem(cause instanceof ActionFailure ? cause.problem : null);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { run, busy, error, success, problem };
}

/** Machine-readable detail of a refused action: a code to branch on and what the server listed. */
export interface ActionProblem {
  code?: string;
  issues?: { code: string; message: string; blocking: boolean }[];
}
class ActionFailure extends Error {
  constructor(
    message: string,
    readonly problem: ActionProblem
  ) {
    super(message);
  }
}

interface ActionResponse extends ActionProblem {
  error?: string;
  errors?: string[];
  redirect?: string;
  flash?: { text: string; kind: string };
}
async function readActionResponse(response: Response): Promise<ActionResponse> {
  const json = response.headers
    .get('content-type')
    ?.includes('application/json');
  const result: ActionResponse = json
    ? await response.json()
    : { error: await response.text() };
  if (!response.ok)
    throw new ActionFailure(
      [result.error, ...(result.errors ?? [])].filter(Boolean).join(' '),
      {
        ...(result.code ? { code: result.code } : {}),
        ...(result.issues ? { issues: result.issues } : {}),
      }
    );
  if (result.flash?.kind === 'error') throw new Error(result.flash.text);
  return result;
}
