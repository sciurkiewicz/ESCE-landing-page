const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const FEED_LIMIT = 512 * 1024;
const PAGE_LIMIT = 4 * 1024 * 1024;
const CONFIG_ERROR = 'Nieprawidłowa konfiguracja YouTube. Ustaw identyfikator kanału UC… lub adres https://www.youtube.com/@nazwa.';
const UPSTREAM_ERROR = 'Nie udało się pobrać najnowszych filmów z YouTube. Spróbuj ponownie później.';

export class YouTubeFeedError extends Error {
  constructor(message, retryAfter = 60) {
    super(message);
    this.name = 'YouTubeFeedError';
    this.retryAfter = retryAfter;
  }
}

export function normalizeYouTubeChannel(idValue, urlValue) {
  if (typeof idValue !== 'string' || typeof urlValue !== 'string') throw new YouTubeFeedError(CONFIG_ERROR);
  const id = idValue.trim();
  const address = urlValue.trim();
  if (id) {
    if (!CHANNEL_ID.test(id)) throw new YouTubeFeedError(CONFIG_ERROR);
    return { id, url: `https://www.youtube.com/channel/${id}` };
  }
  if (!address) return null;
  let url;
  try { url = new URL(address); } catch { throw new YouTubeFeedError(CONFIG_ERROR); }
  if (url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com'].includes(url.hostname) ||
      url.username || url.password || url.port) throw new YouTubeFeedError(CONFIG_ERROR);
  let path;
  try { path = decodeURIComponent(url.pathname).replace(/\/$/, ''); }
  catch { throw new YouTubeFeedError(CONFIG_ERROR); }
  const match = /^\/channel\/(UC[A-Za-z0-9_-]{22})$/.exec(path);
  if (match) return { id: match[1], url: `https://www.youtube.com/channel/${match[1]}` };
  if (!/^\/@[\p{L}\p{M}\p{N}_.·-]{1,100}$/u.test(path)) throw new YouTubeFeedError(CONFIG_ERROR);
  // Construct every request URL ourselves; tracking parameters and fragments are discarded.
  return { id: null, url: new URL(path, 'https://www.youtube.com').href };
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity, name) => {
    if (named[name]) return named[name];
    const code = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff && (code >= 0x20 || [9, 10, 13].includes(code)) &&
      !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
  });
}

function xmlText(value) {
  let text = '';
  let offset = 0;
  for (const match of value.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
    text += decodeEntities(value.slice(offset, match.index)) + match[1];
    offset = match.index + match[0].length;
  }
  return (text + decodeEntities(value.slice(offset))).trim();
}

function tagValue(source, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`).exec(source);
  return match ? xmlText(match[1]) : '';
}

function parseFeed(source, channelId) {
  // Only the canonical, bounded YouTube Atom feed is supported. DTDs/entities are never expanded.
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new YouTubeFeedError(UPSTREAM_ERROR);
  const xml = source.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!/^(?:<\?xml[^?]*\?>\s*)?<feed(?:\s[^>]*)?>[\s\S]*<\/feed>\s*$/.test(xml)) {
    throw new YouTubeFeedError(UPSTREAM_ERROR);
  }
  const header = xml.split(/<entry(?:\s|>)/, 1)[0];
  if (tagValue(header, 'yt:channelId') !== channelId) throw new YouTubeFeedError(UPSTREAM_ERROR);
  const videos = new Map();
  const entries = /<entry(?:\s[^>]*)?>/g;
  for (let match; (match = entries.exec(xml));) {
    const end = xml.indexOf('</entry>', entries.lastIndex);
    if (end === -1) throw new YouTubeFeedError(UPSTREAM_ERROR);
    const entry = xml.slice(entries.lastIndex, end);
    if (/<entry(?:\s|>)/.test(entry)) throw new YouTubeFeedError(UPSTREAM_ERROR);
    entries.lastIndex = end + '</entry>'.length;
    const id = tagValue(entry, 'yt:videoId');
    const title = tagValue(entry, 'title');
    const published = tagValue(entry, 'published');
    const entryChannel = tagValue(entry, 'yt:channelId');
    if (!VIDEO_ID.test(id) || !title || title.length > 500 || (entryChannel && entryChannel !== channelId) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(published)) continue;
    const date = new Date(published);
    if (!Number.isFinite(date.getTime()) || (videos.has(id) && Date.parse(videos.get(id).publishedAt) >= date.getTime())) continue;
    videos.set(id, {
      id, title, publishedAt: date.toISOString(),
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${id}`,
    });
  }
  return [...videos.values()].sort((left, right) =>
    Date.parse(right.publishedAt) - Date.parse(left.publishedAt) || left.id.localeCompare(right.id)).slice(0, 9);
}

function metadataObject(html) {
  const marker = /"channelMetadataRenderer"\s*:\s*\{/.exec(html);
  if (!marker) return null;
  const start = marker.index + marker[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < Math.min(html.length, start + 40_000); index += 1) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}

function resolveChannelId(html) {
  const metadata = metadataObject(html);
  if (CHANNEL_ID.test(metadata?.externalId ?? '')) return metadata.externalId;
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = {};
    for (const attribute of match[0].matchAll(/\b(rel|href)\s*=\s*(["'])([\s\S]*?)\2/gi)) {
      attributes[attribute[1].toLowerCase()] = decodeEntities(attribute[3]);
    }
    if (!attributes.rel?.toLowerCase().split(/\s+/).includes('canonical') || !attributes.href) continue;
    try {
      const config = normalizeYouTubeChannel('', attributes.href);
      if (config?.id) return config.id;
    } catch { /* An unrelated or invalid canonical address cannot become a fetch target. */ }
  }
  throw new YouTubeFeedError('Nie udało się rozpoznać kanału YouTube. Ustaw YOUTUBE_CHANNEL_ID lub spróbuj ponownie później.');
}

/** Latest public uploads, using only YouTube's own channel page and public Atom feed. */
export function createYouTubeFeed({
  channelId = process.env.YOUTUBE_CHANNEL_ID ?? '', channelUrl = process.env.YOUTUBE_CHANNEL_URL ?? '',
  fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000,
  cacheTtlMs = 10 * 60 * 1000, retryDelayMs = 60 * 1000,
} = {}) {
  let configuration;
  let configurationError;
  try { configuration = normalizeYouTubeChannel(channelId, channelUrl); }
  catch (error) { configurationError = error; }
  let resolvedId = configuration?.id;
  let cache;
  let inFlight;
  let failure;

  async function fetchText(url, maximumBytes, accept) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal, redirect: 'error', credentials: 'omit',
        headers: { Accept: accept, 'User-Agent': 'ESCE-landing-page/1.0' },
      });
      if (!response.ok || Number(response.headers.get('content-length')) > maximumBytes) {
        await response.body?.cancel();
        throw new YouTubeFeedError(UPSTREAM_ERROR);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new YouTubeFeedError(UPSTREAM_ERROR);
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maximumBytes) {
            await reader.cancel();
            throw new YouTubeFeedError(UPSTREAM_ERROR);
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } finally { clearTimeout(timer); }
  }

  async function load() {
    try {
      if (!resolvedId) resolvedId = resolveChannelId(await fetchText(configuration.url, PAGE_LIMIT, 'text/html'));
      const feed = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${resolvedId}`,
        FEED_LIMIT, 'application/atom+xml, application/xml, text/xml');
      const value = { configured: true, channelUrl: configuration.url, videos: parseFeed(feed, resolvedId) };
      cache = { value, expiresAt: now() + cacheTtlMs };
      failure = null;
      return value;
    } catch (error) {
      const message = error instanceof YouTubeFeedError ? error.message : UPSTREAM_ERROR;
      failure = { message, retryAt: now() + retryDelayMs };
      throw new YouTubeFeedError(message, Math.max(1, Math.ceil(retryDelayMs / 1000)));
    }
  }

  return {
    async getVideos() {
      if (configurationError) throw configurationError;
      if (!configuration) return { configured: false, channelUrl: '', videos: [] };
      if (cache && cache.expiresAt > now()) return cache.value;
      if (failure && failure.retryAt > now()) {
        throw new YouTubeFeedError(failure.message, Math.max(1, Math.ceil((failure.retryAt - now()) / 1000)));
      }
      if (!inFlight) inFlight = load().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
