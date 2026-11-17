import { site } from './site.config';
import { api, type SiteSettings } from './api';
import { renderCollectionPage } from './pages/collection';
import { renderContact } from './pages/contact';
import { renderVideos } from './pages/videos';

const pageNames: Record<string, string> = {
  '/about': 'O mnie',
  '/videos': 'Filmy',
  '/projects': 'Projekty',
  '/blog': 'Blog',
  '/contact': 'Kontakt',
  '/tools': 'Narzędzia do gamedevu',
  '/adminpanel': 'Panel CMS',
};
const currentPath = location.pathname.replace(/\/+$/, '') || '/';
const pageName = pageNames[currentPath];
document.querySelectorAll<HTMLAnchorElement>('.header-items a').forEach((link) => {
  const path = link.getAttribute('href');
  if (path === currentPath || (path === '/blog' && currentPath.startsWith('/blog/'))) link.setAttribute('aria-current', 'page');
});

const main = document.querySelector<HTMLElement>('#app');

function applySettings(settings: SiteSettings): void {
  Object.assign(site, {
    name: settings.siteName,
    email: settings.email,
    youtubeUrl: settings.youtubeUrl || (settings.youtubeChannelId ? `https://www.youtube.com/channel/${settings.youtubeChannelId}` : ''),
    githubUrl: settings.githubUrl,
    discordUrl: settings.discordUrl,
    about: settings.about,
  });
  document.title = pageName ? `${pageName} — ${site.name}` : site.name;
  const name = document.querySelector<HTMLAnchorElement>('.site-name');
  if (name) name.textContent = site.name;
}

async function loadSettings(): Promise<void> {
  try {
    const { settings } = await api<{ settings: SiteSettings }>('/api/settings');
    applySettings(settings);
  } catch {
    // The public shell and fallback branding remain usable during an API outage.
  }
  document.title = pageName ? `${pageName} — ${site.name}` : site.name;
  const name = document.querySelector<HTMLAnchorElement>('.site-name');
  if (name) name.textContent = site.name;
}

window.addEventListener('cms:settings-saved', (event) => {
  const settings = (event as CustomEvent<{ settings: SiteSettings }>).detail?.settings;
  if (settings) applySettings(settings);
});

async function renderRoute(): Promise<void> {
  if (!main) return;
  await loadSettings();
  if (currentPath === '/') {
    const { renderHome } = await import('./pages/home');
    renderHome(main, site.name);
    return;
  }
  main.classList.add('content-page');
  if (currentPath === '/tools') {
    await renderCollectionPage(main, 'tools', 'Narzędzia do gamedevu', 'Narzędzia i zasoby do tworzenia gier.', 'Narzędzie');
  } else if (currentPath === '/projects') {
    await renderCollectionPage(main, 'projects', 'Projekty', 'Gry, prototypy i eksperymenty.', 'Projekt');
  } else if (currentPath === '/contact') {
    renderContact(main);
  } else if (currentPath === '/videos') {
    await renderVideos(main);
  } else if (currentPath === '/blog') {
    const { renderBlog } = await import('./pages/blog');
    await renderBlog(main);
  } else if (currentPath.startsWith('/blog/')) {
    const { renderArticle } = await import('./pages/blog');
    let slug: string;
    try { slug = decodeURIComponent(currentPath.slice('/blog/'.length)); }
    catch { slug = ''; }
    await renderArticle(main, slug);
  } else if (currentPath === '/adminpanel') {
    const { renderAdmin } = await import('./pages/admin');
    await renderAdmin(main);
  } else if (currentPath === '/about') {
    const heading = document.createElement('h1');
    heading.className = 'page-heading';
    heading.textContent = 'O mnie';
    const body = document.createElement('div');
    body.className = 'blog-prose about-body';
    if (site.about) {
      const { renderMarkdown } = await import('./markdown');
      body.innerHTML = renderMarkdown(site.about);
    } else {
      body.classList.add('page-state');
      body.textContent = 'Więcej o mnie pojawi się tutaj wkrótce.';
    }
    main.replaceChildren(heading, body);
  }
}

void renderRoute().catch(() => {
  if (!main) return;
  const message = document.createElement('p');
  message.className = 'page-state';
  message.textContent = 'Nie udało się wczytać strony. Odśwież ją i spróbuj ponownie.';
  main.classList.add('content-page');
  main.replaceChildren(message);
});
