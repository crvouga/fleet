/** Label locally served live data without changing API bodies or authentication. */
export async function localResponse(
  response: Response,
  request: Request
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set('X-Fleet-Data-Source', 'managed');
  if (
    !headers.get('content-type')?.includes('text/html') ||
    new URL(request.url).pathname === '/login'
  )
    return new Response(response.body, { status: response.status, headers });
  const html = await response.text();
  const banner =
    '<aside role="note">LIVE FLEET DATA: changes affect the managed fleet. Background jobs run only on the deployed service.</aside>';
  headers.delete('content-length');
  return new Response(
    html
      .replace(
        '<head>',
        '<head><meta name="fleet-data-source" content="managed">'
      )
      .replace('<main', `${banner}<main`),
    {
      status: response.status,
      headers,
    }
  );
}
