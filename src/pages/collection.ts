import { api, escapeHtml as e, type ContentItem, type ContentKind } from '../api';
import { safeUrl } from '../site.config';

export interface GalleryItem {
  title: string;
  description: string;
  image?: string;
  url?: string;
  label?: string;
}

const placeholderImage = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="4" y="6" width="24" height="20" rx="2"/><circle cx="12" cy="13" r="2"/><path d="m5 24 8-8 5 5 4-4 5 5"/></svg>';

export function galleryMarkup(items: GalleryItem[], placeholderName: string, count = 6): string {
  if (!items.length) {
    return `<ul class="collection-grid" aria-label="Galeria — miejsca na przyszłe materiały">${Array.from({ length: count }, (_, index) => `<li class="collection-card is-placeholder"><div class="collection-preview placeholder-preview" aria-hidden="true">${placeholderImage}<span>Miniatura</span></div><div class="collection-copy"><span class="collection-label">W przygotowaniu</span><h2>${e(placeholderName)} ${String(index + 1).padStart(2, '0')}</h2><p>Miejsce na krótki opis.</p></div></li>`).join('')}</ul>`;
  }
  return `<ul class="collection-grid">${items.map((item) => {
    const image = item.image ? safeUrl(item.image, { local: true }) : '';
    const url = item.url ? safeUrl(item.url, { local: true }) : '';
    const thumbnail = `<div class="collection-preview${image ? '' : ' placeholder-preview'}">${image ? `<img src="${e(image)}" alt="" width="640" height="400" loading="lazy"/>` : placeholderImage}</div>`;
    const title = url ? `<a href="${e(url)}" ${url.startsWith('https:') ? 'target="_blank" rel="noopener noreferrer"' : ''}>${e(item.title)}<span aria-hidden="true"> ↗</span></a>` : e(item.title);
    return `<li class="collection-card">${thumbnail}<div class="collection-copy">${item.label ? `<span class="collection-label">${e(item.label)}</span>` : ''}<h2>${title}</h2><p>${e(item.description)}</p></div></li>`;
  }).join('')}</ul>`;
}

export function renderCollection(main: HTMLElement, title: string, description: string, items: GalleryItem[], placeholderName: string): void {
  main.classList.add('collection-page');
  main.innerHTML = `<div class="page-heading"><h1>${e(title)}</h1><p class="page-description">${e(description)}</p></div>${galleryMarkup(items, placeholderName)}`;
}

export async function renderCollectionPage(main: HTMLElement, kind: Extract<ContentKind, 'projects' | 'tools'>, title: string, description: string, placeholderName: string): Promise<void> {
  main.classList.add('collection-page');
  const heading = `<div class="page-heading"><h1>${e(title)}</h1><p class="page-description">${e(description)}</p></div>`;
  main.innerHTML = `${heading}<p class="page-state" role="status">Wczytywanie…</p>`;
  try {
    const { items } = await api<{ items: ContentItem[] }>(`/api/content/${kind}`);
    renderCollection(main, title, description, items.map((item) => ({ ...item, label: item.category })), placeholderName);
  } catch (error) {
    main.innerHTML = `${heading}<div class="empty-state" role="alert"><p>${e(error instanceof Error ? error.message : 'Nie udało się wczytać materiałów.')}</p><button class="button" id="retry-collection" type="button">Spróbuj ponownie</button></div>`;
    main.querySelector('#retry-collection')?.addEventListener('click', () => { void renderCollectionPage(main, kind, title, description, placeholderName); });
  }
}
