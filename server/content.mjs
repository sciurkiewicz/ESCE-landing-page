import { randomUUID } from 'node:crypto';
import { normalizeYouTubeChannel } from './youtube.mjs';

const CONTENT_KINDS = ['projects', 'tools', 'videos'];
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export class ContentValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

export function isContentKind(value) { return CONTENT_KINDS.includes(value); }

function field(body, key, fallback, maximum, required = false, preserveWhitespace = false) {
  const value = body[key] === undefined ? fallback : body[key];
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) {
    throw new ContentValidationError(`Nieprawidłowe pole „${key}” (maks. ${maximum} znaków).`);
  }
  return preserveWhitespace ? value : value.trim();
}

function address(value, label, local = false) {
  if (!value) return '';
  if (/[\u0000-\u0020\u007f\\]/.test(value)) throw new ContentValidationError(`Nieprawidłowy adres w polu „${label}”.`);
  if (local && /^\/(?!\/)/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048) return url.href;
  } catch { /* Return a field-specific validation error below. */ }
  throw new ContentValidationError(`Pole „${label}” wymaga adresu HTTPS${local ? ' lub ścieżki zaczynającej się od /' : ''}.`);
}

function isYouTubeVideo(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    if (url.pathname === '/watch') return url.searchParams.getAll('v').length === 1 && VIDEO_ID.test(url.searchParams.get('v'));
    return /^\/shorts\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname);
  }
  return url.hostname === 'youtu.be' && /^\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname);
}

function itemFields(body, kind, current = {}) {
  const title = field(body, 'title', current.title ?? '', 160, true);
  const description = field(body, 'description', current.description ?? '', 4000);
  const url = address(field(body, 'url', current.url ?? '', 2048), 'url', true);
  const image = address(field(body, 'image', current.image ?? '', 2048), 'image', true);
  const category = field(body, 'category', current.category ?? '', 80);
  const status = body.status === undefined ? current.status ?? 'draft' : body.status;
  if (!['draft', 'published'].includes(status)) throw new ContentValidationError('Nieprawidłowy status materiału.');
  if (kind === 'videos' && status === 'published' && !isYouTubeVideo(url)) {
    throw new ContentValidationError('Opublikowany film wymaga poprawnego adresu YouTube: watch, shorts lub youtu.be.');
  }
  return { title, description, url, image, category, status };
}

function serialize(row) {
  return { id: row.id, kind: row.kind, title: row.title, description: row.description,
    url: row.url, image: row.image, category: row.category, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export function createContentStore(database, { youtubeChannelId = '', youtubeChannelUrl = '', now = Date.now } = {}) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS content_items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('projects', 'tools', 'videos')),
      title TEXT NOT NULL, description TEXT NOT NULL, url TEXT NOT NULL, image TEXT NOT NULL,
      category TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS content_kind_status_date ON content_items(kind, status, updated_at);
    CREATE TABLE IF NOT EXISTS site_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), settings TEXT NOT NULL
    );
  `);
  const initialSettings = { siteName: 'ESCE', email: '', youtubeUrl: youtubeChannelUrl.trim(),
    youtubeChannelId: youtubeChannelId.trim(), githubUrl: '', discordUrl: '', about: '' };
  const findItem = database.prepare('SELECT * FROM content_items WHERE kind = ? AND id = ?');

  function settings() {
    const row = database.prepare('SELECT settings FROM site_settings WHERE singleton = 1').get();
    return row ? { ...initialSettings, ...JSON.parse(row.settings) } : { ...initialSettings };
  }

  function saveSettings(body) {
    const current = settings();
    const siteName = field(body, 'siteName', current.siteName, 60, true);
    const email = field(body, 'email', current.email, 254);
    if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new ContentValidationError('Nieprawidłowy adres e-mail.');
    let youtubeUrl = field(body, 'youtubeUrl', current.youtubeUrl, 2048);
    const youtubeChannelId = field(body, 'youtubeChannelId', current.youtubeChannelId, 24);
    if (youtubeChannelId && !CHANNEL_ID.test(youtubeChannelId)) throw new ContentValidationError('Nieprawidłowy identyfikator kanału YouTube.');
    if (youtubeUrl) {
      try { youtubeUrl = normalizeYouTubeChannel('', youtubeUrl).url; }
      catch { throw new ContentValidationError('Nieprawidłowy adres kanału YouTube. Podaj adres /@nazwa lub /channel/UC….'); }
    }
    const githubUrl = address(field(body, 'githubUrl', current.githubUrl, 2048), 'githubUrl');
    const discordUrl = address(field(body, 'discordUrl', current.discordUrl, 2048), 'discordUrl');
    const about = field(body, 'about', current.about, 30_000, false, true);
    const next = { siteName, email, youtubeUrl, youtubeChannelId, githubUrl, discordUrl, about };
    database.prepare(`INSERT INTO site_settings (singleton, settings) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET settings = excluded.settings`).run(JSON.stringify(next));
    return next;
  }

  return {
    settings, saveSettings,
    list(kind, publishedOnly = false) {
      const rows = publishedOnly
        ? database.prepare("SELECT * FROM content_items WHERE kind = ? AND status = 'published' ORDER BY updated_at DESC, id DESC").all(kind)
        : database.prepare('SELECT * FROM content_items WHERE kind = ? ORDER BY updated_at DESC, id DESC').all(kind);
      return rows.map(serialize);
    },
    create(kind, body) {
      const item = itemFields(body, kind);
      const id = randomUUID();
      const timestamp = new Date(now()).toISOString();
      database.prepare(`INSERT INTO content_items (id, kind, title, description, url, image, category, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, kind, item.title, item.description, item.url,
        item.image, item.category, item.status, timestamp, timestamp);
      return serialize(findItem.get(kind, id));
    },
    update(kind, id, body) {
      const row = findItem.get(kind, id);
      if (!row) return null;
      const item = itemFields(body, kind, serialize(row));
      database.prepare(`UPDATE content_items SET title = ?, description = ?, url = ?, image = ?, category = ?,
        status = ?, updated_at = ? WHERE kind = ? AND id = ?`).run(item.title, item.description, item.url,
        item.image, item.category, item.status, new Date(now()).toISOString(), kind, id);
      return serialize(findItem.get(kind, id));
    },
    delete(kind, id) {
      return database.prepare('DELETE FROM content_items WHERE kind = ? AND id = ?').run(kind, id).changes > 0;
    },
  };
}
