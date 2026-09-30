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

  // Build a clean set of headers — strip everything Cloudflare-injected
  // and all proxy/forwarding headers that confuse the destination's edge.
  const headersToRemove = [
    'host',
    'cf-connecting-ip',
    'cf-ipcountry',
    'cf-ray',
    'cf-visitor',
    'cf-worker',
    'cf-ew-via',
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-forwarded-host',
    'x-real-ip',
    'cdn-loop',
    'true-client-ip',
  ]

  const requestHeaders = new Headers(request.headers)
  for (const h of headersToRemove) {
    requestHeaders.delete(h)
  }
  // Let fetch() set the correct Host automatically based on targetURL
  requestHeaders.set('Host', targetURL.host)

  const newRequest = new Request(targetURL, {
    method: request.method,
    headers: requestHeaders,
    body: request.body,
    redirect: 'manual',
  })

  const response = await fetch(newRequest)

  // Handle 526 specifically — destination's origin cert is broken
  if (response.status === 526) {
    return new Response(
      'The destination site has an invalid SSL certificate on its origin server.',
      { status: 502 }
    )
  }

  // Preserve redirects without following them
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
