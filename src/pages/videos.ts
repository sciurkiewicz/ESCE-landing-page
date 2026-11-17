import { api, escapeHtml as e, type ContentItem } from '../api';
import { safeUrl, site } from '../site.config';
import { galleryMarkup } from './collection';

interface ChannelVideo {
  id: string;
  title: string;
  publishedAt: string;
  thumbnail: string;
  url: string;
  description?: string;
  category?: string;
  sortTime?: string;
}

interface VideosResponse {
  configured: boolean;
  channelUrl: string;
  videos: ChannelVideo[];
}

function videoId(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '';
    let id = '';
    if (url.hostname === 'youtu.be') id = url.pathname.slice(1).replace(/\/$/, '');
    else if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') ?? '' : /^\/shorts\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? '';
    }
    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : '';
  } catch { return ''; }
}

function date(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' }).format(parsed);
}

export async function renderVideos(main: HTMLElement): Promise<void> {
  main.classList.add('videos-page');
  main.innerHTML = `<div class="page-heading"><h1>Filmy</h1><p class="page-description">Najnowsze materiały z kanału ${e(site.name)}.</p><div id="channel-link"></div></div><div id="videos-content" aria-live="polite" aria-busy="true"><p class="page-state">Wczytywanie filmów…</p></div>`;
  const content = main.querySelector<HTMLElement>('#videos-content')!;
  const channelLink = main.querySelector<HTMLElement>('#channel-link')!;

  function showChannel(value: string): void {
    const url = safeUrl(value);
    channelLink.innerHTML = url ? `<a class="subtle-link" href="${e(url)}" target="_blank" rel="noopener noreferrer">Kanał na YouTube <span aria-hidden="true">↗</span></a>` : '';
  }

  showChannel(site.youtubeUrl);
  async function load(): Promise<void> {
    content.setAttribute('aria-busy', 'true');
    try {
      const [feed, manual] = await Promise.allSettled([
        api<VideosResponse>('/api/videos'),
        api<{ items: ContentItem[] }>('/api/content/videos'),
      ]);
      const result = feed.status === 'fulfilled' ? feed.value : { configured: false, channelUrl: '', videos: [] };
      const manualItems = manual.status === 'fulfilled' ? manual.value.items : [];
      if (feed.status === 'rejected' && !manualItems.length) throw feed.reason;
      if (manual.status === 'rejected' && !result.videos.length) throw manual.reason;
      showChannel(result.channelUrl || site.youtubeUrl);
      const merged = new Map<string, ChannelVideo>(result.videos.filter((video) => /^[a-zA-Z0-9_-]{11}$/.test(video.id)).map((video) => [video.id, video]));
      for (const item of manualItems) {
        const id = videoId(item.url);
        if (!id) continue;
        const automatic = merged.get(id);
        merged.set(id, {
          id, title: item.title, description: item.description, category: item.category,
          thumbnail: item.image || automatic?.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          url: `https://www.youtube.com/watch?v=${id}`,
          publishedAt: automatic?.publishedAt ?? '',
          sortTime: automatic?.publishedAt || item.createdAt,
        });
      }
      const videos = [...merged.values()].sort((a, b) => Date.parse(b.sortTime || b.publishedAt) - Date.parse(a.sortTime || a.publishedAt));
      if (!videos.length) {
        content.innerHTML = `<p class="page-state videos-empty">${result.configured ? 'Na kanale nie ma jeszcze opublikowanych filmów.' : 'Filmy pojawią się tutaj wkrótce.'}</p>${galleryMarkup([], 'Film')}`;
        return;
      }
      content.innerHTML = `<ul class="collection-grid video-grid">${videos.map((video) => `<li class="collection-card video-card"><a class="video-link" href="https://www.youtube.com/watch?v=${e(video.id)}" target="_blank" rel="noopener noreferrer"><div class="collection-preview video-preview"><img src="${e(safeUrl(video.thumbnail, { local: true }) || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`)}" alt="" width="480" height="360" loading="lazy"/><span class="video-play" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="m9 5 11 7-11 7z"/></svg></span></div><div class="collection-copy">${video.publishedAt ? `<time class="collection-label" datetime="${e(video.publishedAt)}">${e(date(video.publishedAt))}</time>` : video.category ? `<span class="collection-label">${e(video.category)}</span>` : ''}<h2>${e(video.title)}</h2>${video.description ? `<p>${e(video.description)}</p>` : ''}</div></a></li>`).join('')}</ul>`;
    } catch (error) {
      content.innerHTML = `<div class="empty-state"><h2>Nie udało się wczytać filmów.</h2><p>${e(error instanceof Error ? error.message : 'Spróbuj ponownie za chwilę.')}</p><button class="button" id="retry-videos" type="button">Spróbuj ponownie</button></div>`;
      content.querySelector('#retry-videos')?.addEventListener('click', () => {
        content.innerHTML = '<p class="page-state">Wczytywanie filmów…</p>';
        void load();
      });
    } finally {
      content.setAttribute('aria-busy', 'false');
    }
  }

  await load();
}
