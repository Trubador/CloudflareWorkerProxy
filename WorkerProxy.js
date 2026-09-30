addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)

  if (!url.pathname.startsWith('/proxy') || !url.searchParams.has('url')) {
    return new Response('Missing ?url= parameter', { status: 400 })
  }

  let targetURL
  try {
    targetURL = new URL(url.searchParams.get('url'))
  } catch (error) {
    return new Response(`Invalid URL: ${error.message}`, { status: 400 })
  }

  // Preserve the original method, streaming body, cookies and headers.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('Host', targetURL.host)
  const newRequest = new Request(new Request(targetURL, request), {
    headers: requestHeaders,
    redirect: 'manual',
  })

  const response = await fetch(newRequest)

  // Preserve redirects, including Location and Set-Cookie, without following them.
  if (response.status >= 300 && response.status < 400) {
    return response
  }

  const newHeaders = new Headers(response.headers)
  newHeaders.set('Access-Control-Allow-Origin', '*')
  newHeaders.delete('Content-Security-Policy')
  newHeaders.delete('X-Frame-Options')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  })
}
