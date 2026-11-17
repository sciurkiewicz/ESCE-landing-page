import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createYouTubeFeed, YouTubeFeedError } from './youtube.mjs';
import { ContentValidationError, createContentStore, isContentKind } from './content.mjs';

const SESSION_COOKIE = 'esce_session';
const MAX_JSON_BYTES = 512 * 1024;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    request.resume();
    throw new HttpError(415, 'Wymagany jest format application/json.');
  }
  if (Number(request.headers['content-length']) > MAX_JSON_BYTES) {
    request.resume();
    throw new HttpError(413, 'Przesłane dane są zbyt duże.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      request.resume();
      throw new HttpError(413, 'Przesłane dane są zbyt duże.');
    }
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'Nieprawidłowy JSON.'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new HttpError(400, 'Prześlij obiekt JSON.');
  }
  return value;
}

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:", "connect-src 'self'",
    'frame-src https://www.youtube-nocookie.com https://www.youtube.com',
    "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'",
  ].join('; '));
}

function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }

function decodePath(value) {
  try { return decodeURIComponent(value); }
  catch { throw new HttpError(400, 'Nieprawidłowy adres.'); }
}

function sessionToken(request) {
  const cookie = (request.headers.cookie ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const token = cookie?.slice(SESSION_COOKIE.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function makeSlug(value) {
  return value.toLowerCase().replace(/ł/g, 'l').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 90).replace(/-+$/g, '') || 'wpis';
}

function textField(body, key, fallback, limit, required = false) {
  const value = body[key] === undefined ? fallback : body[key];
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new HttpError(400, `Nieprawidłowe pole „${key}” (maks. ${limit} znaków).`);
  }
  return key === 'content' ? value : value.trim();
}

function postFields(body, current = {}) {
  const title = textField(body, 'title', current.title ?? '', 160, true);
  const excerpt = textField(body, 'excerpt', current.excerpt ?? '', 400);
  const content = textField(body, 'content', current.content ?? '', 100_000);
  const category = textField(body, 'category', current.category ?? 'Aktualności', 48, true);
  const status = body.status ?? current.status ?? 'draft';
  if (!['draft', 'published'].includes(status)) throw new HttpError(400, 'Nieprawidłowy status wpisu.');
  if (status === 'published' && !content.trim()) throw new HttpError(400, 'Opublikowany wpis musi mieć treść.');
  if (body.slug !== undefined && (typeof body.slug !== 'string' || body.slug.length > 100 || !body.slug.trim())) {
    throw new HttpError(400, 'Nieprawidłowy adres wpisu.');
  }
  return { title, excerpt, content, category, status };
}

function serializePost(row) {
  return {
    id: row.id, slug: row.slug, title: row.title, excerpt: row.excerpt,
    content: row.content, category: row.category, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at,
  };
}

/** A dependency-free HTTP handler; call .close() after stopping the owning HTTP server. */
export function createApp({
  databasePath = resolve('data/blog.sqlite'), password = process.env.ADMIN_PASSWORD ?? '',
  secureCookies = process.env.COOKIE_SECURE === 'true' ||
    (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production'),
  staticDirectory = resolve('dist'), siteOrigin = process.env.SITE_ORIGIN,
  sessionTtlMs = 8 * 60 * 60 * 1000, loginWindowMs = 15 * 60 * 1000,
  loginMaxAttempts = 8, globalLoginMaxAttempts = 100, now = Date.now,
  youtube, youtubeFactory = createYouTubeFeed,
  youtubeChannelId = process.env.YOUTUBE_CHANNEL_ID ?? '', youtubeChannelUrl = process.env.YOUTUBE_CHANNEL_URL ?? '',
} = {}) {
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const initialized = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'posts'").get();
  database.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      excerpt TEXT NOT NULL, content TEXT NOT NULL, category TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT
    );
    CREATE INDEX IF NOT EXISTS posts_status_date ON posts(status, published_at);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS auth_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), salt TEXT NOT NULL, password_hash TEXT NOT NULL
    );
  `);
  const contentStore = createContentStore(database, { youtubeChannelId, youtubeChannelUrl, now });
  let youtubeFeed;
  let youtubeKey;
  function getYouTubeFeed() {
    if (youtube) return youtube;
    const settings = contentStore.settings();
    const key = JSON.stringify([settings.youtubeChannelId, settings.youtubeUrl]);
    if (!youtubeFeed || youtubeKey !== key) {
      youtubeFeed = youtubeFactory({ channelId: settings.youtubeChannelId, channelUrl: settings.youtubeUrl, now });
      youtubeKey = key;
    }
    return youtubeFeed;
  }
  const insertPost = database.prepare(`INSERT INTO posts
    (id, slug, title, excerpt, content, category, status, created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  if (!initialized) {
    const timestamp = new Date(now()).toISOString();
    insertPost.run(randomUUID(), 'witaj-na-blogu', 'Tu zaczyna się kolejny projekt',
      'Przykładowy wpis na dobry początek. Zajrzyj za kulisy tworzenia gier.',
      '# Witaj na blogu!\n\nTo **przykładowy wpis**, który możesz zmienić lub usunąć w panelu autora.\n\nBędzie tu miejsce na devlogi, notatki z projektów i małe odkrycia z tworzenia gier.\n\n## Od czego zacząć?\n\n- Opisz pomysł na swoją grę.\n- Pokaż pierwszy prototyp.\n- Podziel się tym, czego się uczysz.',
      'Na start', 'published', timestamp, timestamp, timestamp);
  }

  const configured = typeof password === 'string' && password.length >= 12;
  const authState = database.prepare('SELECT salt, password_hash FROM auth_state WHERE singleton = 1').get();
  const salt = authState ? Buffer.from(authState.salt, 'hex') : randomBytes(16);
  const passwordHash = configured ? scryptSync(password, salt, 64) : null;
  // Persist only a salted, slow password verifier; changing the password invalidates every old session.
  if (!configured || !authState || authState.password_hash !== passwordHash.toString('hex')) {
    database.prepare('DELETE FROM sessions').run();
    database.prepare('DELETE FROM auth_state').run();
    if (configured) database.prepare('INSERT INTO auth_state (singleton, salt, password_hash) VALUES (1, ?, ?)')
      .run(salt.toString('hex'), passwordHash.toString('hex'));
  }
  const loginBudgets = new Map();
  let globalBudget = { count: 0, resetAt: now() + loginWindowMs };
  const root = resolve(staticDirectory);
  const configuredOrigin = siteOrigin ? new URL(siteOrigin).origin : null;

  function limitLogin(request, response) {
    const time = now();
    if (globalBudget.resetAt <= time) globalBudget = { count: 0, resetAt: time + loginWindowMs };
    if (globalBudget.count >= globalLoginMaxAttempts) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil((globalBudget.resetAt - time) / 1000))));
      throw new HttpError(429, 'Za dużo prób logowania. Spróbuj ponownie później.');
    }
    // The socket address is authoritative; untrusted forwarding headers never extend this budget.
    const address = request.socket.remoteAddress ?? 'unknown';
    let budget = loginBudgets.get(address);
    if (!budget || budget.resetAt <= time) {
      budget = { count: 0, resetAt: time + loginWindowMs };
      loginBudgets.set(address, budget);
    }
    if (budget.count >= loginMaxAttempts) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil((budget.resetAt - time) / 1000))));
      throw new HttpError(429, 'Za dużo prób logowania. Spróbuj ponownie później.');
    }
    budget.count += 1;
    globalBudget.count += 1;
    if (loginBudgets.size > 1000) {
      for (const [key, entry] of loginBudgets) if (entry.resetAt <= time) loginBudgets.delete(key);
    }
  }

  function getSession(request) {
    const token = sessionToken(request);
    if (!token) return null;
    const session = database.prepare('SELECT csrf_token, expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token));
    if (!session) return null;
    if (session.expires_at <= now()) {
      database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
      return null;
    }
    return { token, csrfToken: session.csrf_token };
  }

  function requireSession(request, mutation = false) {
    const session = getSession(request);
    if (!session || !configured) throw new HttpError(401, 'Zaloguj się do panelu autora.');
    if (mutation) {
      const supplied = request.headers['x-csrf-token'];
      if (typeof supplied !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrfToken))) {
        throw new HttpError(403, 'Sesja formularza jest nieprawidłowa. Odśwież stronę i spróbuj ponownie.');
      }
    }
    return session;
  }

  function checkOrigin(request) {
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Niedozwolone źródło żądania.');
    const origin = request.headers.origin;
    const expected = configuredOrigin ?? `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host}`;
    if (origin && origin !== expected) throw new HttpError(403, 'Niedozwolone źródło żądania.');
  }

  function cookie(token, maxAge) {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  }

  function uniqueSlug(value, ownId) {
    const base = makeSlug(value);
    let slug = base;
    for (let suffix = 2; ; suffix += 1) {
      const existing = database.prepare('SELECT id FROM posts WHERE slug = ?').get(slug);
      if (!existing || existing.id === ownId) return slug;
      slug = `${base}-${suffix}`;
    }
  }

  async function handleApi(request, response, pathname) {
    response.setHeader('Cache-Control', 'no-store');
    const method = request.method;
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    if (mutation) checkOrigin(request);

    if (method === 'GET' && pathname === '/api/videos') {
      try { return json(response, 200, await getYouTubeFeed().getVideos()); }
      catch (error) {
        if (!(error instanceof YouTubeFeedError)) throw error;
        response.setHeader('Retry-After', String(error.retryAfter));
        throw new HttpError(503, error.message);
      }
    }
    if (method === 'GET' && pathname === '/api/settings') {
      return json(response, 200, { settings: contentStore.settings() });
    }
    if (pathname === '/api/admin/settings' && ['GET', 'PUT'].includes(method)) {
      requireSession(request, method === 'PUT');
      if (method === 'GET') return json(response, 200, { settings: contentStore.settings() });
      const settings = contentStore.saveSettings(await readJson(request));
      youtubeFeed = null;
      youtubeKey = null;
      return json(response, 200, { settings });
    }
    const publicContent = /^\/api\/content\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && publicContent && isContentKind(publicContent[1])) {
      return json(response, 200, { items: contentStore.list(publicContent[1], true) });
    }
    const adminContent = /^\/api\/admin\/content\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
    if (adminContent && isContentKind(adminContent[1])) {
      const kind = adminContent[1];
      const id = adminContent[2] ? decodePath(adminContent[2]) : null;
      if (method === 'GET' && !id) {
        requireSession(request);
        return json(response, 200, { items: contentStore.list(kind) });
      }
      if (method === 'POST' && !id) {
        requireSession(request, true);
        return json(response, 201, { item: contentStore.create(kind, await readJson(request)) });
      }
      if (['PUT', 'DELETE'].includes(method) && id) {
        requireSession(request, true);
        const body = await readJson(request);
        if (method === 'DELETE') {
          if (!contentStore.delete(kind, id)) throw new HttpError(404, 'Nie znaleziono materiału.');
          return json(response, 200, { deleted: true });
        }
        const item = contentStore.update(kind, id, body);
        if (!item) throw new HttpError(404, 'Nie znaleziono materiału.');
        return json(response, 200, { item });
      }
    }
    if (method === 'GET' && pathname === '/api/posts') {
      const posts = database.prepare("SELECT * FROM posts WHERE status = 'published' ORDER BY published_at DESC, created_at DESC").all();
      return json(response, 200, { posts: posts.map(serializePost) });
    }
    if (method === 'GET' && /^\/api\/posts\/[^/]+$/.test(pathname)) {
      const slug = decodePath(pathname.split('/').at(-1));
      const post = database.prepare("SELECT * FROM posts WHERE slug = ? AND status = 'published'").get(slug);
      if (!post) throw new HttpError(404, 'Nie znaleziono wpisu.');
      return json(response, 200, { post: serializePost(post) });
    }
    if (method === 'GET' && pathname === '/api/admin/session') {
      const session = configured ? getSession(request) : null;
      return json(response, 200, { authenticated: Boolean(session), configured, ...(session ? { csrfToken: session.csrfToken } : {}) });
    }
    if (method === 'POST' && pathname === '/api/admin/login') {
      if (!configured) throw new HttpError(503, 'Panel wymaga ustawienia ADMIN_PASSWORD (minimum 12 znaków).');
      limitLogin(request, response);
      const body = await readJson(request);
      const supplied = body.password;
      if (typeof supplied !== 'string' || supplied.length > 1024 ||
          !timingSafeEqual(scryptSync(supplied, salt, 64), passwordHash)) {
        throw new HttpError(401, 'Nieprawidłowe hasło.');
      }
      const oldToken = sessionToken(request);
      if (oldToken) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(oldToken));
      database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      database.prepare('INSERT INTO sessions (token_hash, csrf_token, expires_at) VALUES (?, ?, ?)')
        .run(hashToken(token), csrfToken, now() + sessionTtlMs);
      return json(response, 200, { authenticated: true, csrfToken }, { 'Set-Cookie': cookie(token, Math.floor(sessionTtlMs / 1000)) });
    }
    if (method === 'POST' && pathname === '/api/admin/logout') {
      const session = requireSession(request, true);
      await readJson(request);
      database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(session.token));
      return json(response, 200, { authenticated: false }, { 'Set-Cookie': cookie('', 0) });
    }
    if (method === 'GET' && pathname === '/api/admin/posts') {
      requireSession(request);
      const posts = database.prepare('SELECT * FROM posts ORDER BY updated_at DESC, created_at DESC').all();
      return json(response, 200, { posts: posts.map(serializePost) });
    }
    if (method === 'POST' && pathname === '/api/admin/posts') {
      requireSession(request, true);
      const body = await readJson(request);
      const fields = postFields(body);
      const id = randomUUID();
      const slug = uniqueSlug(body.slug ?? fields.title);
      const timestamp = new Date(now()).toISOString();
      insertPost.run(id, slug, fields.title, fields.excerpt, fields.content, fields.category,
        fields.status, timestamp, timestamp, fields.status === 'published' ? timestamp : null);
      const post = serializePost(database.prepare('SELECT * FROM posts WHERE id = ?').get(id));
      return json(response, 201, { post });
    }
    if (['PUT', 'DELETE'].includes(method) && /^\/api\/admin\/posts\/[^/]+$/.test(pathname)) {
      requireSession(request, true);
      const id = decodePath(pathname.split('/').at(-1));
      const row = database.prepare('SELECT * FROM posts WHERE id = ?').get(id);
      if (!row) throw new HttpError(404, 'Nie znaleziono wpisu.');
      const body = await readJson(request);
      if (method === 'DELETE') {
        database.prepare('DELETE FROM posts WHERE id = ?').run(id);
        return json(response, 200, { deleted: true });
      }
      const current = serializePost(row);
      const fields = postFields(body, current);
      const slug = body.slug === undefined ? current.slug : uniqueSlug(body.slug, id);
      const timestamp = new Date(now()).toISOString();
      const publishedAt = fields.status === 'published' ? current.publishedAt ?? timestamp : null;
      database.prepare(`UPDATE posts SET slug = ?, title = ?, excerpt = ?, content = ?, category = ?,
        status = ?, updated_at = ?, published_at = ? WHERE id = ?`)
        .run(slug, fields.title, fields.excerpt, fields.content, fields.category, fields.status, timestamp, publishedAt, id);
      return json(response, 200, { post: serializePost(database.prepare('SELECT * FROM posts WHERE id = ?').get(id)) });
    }
    throw new HttpError(404, 'Nie znaleziono takiego endpointu.');
  }

  function serveFrontend(request, response, pathname) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Niedozwolona metoda.');
    const decoded = decodePath(pathname);
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some((part) => part.startsWith('.'))) {
      throw new HttpError(404, 'Nie znaleziono pliku.');
    }
    let filename = resolve(root, `.${decoded}`);
    if (filename !== root && !filename.startsWith(root + sep)) throw new HttpError(404, 'Nie znaleziono pliku.');
    let stats;
    try { stats = statSync(filename); } catch { /* A known frontend route may use the SPA shell. */ }
    if (!stats?.isFile()) {
      const frontendRoute = /^\/(?:|(?:o-mnie|about|filmy|videos|projekty|projects|kontakt|contact|narzedzia|tools)\/?|(?:blog|adminpanel)(?:\/[a-zA-Z0-9_-]+)*\/?)$/;
      if (!frontendRoute.test(decoded)) throw new HttpError(404, 'Nie znaleziono strony.');
      filename = resolve(root, 'index.html');
      if (!existsSync(filename)) throw new HttpError(503, 'Najpierw zbuduj stronę poleceniem npm run build.');
      stats = statSync(filename);
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': /[.-][a-zA-Z0-9_-]{8,}\.(?:js|css|woff2?|png|webp|avif)$/.test(filename)
        ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (request.method === 'HEAD') return response.end();
    const stream = createReadStream(filename);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }

  const handler = async (request, response) => {
    securityHeaders(response);
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/api' || pathname.startsWith('/api/')) await handleApi(request, response, pathname);
      else serveFrontend(request, response, pathname);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      const publicError = error instanceof HttpError || error instanceof ContentValidationError;
      if (!publicError) console.error('Request failed:', error);
      json(response, publicError ? error.status : 500, {
        error: publicError ? error.message : 'Wystąpił błąd serwera. Spróbuj ponownie.',
      });
    }
  };
  handler.close = () => database.close();
  return handler;
}
