/** Label locally served live data without changing HTTP response bodies or authentication. */
export async function localResponse(
  response: Response,
  request: Request,
  source: 'managed' | 'emulated' = 'managed'
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set('X-Fleet-Data-Source', source);
  if (
    !headers.get('content-type')?.includes('text/html') ||
    new URL(request.url).pathname === '/login'
  )
    return new Response(response.body, { status: response.status, headers });
  const html = await response.text();
  const banner =
    source === 'emulated'
      ? '<aside role="note">LOCAL EMULATION: Fleet data is stored in this checkout. External services run locally in Mockingbird.</aside>'
      : '<aside role="note">LIVE FLEET DATA: changes affect the managed fleet. Background jobs run only on the deployed service.</aside>';
  headers.delete('content-length');
  return new Response(
    html
      .replace(
        '<head>',
        `<head><meta name="fleet-data-source" content="${source}">`
      )
      .replace('<main', `${banner}<main`),
    {
      status: response.status,
      headers,
    }
  );
}
