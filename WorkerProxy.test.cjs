const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const vm = require('node:vm')

const source = fs.readFileSync(`${__dirname}/WorkerProxy.js`, 'utf8')

function createProxy(fetch) {
  const context = vm.createContext({
    URL, Headers, Request, Response, fetch, addEventListener() {},
  })
  vm.runInContext(source, context)
  return context.handleRequest
}

test('forwards method, body, cookies and original headers', async () => {
  const target = 'https://upstream.example/upload?existing=1'
  const routes = [
    [`https://proxy.example/proxy?url=${encodeURIComponent(target)}`, target],
  ]
  for (const [route, expectedURL] of routes) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'GET', 'HEAD']) {
      const headers = {
        Cookie: 'theme=dark; layout=compact',
        Referer: 'https://client.example/form',
        Origin: 'https://client.example',
        'User-Agent': 'OriginalClient/1.0',
        Accept: 'application/json',
        'Accept-Language': 'da-DK',
        'Content-Type': 'application/octet-stream',
        'X-Custom-Header': 'original-value',
        Host: 'proxy.example',
      }
      const body = ['GET', 'HEAD'].includes(method) ? undefined : new Uint8Array([0, 255, 13, 10, 128])
      let calls = 0
      const handleRequest = createProxy(async forwarded => {
        calls++
        assert.equal(forwarded.url, expectedURL)
        assert.equal(forwarded.method, method)
        assert.equal(forwarded.redirect, 'manual')
        for (const [name, value] of Object.entries(headers)) {
          assert.equal(forwarded.headers.get(name), name === 'Host' ? 'upstream.example' : value)
        }
        assert.deepEqual(new Uint8Array(await forwarded.arrayBuffer()), body || new Uint8Array())
        return new Response(null, { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'theme=light; Path=/' } })
      })
      const response = await handleRequest(new Request(route, { method, headers, body }))
      assert.equal(calls, 1)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('Set-Cookie'), 'theme=light; Path=/')
    }
  }
})

test('does not invent User-Agent or Referer when absent', async () => {
  const handleRequest = createProxy(async forwarded => {
    assert.equal(forwarded.headers.has('User-Agent'), false)
    assert.equal(forwarded.headers.has('Referer'), false)
    return new Response(null)
  })
  assert.equal((await handleRequest(new Request('https://proxy.example/proxy?url=https://upstream.example/'))).status, 200)
})

test('returns every redirect unchanged without invoking HTML rewriting or another fetch', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0
    const headers = new Headers({
      Location: '../next',
      'Content-Type': 'text/html',
      'Set-Cookie': 'theme=dark; Path=/',
    })
    headers.append('Set-Cookie', 'layout=compact; Path=/')
    const upstream = new Response('<html>redirect</html>', { status, headers })
    const handleRequest = createProxy(async forwarded => {
      calls++
      assert.equal(forwarded.redirect, 'manual')
      return upstream
    })
    const response = await handleRequest(new Request('https://proxy.example/proxy?url=https://upstream.example/'))
    assert.equal(calls, 1)
    assert.equal(response, upstream)
    assert.equal(response.headers.get('Location'), '../next')
    assert.deepEqual(response.headers.getSetCookie(), ['theme=dark; Path=/', 'layout=compact; Path=/'])
    assert.equal(await response.text(), '<html>redirect</html>')
  }
})

test('rejects missing and invalid target URLs without fetching', async () => {
  const handleRequest = createProxy(() => assert.fail('invalid requests must not fetch'))
  for (const route of ['/', '/proxy', '/proxy?url=invalid']) {
    assert.equal((await handleRequest(new Request(`https://proxy.example${route}`))).status, 400)
  }
})
