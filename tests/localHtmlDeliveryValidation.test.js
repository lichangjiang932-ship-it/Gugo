import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { validateLocalHtmlDelivery } from '../server/services/localHtmlDeliveryValidation.js'
import { localFileMimeType } from '../server/services/verifiedLocalFileService.js'

function temporarySite() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-local-html-delivery-'))
}

function write(root, relativePath, content) {
  const fullPath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content)
  return fullPath
}

test('local HTML delivery validates nested CSS, scripts, data, and decodable background images', async () => {
  const root = temporarySite()
  try {
    const htmlPath = write(root, 'index.html', `<!doctype html>
      <html><head><link rel="stylesheet" href="assets/site.css"></head>
      <body><main>Complete</main><script type="module" src="assets/app.js"></script></body></html>`)
    write(root, 'assets/site.css', '@import "theme.css"; body { background-image: url("../images/hero.png"); }')
    write(root, 'assets/theme.css', 'main { color: white; }')
    write(root, 'assets/app.js', 'import "./module.js"; fetch("../data/config.json");')
    write(root, 'assets/module.js', 'export const ready = true;')
    write(root, 'data/config.json', '{"ready":true}')
    const imagePath = path.join(root, 'images', 'hero.png')
    fs.mkdirSync(path.dirname(imagePath), { recursive: true })
    await sharp({ create: { width: 8, height: 8, channels: 4, background: '#2450ff' } }).png().toFile(imagePath)

    const result = await validateLocalHtmlDelivery({ filePath: htmlPath })
    assert.equal(result.ok, true)
    assert.equal(result.decodedImageCount, 1)
    assert.deepEqual(
      result.resources.map((resource) => path.relative(root, resource.path)).sort(),
      [
        path.join('assets', 'app.js'),
        path.join('assets', 'module.js'),
        path.join('assets', 'site.css'),
        path.join('assets', 'theme.css'),
        path.join('data', 'config.json'),
        path.join('images', 'hero.png'),
      ].sort(),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local HTML delivery rejects missing CSS backgrounds and corrupt image bytes', async () => {
  const root = temporarySite()
  try {
    const htmlPath = write(root, 'index.html', '<!doctype html><style>body{background:url("images/missing.jpg")}</style><main>Page</main>')
    await assert.rejects(
      validateLocalHtmlDelivery({ filePath: htmlPath }),
      (error) => error?.code === 'HTML_DELIVERY_RESOURCE_MISSING'
        && error?.reference === 'images/missing.jpg',
    )

    write(root, 'images/missing.jpg', 'not a JPEG')
    await assert.rejects(
      validateLocalHtmlDelivery({ filePath: htmlPath }),
      (error) => error?.code === 'HTML_DELIVERY_IMAGE_INVALID'
        && error?.reference === 'images/missing.jpg',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local HTML delivery rejects resources outside the preview directory', async () => {
  const parent = temporarySite()
  const root = path.join(parent, 'site')
  fs.mkdirSync(root)
  try {
    write(parent, 'portrait.jpg', 'outside')
    const htmlPath = write(root, 'index.html', '<!doctype html><body style="background:url(../portrait.jpg)">Page</body>')
    await assert.rejects(
      validateLocalHtmlDelivery({ filePath: htmlPath }),
      (error) => error?.code === 'HTML_DELIVERY_RESOURCE_OUTSIDE_ROOT'
        && error?.reference === '../portrait.jpg',
    )
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('local HTML delivery can validate complete readback text when a mocked executor has no disk file', async () => {
  const root = temporarySite()
  try {
    const result = await validateLocalHtmlDelivery({
      filePath: path.join(root, 'mocked.html'),
      source: '<!doctype html><html><body><main>Verified readback</main></body></html>',
    })
    assert.equal(result.ok, true)
    assert.equal(result.resourceCount, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local HTML delivery authorizes every filesystem read step and preserves authorization errors', async () => {
  const root = temporarySite()
  try {
    const htmlPath = write(root, 'index.html', '<!doctype html><link rel="stylesheet" href="assets/site.css"><main>Page</main>')
    write(root, 'assets/site.css', 'main { color: rebeccapurple; }')
    const calls = []

    const result = await validateLocalHtmlDelivery({
      filePath: htmlPath,
      resolveReadPath(candidate, context) {
        calls.push([path.relative(root, candidate), context.operation, context.role])
        return { fullPath: candidate }
      },
    })

    assert.equal(result.ok, true)
    assert.deepEqual(calls, [
      ['index.html', 'realpath', 'entry'],
      ['index.html', 'readFile', 'entry'],
      [path.join('assets', 'site.css'), 'realpath', 'dependency'],
      [path.join('assets', 'site.css'), 'stat', 'dependency'],
      [path.join('assets', 'site.css'), 'readFile', 'dependency'],
    ])

    const denial = Object.assign(new Error('grant revoked'), {
      code: 'PATH_NOT_AUTHORIZED',
      statusCode: 403,
    })
    await assert.rejects(
      validateLocalHtmlDelivery({
        filePath: htmlPath,
        resolveReadPath(candidate, context) {
          if (context.role === 'dependency') throw denial
          return candidate
        },
      }),
      (error) => error === denial,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local HTML delivery rejects remote resources while allowing data and blob references', async () => {
  const root = temporarySite()
  try {
    const remoteCases = [
      ['https.html', '<img src="https://example.test/image.png">', 'https://example.test/image.png'],
      ['http.html', '<style>.hero{background-image:image-set("http://example.test/hero.png" 1x)}</style>', 'http://example.test/hero.png'],
      ['protocol-relative.html', '<script>fetch("//example.test/config.json")</script>', '//example.test/config.json'],
    ]
    for (const [filename, body, reference] of remoteCases) {
      const htmlPath = write(root, filename, `<!doctype html><main>Page</main>${body}`)
      await assert.rejects(
        validateLocalHtmlDelivery({ filePath: htmlPath, decodeImages: false, remoteImageOrigins: [] }),
        (error) => error?.code === 'HTML_DELIVERY_REMOTE_RESOURCE_UNSUPPORTED'
          && error?.reference === reference,
      )
    }

    const allowedPath = write(root, 'allowed.html', `<!doctype html><main>Page</main>
      <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">
      <script>fetch("blob:https://example.test/opaque-id")</script>`)
    const result = await validateLocalHtmlDelivery({ filePath: allowedPath })
    assert.equal(result.resourceCount, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local HTML delivery allows only explicitly trusted HTTPS image origins', async () => {
  const root = temporarySite()
  try {
    const allowedPath = write(root, 'trusted-images.html', `<!doctype html><main>Gallery</main>
      <img src="https://images.example.test/hero.png">
      <picture><source srcset="https://images.example.test/hero@2x.png 2x"><img src="data:image/gif;base64,AAAA"></picture>
      <video poster="https://images.example.test/poster.jpg"></video>`)
    const result = await validateLocalHtmlDelivery({
      filePath: allowedPath,
      remoteImageOrigins: ['https://images.example.test'],
    })
    assert.equal(result.resourceCount, 0)

    const rejected = [
      '<img src="http://images.example.test/insecure.png">',
      '<img src="https://other.example.test/image.png">',
      '<script>fetch("https://images.example.test/data.json")</script>',
      '<link rel="stylesheet" href="https://images.example.test/site.css">',
      '<iframe src="https://images.example.test/page.html"></iframe>',
    ]
    for (const [index, body] of rejected.entries()) {
      const htmlPath = write(root, `rejected-${index}.html`, `<!doctype html><main>Page</main>${body}`)
      await assert.rejects(
        validateLocalHtmlDelivery({
          filePath: htmlPath,
          decodeImages: false,
          remoteImageOrigins: ['https://images.example.test'],
        }),
        (error) => error?.code === 'HTML_DELIVERY_REMOTE_RESOURCE_UNSUPPORTED',
      )
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local HTML delivery discovers SVG use, image-set, workers, XHR, and executable inline script references', async () => {
  const root = temporarySite()
  try {
    const htmlPath = write(root, 'index.html', `<!doctype html><html><head>
      <style>
        .modern { background-image: image-set("images/one.png" 1x, 'images/two.png' 2x); }
        .legacy { background-image: -webkit-image-set(url("images/three.png") 1x, "images/four.png" 2x); }
      </style>
      </head><body><main>Page</main>
      <svg xmlns:xlink="http://www.w3.org/1999/xlink">
        <use href="icons/sprite.svg#check"></use>
        <use xlink:href="icons/legacy.svg#check"></use>
      </svg>
      <script type="module">
        fetch(\`data/fetch.json\`);
        import(\`scripts/lazy.js\`);
        new URL(\`data/asset.bin\`, import.meta.url);
        new Worker(\`scripts/worker.js\`);
        new SharedWorker('scripts/shared-worker.js');
        xhr.open(\`GET\`, \`data/get.json\`);
        xhr.open('HEAD', 'data/head.json');
      </script>
      <script type="application/json">fetch("ignored/json.json")</script>
      <script type="application/ld+json">fetch("ignored/ld-json.json")</script>
      <script type="importmap">fetch("ignored/importmap.json")</script>
      </body></html>`)

    const resources = [
      'icons/sprite.svg',
      'icons/legacy.svg',
      'images/one.png',
      'images/two.png',
      'images/three.png',
      'images/four.png',
      'data/fetch.json',
      'data/asset.bin',
      'data/get.json',
      'data/head.json',
      'data/worker.json',
      'scripts/lazy.js',
      'scripts/worker.js',
      'scripts/shared-worker.js',
    ]
    for (const resource of resources) {
      const content = resource === 'scripts/worker.js'
        ? 'fetch("../data/worker.json");'
        : resource.endsWith('.js') ? 'export const ready = true;' : 'content'
      write(root, resource, content)
    }

    const result = await validateLocalHtmlDelivery({ filePath: htmlPath, decodeImages: false })
    assert.deepEqual(
      result.resources.map((resource) => path.relative(root, resource.path)).sort(),
      resources.map((resource) => path.normalize(resource)).sort(),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local HTML delivery discovers statically declared DOM resource properties without treating names as resources', async () => {
  const root = temporarySite()
  try {
    const htmlPath = write(root, 'index.html', `<!doctype html><main>Gallery</main><script>
      const poster = 'images/poster.png';
      const srcset = 'images/one.png 1x, images/two.png 2x';
      const images = [
        { src: 'images/one.png', name: 'missing-name-only.jpg' },
        { src: \`images/two.png\`, name: 'another-missing-name.jpg' },
      ];
      const direct = 'images/direct.png';
      image.src = direct;
      const preload = new Image();
      preload.src = 'images/preload.png';
      video.poster = poster;
      picture.srcset = srcset;
      image.setAttribute('src', 'images/attribute.png');
    </script>`)
    for (const filename of ['one.png', 'two.png', 'direct.png', 'preload.png', 'poster.png', 'attribute.png']) {
      const imagePath = path.join(root, 'images', filename)
      fs.mkdirSync(path.dirname(imagePath), { recursive: true })
      await sharp({ create: { width: 4, height: 4, channels: 4, background: '#4070ec' } }).png().toFile(imagePath)
    }

    const result = await validateLocalHtmlDelivery({ filePath: htmlPath })
    assert.equal(result.decodedImageCount, 6)
    assert.deepEqual(
      result.resources.map((resource) => path.relative(root, resource.path)).sort(),
      ['attribute.png', 'direct.png', 'one.png', 'poster.png', 'preload.png', 'two.png']
        .map((filename) => path.join('images', filename)).sort(),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local HTML delivery resolves const values within lexical scope and before their use only', async () => {
  const root = temporarySite()
  try {
    const htmlPath = write(root, 'scopes.html', `<!doctype html><main>Scoped gallery</main><script>
      const asset = 'images/shown.png';
      function unused() {
        const asset = 'images/unused-secret.png';
        return asset;
      }
      cover.src = asset;

      function renderInner() {
        const asset = 'images/inner.png';
        portrait.src = asset;
      }

      function firstSibling() {
        const sibling = 'images/first.png';
        first.src = sibling;
      }
      function secondSibling() {
        const sibling = 'images/second.png';
        second.src = sibling;
      }

      beforeDeclaration.src = lateAsset;
      const lateAsset = 'images/tdz-secret.png';
    </script>`)
    const expected = ['shown.png', 'inner.png', 'first.png', 'second.png']
    const excluded = ['unused-secret.png', 'tdz-secret.png']
    for (const filename of [...expected, ...excluded]) {
      const imagePath = path.join(root, 'images', filename)
      fs.mkdirSync(path.dirname(imagePath), { recursive: true })
      await sharp({ create: { width: 4, height: 4, channels: 4, background: '#4070ec' } }).png().toFile(imagePath)
    }

    const result = await validateLocalHtmlDelivery({ filePath: htmlPath })
    assert.equal(result.decodedImageCount, expected.length)
    assert.deepEqual(
      result.resources.map((resource) => path.relative(root, resource.path)).sort(),
      expected.map((filename) => path.join('images', filename)).sort(),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local HTML delivery ignores non-resource object metadata and business URLs', async () => {
  const root = temporarySite()
  try {
    const htmlPath = write(root, 'index.html', `<!doctype html><main>Dashboard</main><script>
      const records = [{
        data: 'sales',
        href: '#section',
        src: 'customer avatar',
        srcset: 'small medium',
        poster: 'summer campaign',
      }, {
        data: 'https://api.example.com/sales',
        href: 'https://business.example.com/report',
        src: 'https://cdn.example.com/avatar',
      }];
      const image = new Image();
      image.src = 'images/real.png';
    </script>`)
    const imagePath = path.join(root, 'images', 'real.png')
    fs.mkdirSync(path.dirname(imagePath), { recursive: true })
    await sharp({ create: { width: 4, height: 4, channels: 4, background: '#4070ec' } }).png().toFile(imagePath)

    const result = await validateLocalHtmlDelivery({ filePath: htmlPath })
    assert.equal(result.resourceCount, 1)
    assert.equal(result.decodedImageCount, 1)
    assert.equal(path.relative(root, result.resources[0].path), path.join('images', 'real.png'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local HTML delivery accepts file-shaped values for every supported object resource property', async () => {
  const root = temporarySite()
  try {
    const htmlPath = write(root, 'index.html', `<!doctype html><main>Resources</main><script>
      const resources = {
        src: 'images/source.png?size=large',
        srcset: 'images/one.png 1x, images/two.png 2x',
        poster: 'images/poster.png',
        href: 'pages/help.html#usage',
        data: 'data/report.json',
      };
    </script>`)
    for (const filename of ['source.png', 'one.png', 'two.png', 'poster.png']) {
      const imagePath = path.join(root, 'images', filename)
      fs.mkdirSync(path.dirname(imagePath), { recursive: true })
      await sharp({ create: { width: 4, height: 4, channels: 4, background: '#4070ec' } }).png().toFile(imagePath)
    }
    write(root, 'pages/help.html', '<!doctype html><title>Help</title>')
    write(root, 'data/report.json', '{"ok":true}')

    const result = await validateLocalHtmlDelivery({ filePath: htmlPath })
    assert.equal(result.resourceCount, 6)
    assert.equal(result.decodedImageCount, 4)
    assert.deepEqual(
      result.resources.map((resource) => path.relative(root, resource.path)).sort(),
      [
        'data/report.json',
        'images/one.png',
        'images/poster.png',
        'images/source.png',
        'images/two.png',
        'pages/help.html',
      ].map((filename) => path.normalize(filename)).sort(),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local HTML delivery still rejects remote DOM assignments and setAttribute calls', async () => {
  const root = temporarySite()
  try {
    const assignmentPath = write(root, 'assignment.html', `<!doctype html><main>Remote</main><script>
      const image = new Image();
      image.src = 'https://cdn.example.com/image.png';
    </script>`)
    await assert.rejects(
      validateLocalHtmlDelivery({ filePath: assignmentPath }),
      (error) => error?.code === 'HTML_DELIVERY_REMOTE_RESOURCE_UNSUPPORTED',
    )

    const attributePath = write(root, 'attribute.html', `<!doctype html><main>Remote</main><script>
      image.setAttribute('src', 'https://cdn.example.com/image.png');
    </script>`)
    await assert.rejects(
      validateLocalHtmlDelivery({ filePath: attributePath }),
      (error) => error?.code === 'HTML_DELIVERY_REMOTE_RESOURCE_UNSUPPORTED',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local HTML delivery extracts static script resources without executing user code', async () => {
  const root = temporarySite()
  try {
    const htmlPath = write(root, 'index.html', `<!doctype html><main>Gallery</main><script>
      document.documentElement.remove();
      const image = { src: 'images/one.png' };
    </script>`)
    const imagePath = path.join(root, 'images', 'one.png')
    fs.mkdirSync(path.dirname(imagePath), { recursive: true })
    await sharp({ create: { width: 4, height: 4, channels: 4, background: '#4070ec' } }).png().toFile(imagePath)

    const result = await validateLocalHtmlDelivery({ filePath: htmlPath })
    assert.equal(result.resourceCount, 1)
    assert.equal(result.decodedImageCount, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local HTML delivery rejects missing or escaping static DOM resources but ignores computed unknown values', async () => {
  const root = temporarySite()
  const parent = path.dirname(root)
  try {
    const missingPath = write(root, 'missing.html', `<!doctype html><main>Gallery</main>
      <script>const images = [{ src: 'images/missing.png', name: 'caption.png' }];</script>`)
    await assert.rejects(
      validateLocalHtmlDelivery({ filePath: missingPath }),
      (error) => error?.code === 'HTML_DELIVERY_RESOURCE_MISSING'
        && error?.reference === 'images/missing.png',
    )

    const outsideName = `${path.basename(root)}-outside.png`
    write(parent, outsideName, 'outside')
    const escapingPath = write(root, 'escaping.html', `<!doctype html><main>Gallery</main>
      <script>const image = { src: '../${outsideName}' };</script>`)
    await assert.rejects(
      validateLocalHtmlDelivery({ filePath: escapingPath, decodeImages: false }),
      (error) => error?.code === 'HTML_DELIVERY_RESOURCE_OUTSIDE_ROOT',
    )

    write(root, 'secret.png', 'not exposed')
    const computedPath = write(root, 'computed.html', `<!doctype html><main>Gallery</main>
      <script>const image = { src: chooseAtRuntime('secret.png'), name: 'secret.png' };</script>`)
    const computed = await validateLocalHtmlDelivery({ filePath: computedPath, decodeImages: false })
    assert.equal(computed.resourceCount, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(path.join(parent, `${path.basename(root)}-outside.png`), { force: true })
  }
})

test('local file MIME mapping serves CommonJS as JavaScript', () => {
  assert.equal(localFileMimeType('worker.cjs'), 'text/javascript; charset=utf-8')
})
