addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const config = {
  proxyDomains: [], // Leave empty for localhost or non-domain usage
  separator: '------',
  homepage: true,
  allowedDomains: [], // [] = allow all

  browserEmulation: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    acceptLanguage: 'en-US,en;q=0.9',
    acceptEncoding: 'gzip, deflate, br',
    connection: 'keep-alive',
    upgradeInsecureRequests: '1',
    secFetchDest: 'document',
    secFetchMode: 'navigate',
    secFetchSite: 'none',
    secFetchUser: '?1',
  },

  fallback: { enabled: true, autoReload: true },

  specialSites: {
    wikipedia: { enabled: true, domains: ['wikipedia.org', 'wikimedia.org', 'mediawiki.org'] }
  }
}

async function handleRequest(request) {
  const url = new URL(request.url)
  const isProxyHost = !config.proxyDomains.length || config.proxyDomains.includes(url.host)

  // Homepage
  if (isProxyHost && url.pathname === '/' && config.homepage && !url.search) {
    return getHomePage()
  }

  // Determine target URL
  let targetURL
  try {
    targetURL = await resolveTargetURL(request, url, isProxyHost)
    if (!targetURL) return new Response('Invalid URL request', { status: 400 })
    
    // Check allowed domains
    if (config.allowedDomains.length > 0) {
      const allowed = config.allowedDomains.some(domain => targetURL.hostname === domain || targetURL.hostname.endsWith(`.${domain}`))
      if (!allowed) return new Response('Domain not in whitelist', { status: 403 })
    }
  } catch (e) {
    return new Response(`URL parsing error: ${e.message}`, { status: 400, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } })
  }

  // Is Wikipedia site?
  const isWikipediaSite = config.specialSites.wikipedia.enabled && config.specialSites.wikipedia.domains.some(d => targetURL.hostname.endsWith(d))

  // Prepare request headers
  const newHeaders = new Headers()
  const headersToKeep = ['cookie', 'range', 'if-none-match', 'if-modified-since', 'content-type', 'content-length']
  headersToKeep.forEach(h => { if (request.headers.has(h)) newHeaders.set(h, request.headers.get(h)) })

  Object.entries(config.browserEmulation).forEach(([k,v]) => newHeaders.set(k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`), v))
  newHeaders.set('Host', targetURL.host)
  newHeaders.set('Origin', targetURL.origin)
  newHeaders.set('Referer', targetURL.href)

  if (request.headers.get('X-Requested-With') === 'XMLHttpRequest' || request.headers.get('Accept')?.includes('application/json')) {
    newHeaders.set('X-Requested-With', 'XMLHttpRequest')
  }

  const newRequest = new Request(targetURL, {
    method: request.method,
    headers: newHeaders,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
    redirect: 'manual',
  })

  try {
    let response = await fetch(newRequest)
    response = await handleResponseRewrite(response, targetURL, url.host, isWikipediaSite)
    return response
  } catch (error) {
    return renderErrorPage(error, targetURL)
  }
}

// Resolve target URL (handles separator, query, relative paths)
async function resolveTargetURL(request, url, isProxyHost) {
  let target
  if (isProxyHost) {
    const path = url.pathname.substring(1)
    if (path.startsWith(config.separator)) {
      target = path.substring(config.separator.length)
    } else if (path === 'proxy' && url.searchParams.has('url')) {
      target = url.searchParams.get('url')
    } else {
      target = path || (url.searchParams.has('q') ? 'https://duckduckgo.com/?' + url.searchParams.toString() : null)
    }
    if (!target) return null
    return new URL(target.startsWith('http') ? target : 'https://' + target)
  } else {
    return url
  }
}

// Rewrite response for HTML/CSS/JS
async function handleResponseRewrite(response, targetURL, proxyDomain, isWikipediaSite) {
  const newRespHeaders = new Headers(response.headers)
  newRespHeaders.delete('Content-Security-Policy')
  newRespHeaders.delete('X-Frame-Options')
  newRespHeaders.set('Access-Control-Allow-Origin', '*')
  newRespHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH')
  newRespHeaders.set('Access-Control-Allow-Headers', '*')
  newRespHeaders.set('Access-Control-Allow-Credentials', 'true')

  const contentType = newRespHeaders.get('Content-Type') || ''
  let newResponse = response

  if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
    let rewriter = new HTMLRewriter()
      .on('a[href]', new LinkRewriter(targetURL, 'href', proxyDomain))
      .on('form[action]', new LinkRewriter(targetURL, 'action', proxyDomain))
      .on('img[src]', new LinkRewriter(targetURL, 'src', proxyDomain))
      .on('img[srcset]', new SrcsetRewriter(targetURL, proxyDomain))
      .on('link[href]', new LinkRewriter(targetURL, 'href', proxyDomain))
      .on('script[src]', new LinkRewriter(targetURL, 'src', proxyDomain))
      .on('iframe[src]', new LinkRewriter(targetURL, 'src', proxyDomain))
      .on('meta[content]', new MetaContentRewriter(targetURL, proxyDomain))
      .on('base[href]', new BaseTagRewriter(targetURL, proxyDomain))
      .on('*[style]', new StyleAttributeRewriter(targetURL, proxyDomain))

    if (isWikipediaSite) {
      rewriter = rewriter.on('img[data-src]', new LinkRewriter(targetURL, 'data-src', proxyDomain))
      rewriter = rewriter.on('style', new StyleElementRewriter(targetURL, proxyDomain))
    }

    if (config.fallback.enabled && config.fallback.autoReload) {
      rewriter = rewriter.on('head', new HeadRewriter(targetURL.href))
    }

    newResponse = rewriter.transform(response)
  }
  else if (contentType.includes('text/css')) {
    const css = await response.text()
    const rewritten = rewriteCSS(css, targetURL, proxyDomain)
    newResponse = new Response(rewritten, { status: response.status, headers: newRespHeaders })
  }
  else if (contentType.includes('javascript')) {
    const js = await response.text()
    const rewritten = rewriteJavaScript(js, targetURL, proxyDomain)
    newResponse = new Response(rewritten, { status: response.status, headers: newRespHeaders })
  }

  return newResponse
}

// Full error page
function renderErrorPage(error, targetURL) {
  return new Response(`
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>Proxy Error</title></head>
    <body>
      <h1>Proxy Request Failed</h1>
      <p>${error.message}</p>
      <p><a href="${targetURL?.href}" target="_blank">Open target directly</a></p>
    </body></html>
  `, { status: 500, headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Access-Control-Allow-Origin': '*' } })
}
