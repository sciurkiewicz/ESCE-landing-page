import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.mjs';

const PASSWORD = 'test-only-long-password-42';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'esce-api-test-'));
  const databasePath = join(directory, 'blog.sqlite');
  const staticDirectory = join(directory, 'dist');
  const running = new Set();
  t.after(async () => {
    for (const instance of running) await instance.close();
    const actualDirectory = await realpath(directory);
    assert.equal(dirname(actualDirectory), await realpath(tmpdir()), 'Test cleanup must stay inside the temporary directory.');
    assert.ok(basename(actualDirectory).startsWith('esce-api-test-'), 'Only remove this test’s own fixture.');
    await rm(actualDirectory, { recursive: true, force: true });
  });

  async function start(overrides = {}) {
    const app = createApp({ databasePath, staticDirectory, password: PASSWORD, ...options, ...overrides });
    const server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const instance = {
      origin,
      async request(path, { method = 'GET', body, headers = {}, cookie, csrfToken, rawBody } = {}) {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: {
            ...(method !== 'GET' && method !== 'HEAD' ? { 'Content-Type': 'application/json', Origin: origin } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
            ...headers,
          },
          ...(method !== 'GET' && method !== 'HEAD' ? { body: rawBody ?? JSON.stringify(body ?? {}) } : {}),
        });
        const content = await response.text();
        return { status: response.status, headers: response.headers, text: content,
          data: content && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(content) : null };
      },
      async login() {
        const result = await instance.request('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
        assert.equal(result.status, 200);
        return { cookie: result.headers.get('set-cookie').split(';')[0], csrfToken: result.data.csrfToken, result };
      },
      async close() {
        if (!running.delete(instance)) return;
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        app.close();
      },
    };
    running.add(instance);
    return instance;
  }

  return { directory, databasePath, staticDirectory, start, ...(await start()) };
}

test('admin is disabled until a sufficiently long password is configured', async (t) => {
  const app = await fixture(t, { password: '' });
  const session = await app.request('/api/admin/session');
  assert.deepEqual(session.data, { authenticated: false, configured: false });
  const login = await app.request('/api/admin/login', { method: 'POST', body: { password: '' } });
  assert.equal(login.status, 503);
  assert.equal((await app.request('/api/admin/posts')).status, 401);
  const weak = await app.start({ password: 'short' });
  assert.equal((await weak.request('/api/admin/session')).data.configured, false);
});

test('authentication uses protected cookies and logout invalidates the server session', async (t) => {
  const app = await fixture(t, { secureCookies: true });
  assert.equal((await app.request('/api/admin/posts')).status, 401);
  assert.equal((await app.request('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  const auth = await app.login();
  const cookie = auth.result.headers.get('set-cookie');
  for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) assert.ok(cookie.includes(attribute));
  assert.ok(!cookie.includes(PASSWORD));
  assert.match(auth.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual((await app.request('/api/admin/session', auth)).data,
    { authenticated: true, configured: true, csrfToken: auth.csrfToken });
  assert.equal((await app.request('/api/admin/posts', auth)).status, 200);
  const logout = await app.request('/api/admin/logout', { method: 'POST', ...auth });
  assert.equal(logout.status, 200);
  assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal((await app.request('/api/admin/session', auth)).data.authenticated, false);
  assert.equal((await app.request('/api/admin/posts', auth)).status, 401);
});

test('drafts stay private, publishing and CRUD work, and slugs are stable and unique', async (t) => {
  const app = await fixture(t);
  const auth = await app.login();
  const original = await app.request('/api/posts');
  assert.equal(original.data.posts.length, 1);
  assert.ok(original.data.posts[0].content.includes('przykładowy wpis'));
  const created = await app.request('/api/admin/posts', {
    method: 'POST', ...auth,
    body: { title: 'Zażółć gęślą jaźń!', content: '# Pierwszy prototyp', category: 'Devlog', status: 'draft' },
  });
  assert.equal(created.status, 201);
  const post = created.data.post;
  assert.equal(post.slug, 'zazolc-gesla-jazn');
  assert.equal(post.publishedAt, null);
  assert.equal((await app.request('/api/posts')).data.posts.length, 1);
  assert.equal((await app.request(`/api/posts/${post.slug}`)).status, 404);
  assert.equal((await app.request('/api/admin/posts', auth)).data.posts.length, 2);

  const published = await app.request(`/api/admin/posts/${post.id}`, {
    method: 'PUT', ...auth, body: { title: 'Nowy tytuł', status: 'published', excerpt: 'Pierwsza aktualizacja.' },
  });
  assert.equal(published.status, 200);
  assert.equal(published.data.post.slug, post.slug);
  assert.ok(published.data.post.publishedAt);
  assert.equal((await app.request(`/api/posts/${post.slug}`)).data.post.title, 'Nowy tytuł');
  assert.equal((await app.request('/api/posts')).data.posts.length, 2);

  const duplicate = await app.request('/api/admin/posts', {
    method: 'POST', ...auth, body: { title: 'Zażółć gęślą jaźń!', content: 'Drugi wpis' },
  });
  assert.equal(duplicate.data.post.slug, `${post.slug}-2`);
  const renamed = await app.request(`/api/admin/posts/${post.id}`, {
    method: 'PUT', ...auth, body: { slug: 'Mój nowy adres', status: 'draft' },
  });
  assert.equal(renamed.data.post.slug, 'moj-nowy-adres');
  assert.equal(renamed.data.post.publishedAt, null);
  assert.equal((await app.request(`/api/posts/${post.slug}`)).status, 404);
  const deleted = await app.request(`/api/admin/posts/${post.id}`, { method: 'DELETE', ...auth });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.data, { deleted: true });
  assert.equal((await app.request(`/api/admin/posts/${post.id}`, { method: 'DELETE', ...auth })).status, 404);
});

test('posts and sessions survive a restart; changing the password revokes existing sessions', async (t) => {
  const app = await fixture(t);
  const auth = await app.login();
  const created = await app.request('/api/admin/posts', {
    method: 'POST', ...auth, body: { title: 'Trwały wpis', content: 'Zapis na dysku.', status: 'published' },
  });
  await app.close();
  const restarted = await app.start();
  assert.equal((await restarted.request(`/api/posts/${created.data.post.slug}`)).data.post.content, 'Zapis na dysku.');
  assert.equal((await restarted.request('/api/posts')).data.posts.length, 2);
  assert.equal((await restarted.request('/api/admin/session', auth)).data.authenticated, true);
  await restarted.close();
  const changedPassword = await app.start({ password: `${PASSWORD}-changed` });
  assert.equal((await changedPassword.request('/api/admin/session', auth)).data.authenticated, false);
  assert.equal((await changedPassword.request('/api/admin/posts', auth)).status, 401);
});

test('mutations reject cross-origin requests, missing CSRF, and unsupported or malformed bodies', async (t) => {
  const app = await fixture(t);
  const auth = await app.login();
  assert.equal((await app.request('/api/admin/login', {
    method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: { password: PASSWORD },
  })).status, 403);
  assert.equal((await app.request('/api/admin/posts', {
    method: 'POST', cookie: auth.cookie, body: { title: 'Brak tokena' },
  })).status, 403);
  assert.equal((await app.request('/api/admin/posts', {
    method: 'POST', ...auth, csrfToken: 'é'.repeat(43), body: { title: 'Niepoprawny token' },
  })).status, 403);
  assert.equal((await app.request('/api/admin/posts', {
    method: 'POST', ...auth, headers: { Origin: 'https://untrusted.example' },
  })).status, 403);
  assert.equal((await app.request('/api/admin/posts', {
    method: 'POST', ...auth, headers: { 'Sec-Fetch-Site': 'cross-site' },
  })).status, 403);
  assert.equal((await app.request('/api/admin/posts', {
    method: 'POST', ...auth, headers: { 'Content-Type': 'text/plain' },
  })).status, 415);
  assert.equal((await app.request('/api/admin/posts', {
    method: 'POST', ...auth, rawBody: '{bad',
  })).status, 400);
  assert.equal((await app.request('/api/admin/posts', {
    method: 'POST', ...auth, body: [],
  })).status, 400);
  assert.equal((await app.request('/api/admin/posts', {
    method: 'POST', ...auth, body: { title: 'a'.repeat(161) },
  })).status, 400);
  assert.equal((await app.request('/api/admin/posts', {
    method: 'POST', ...auth, body: { title: 'Limit', content: 'a'.repeat(100_001) },
  })).status, 400);
  assert.equal((await app.request('/api/admin/posts', {
    method: 'POST', ...auth, body: { title: 'Limit JSON', content: 'a'.repeat(600_000) },
  })).status, 413);
  assert.equal((await app.request('/api/posts/%ZZ')).status, 400);
});

test('login rate limit cannot be bypassed with forwarding headers and expires after its window', async (t) => {
  let time = Date.now();
  const app = await fixture(t, { loginMaxAttempts: 2, loginWindowMs: 10_000, now: () => time });
  for (let index = 0; index < 2; index += 1) {
    const result = await app.request('/api/admin/login', {
      method: 'POST', body: { password: 'wrong' }, headers: { 'X-Forwarded-For': `198.51.100.${index}` },
    });
    assert.equal(result.status, 401);
  }
  const limited = await app.request('/api/admin/login', {
    method: 'POST', body: { password: PASSWORD }, headers: { 'X-Forwarded-For': '203.0.113.1' },
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  time += 10_001;
  await app.login();
});

test('server sessions expire even when a client reuses an old cookie', async (t) => {
  let time = Date.now();
  const app = await fixture(t, { sessionTtlMs: 1000, now: () => time });
  const auth = await app.login();
  time += 1001;
  assert.equal((await app.request('/api/admin/session', auth)).data.authenticated, false);
  assert.equal((await app.request('/api/admin/posts', auth)).status, 401);
});

test('production files use correct MIME, security headers, and SPA fallback only on frontend routes', async (t) => {
  const app = await fixture(t);
  await mkdir(join(app.staticDirectory, 'assets'), { recursive: true });
  await writeFile(join(app.staticDirectory, 'index.html'), '<!doctype html><title>ESCE</title>');
  await writeFile(join(app.staticDirectory, 'assets', 'app-abcdefgh.js'), 'console.log("ESCE");');
  const page = await app.request('/blog/witaj-na-blogu');
  assert.equal(page.status, 200);
  assert.ok(page.headers.get('content-type').startsWith('text/html'));
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(page.headers.get('content-security-policy').includes("object-src 'none'"));
  const asset = await app.request('/assets/app-abcdefgh.js');
  assert.equal(asset.status, 200);
  assert.ok(asset.headers.get('content-type').startsWith('text/javascript'));
  assert.ok(asset.headers.get('cache-control').includes('immutable'));
  assert.equal((await app.request('/assets/missing.js')).status, 404);
  assert.equal((await app.request('/adminpanel')).status, 200);
  assert.equal((await app.request('/adminpanel/')).status, 200);
  assert.equal((await app.request('/admin')).status, 404);
  assert.equal((await app.request('/admin/')).status, 404);
  assert.equal((await app.request('/does-not-exist')).status, 404);
  assert.equal((await app.request('/.env')).status, 404);
  const apiMissing = await app.request('/api/missing');
  assert.equal(apiMissing.status, 404);
  assert.equal(typeof apiMissing.data.error, 'string');
  const head = await app.request('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
});
