addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

// Configuration options
const config = {
  proxyDomains: [], // Keep empty for localhost or any domain
  separator: '------',
  homepage: true,
  allowedDomains: [],

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

  fallback: {
    enabled: true,
    autoReload: true,
  },

  specialSites: {
    wikipedia: {
      enabled: true,
      domains: ['wikipedia.org', 'wikimedia.org', 'mediawiki.org']
    }
  }
}

async function handleRequest(request) {
  const url = new URL(request.url)
  let targetURL;

  try {
    // -----------------------
    // API-friendly forwarding
    // -----------------------
    if (url.pathname.startsWith('/proxy') && url.searchParams.has('url')) {
      const baseUrl = url.searchParams.get('url')
      targetURL = new URL(baseUrl)

      // Forward additional query params
      url.searchParams.forEach((value, key) => {
        if (key !== 'url') {
          targetURL.searchParams.set(key, value)
        }
      })
    }
    // -----------------------
    // Existing separator method
    // -----------------------
    else {
      let rawPath = url.pathname.substring(1)
      if (rawPath.startsWith(config.separator)) {
        rawPath = rawPath.substring(config.separator.length)
      }
      if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
        targetURL = new URL(rawPath + url.search)
      } else if (rawPath || url.searchParams.has('q')) {
        const q = rawPath || url.searchParams.get('q')
        targetURL = new URL('https://duckduckgo.com/?q=' + encodeURIComponent(q))
      } else if (config.homepage && url.pathname === '/') {
        return getHomePage()
      } else {
        return new Response('Invalid URL request', { status: 400 })
      }
    }
  } catch (err) {
    return new Response(`Invalid URL: ${err.message}`, { status: 400 })
  }

  // -----------------------
  // Headers & Browser Emulation
  // -----------------------
  const newHeaders = new Headers()
  ;['cookie','range','if-none-match','if-modified-since','content-type','content-length'].forEach(h => {
    if (request.headers.has(h)) newHeaders.set(h, request.headers.get(h))
  })
  Object.entries(config.browserEmulation).forEach(([k,v]) => newHeaders.set(k.replace(/[A-Z]/g,m=>'-'+m.toLowerCase()), v))
  newHeaders.set('Host', targetURL.host)
  newHeaders.set('Origin', targetURL.origin)
  newHeaders.set('Referer', targetURL.href)

  const isXHR = request.headers.get('X-Requested-With') === 'XMLHttpRequest' ||
                request.headers.get('Accept')?.includes('application/json')
  if (isXHR) newHeaders.set('X-Requested-With','XMLHttpRequest')

  const newRequest = new Request(targetURL, {
    method: request.method,
    headers: newHeaders,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
    redirect: 'manual',
  })

  try {
    let response = await fetch(newRequest)

    // -----------------------
    // Response header tweaks
    // -----------------------
    const newRespHeaders = new Headers(response.headers)
    ;['Content-Security-Policy','Content-Security-Policy-Report-Only','X-Frame-Options','X-Content-Type-Options'].forEach(h => newRespHeaders.delete(h))
    newRespHeaders.set('Access-Control-Allow-Origin','*')
    newRespHeaders.set('Access-Control-Allow-Methods','GET, POST, PUT, DELETE, OPTIONS, PATCH')
    newRespHeaders.set('Access-Control-Allow-Headers','*')
    newRespHeaders.set('Access-Control-Allow-Credentials','true')

    // -----------------------
    // HTML, CSS, JS rewriting
    // -----------------------
    const contentType = newRespHeaders.get('Content-Type') || ''
    const currentProxyDomain = url.host
    const isWikipediaSite = config.specialSites.wikipedia.enabled &&
      config.specialSites.wikipedia.domains.some(d => targetURL.hostname.endsWith(d))

    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
      let rewriter = new HTMLRewriter()
        .on('a[href]', new LinkRewriter(targetURL, 'href', currentProxyDomain))
        .on('form[action]', new LinkRewriter(targetURL, 'action', currentProxyDomain))
        .on('img[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('img[srcset]', new SrcsetRewriter(targetURL, currentProxyDomain))
        .on('source[srcset]', new SrcsetRewriter(targetURL, currentProxyDomain))
        .on('link[href]', new LinkRewriter(targetURL, 'href', currentProxyDomain))
        .on('script[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('iframe[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('source[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('video[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('audio[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('embed[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('object[data]', new LinkRewriter(targetURL, 'data', currentProxyDomain))
        .on('track[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('meta[content]', new MetaContentRewriter(targetURL, currentProxyDomain))
        .on('base[href]', new BaseTagRewriter(targetURL, currentProxyDomain))
        .on('*[style]', new StyleAttributeRewriter(targetURL, currentProxyDomain))

      if (isWikipediaSite) {
        rewriter = rewriter.on('img[data-src]', new LinkRewriter(targetURL, 'data-src', currentProxyDomain))
                           .on('style', new StyleElementRewriter(targetURL, currentProxyDomain))
      }

      if (config.fallback.enabled && config.fallback.autoReload) {
        rewriter = rewriter.on('head', new HeadRewriter(targetURL.href))
      }

      response = rewriter.transform(response)
    }
    else if (contentType.includes('text/css') || contentType.includes('application/x-stylesheet')) {
      const cssText = await response.text()
      response = new Response(rewriteCSS(cssText, targetURL, currentProxyDomain), {
        status: response.status,
        statusText: response.statusText,
        headers: newRespHeaders
      })
    }
    else if (contentType.includes('application/javascript') || contentType.includes('text/javascript')) {
      const jsText = await response.text()
      response = new Response(rewriteJavaScript(jsText, targetURL, currentProxyDomain), {
        status: response.status,
        statusText: response.statusText,
        headers: newRespHeaders
      })
    }

    return response
  } catch (error) {
    return new Response(`Proxy Error: ${error.message}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
    })
  }
}

// -----------------------
// Rewriters and helper functions
// -----------------------

// LinkRewriter, SrcsetRewriter, MetaContentRewriter, BaseTagRewriter, StyleAttributeRewriter,
// StyleElementRewriter, HeadRewriter, rewriteCSS, rewriteJavaScript
// Use your existing implementations from the original code
// No changes needed for API functionality

function getHomePage() {
  return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Web Proxy Service</title></head><body><h1>Web Proxy</h1></body></html>`, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
  })
}
