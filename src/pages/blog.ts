import { api, ApiError, escapeHtml, type Post } from '../api';
import { renderMarkdown } from '../markdown';
import { site } from '../site.config';

const dateFormatter = new Intl.DateTimeFormat('pl-PL', {
  day: 'numeric', month: 'long', year: 'numeric',
});

function postMeta(post: Post): string {
  const date = new Date(post.publishedAt ?? post.createdAt);
  const time = Number.isNaN(date.getTime()) ? ''
    : `<time datetime="${date.toISOString()}">${dateFormatter.format(date)}</time>`;
  return `<div class="blog-meta">${post.category ? `<span>${escapeHtml(post.category)}</span>` : ''}${time}</div>`;
}

function listHeader(): string {
  return '<h1 class="page-heading">Blog</h1>';
}

function loading(main: HTMLElement, article = false): void {
  main.classList.add('blog-page');
  main.setAttribute('aria-busy', 'true');
  main.innerHTML = `${article ? '<a class="blog-back" href="/blog">← Wszystkie wpisy</a>' : listHeader()}
    <div class="blog-state" role="status">${article ? 'Ładowanie wpisu…' : 'Ładowanie wpisów…'}</div>`;
}

function renderError(main: HTMLElement, error: unknown, retry: () => Promise<void>, article = false): void {
  const missing = article && error instanceof ApiError && error.status === 404;
  const message = missing ? 'Nie znaleziono tego wpisu.'
    : error instanceof ApiError ? error.message : 'Nie udało się wczytać bloga. Spróbuj ponownie.';

  main.innerHTML = `${article ? '<a class="blog-back" href="/blog">← Wszystkie wpisy</a>' : listHeader()}
    <div class="blog-state" role="alert">
      <p>${escapeHtml(message)}</p>
      ${missing ? '<a class="blog-text-link" href="/blog">Przejdź do bloga →</a>'
        : '<button class="blog-retry" type="button" data-retry>Spróbuj ponownie</button>'}
    </div>`;

  main.querySelector<HTMLButtonElement>('[data-retry]')?.addEventListener('click', () => { void retry(); });
}

export async function renderBlog(main: HTMLElement): Promise<void> {
  loading(main);
  try {
    const { posts } = await api<{ posts: Post[] }>('/api/posts');
    main.innerHTML = `${listHeader()}
      ${posts.length ? `<div class="blog-list">${posts.map((post) => `
        <article class="blog-card">
          ${postMeta(post)}
          <h2><a class="blog-card-link" href="/blog/${encodeURIComponent(post.slug)}">${escapeHtml(post.title)}</a></h2>
          ${post.excerpt ? `<p class="blog-excerpt">${escapeHtml(post.excerpt)}</p>` : ''}
          <a class="blog-text-link" href="/blog/${encodeURIComponent(post.slug)}" aria-label="Czytaj wpis: ${escapeHtml(post.title)}">Czytaj wpis <span aria-hidden="true">→</span></a>
        </article>`).join('')}</div>`
        : '<div class="blog-state"><p>Nie ma jeszcze opublikowanych wpisów.</p></div>'}`;
  } catch (error) {
    renderError(main, error, () => renderBlog(main));
  } finally {
    main.removeAttribute('aria-busy');
  }
}

export async function renderArticle(main: HTMLElement, slug: string): Promise<void> {
  loading(main, true);
  try {
    const { post } = await api<{ post: Post }>(`/api/posts/${encodeURIComponent(slug)}`);
    main.innerHTML = `
      <article class="blog-article">
        <a class="blog-back" href="/blog">← Wszystkie wpisy</a>
        <header class="blog-article-header">
          ${postMeta(post)}
          <h1 class="page-heading">${escapeHtml(post.title)}</h1>
          ${post.excerpt ? `<p class="blog-article-excerpt">${escapeHtml(post.excerpt)}</p>` : ''}
        </header>
        <div class="blog-prose">${renderMarkdown(post.content)}</div>
      </article>`;
    document.title = `${post.title} — Blog — ${site.name}`;
  } catch (error) {
    renderError(main, error, () => renderArticle(main, slug), true);
  } finally {
    main.removeAttribute('aria-busy');
  }
}
