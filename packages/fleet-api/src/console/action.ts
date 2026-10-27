import { useState } from 'react';
import { messageOf } from './model';
import { navigate } from './router';
export function useAction(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function run(path: string, values: Record<string, string>) {
    setBusy(true);
    setError('');
    setSuccess('');
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
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { run, busy, error, success };
}

interface ActionResponse {
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
    throw new Error(
      [result.error, ...(result.errors ?? [])].filter(Boolean).join(' ')
    );
  if (result.flash?.kind === 'error') throw new Error(result.flash.text);
  return result;
}
