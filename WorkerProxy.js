addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)

  if (!url.pathname.startsWith('/proxy') || !url.searchParams.has('url')) {
    return new Response('Missing ?url= parameter', { status: 400 })
  }

  const targetUrl = url.searchParams.get('url')

  const response = await fetch(targetUrl, {
    method: request.method,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
    },
    redirect: 'follow',
  })

  const newHeaders = new Headers(response.headers)
  newHeaders.set('Access-Control-Allow-Origin', '*')
  newHeaders.delete('Content-Security-Policy')
  newHeaders.delete('X-Frame-Options')

  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  })
}
