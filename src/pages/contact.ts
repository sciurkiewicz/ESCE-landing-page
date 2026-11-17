import { escapeHtml as e } from '../api';
import { safeUrl, site } from '../site.config';

export function renderContact(main: HTMLElement): void {
  main.classList.add('contact-page');
  const email = safeUrl(site.email, { email: true });
  const socialLinks = [
    { name: 'YouTube', url: safeUrl(site.youtubeUrl) },
    { name: 'GitHub', url: safeUrl(site.githubUrl) },
    { name: 'Discord', url: safeUrl(site.discordUrl) },
  ].filter((link) => link.url);

  main.innerHTML = `<div class="page-heading"><h1>Kontakt</h1><p class="page-description">Masz pytanie, pomysł albo chcesz porozmawiać o tworzeniu gier?</p></div>
    <section class="contact-card" aria-labelledby="contact-card-title">
      <svg class="contact-icon" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="3" y="6" width="26" height="20" rx="2"/><path d="m4 8 12 9L28 8"/></svg>
      <h2 id="contact-card-title">Napisz do mnie</h2>
      ${email ? `<a class="contact-email" href="${e(email)}">${e(site.email)}</a><div class="contact-actions"><a class="button button-primary" href="${e(email)}">Napisz e-mail ↗</a><button class="button" id="copy-email" type="button">Kopiuj adres</button></div><p id="contact-status" class="contact-status" role="status"></p>` : '<p class="contact-placeholder">Adres e-mail pojawi się tutaj wkrótce.</p>'}
    </section>
    ${socialLinks.length ? `<nav class="contact-socials" aria-label="Profile ${e(site.name)}">${socialLinks.map((link) => `<a href="${e(link.url)}" target="_blank" rel="noopener noreferrer">${e(link.name)} <span aria-hidden="true">↗</span></a>`).join('')}</nav>` : ''}`;

  main.querySelector('#copy-email')?.addEventListener('click', async () => {
    const status = main.querySelector<HTMLElement>('#contact-status')!;
    try {
      await navigator.clipboard.writeText(site.email);
      status.textContent = 'Adres skopiowany.';
    } catch {
      status.textContent = 'Nie udało się skopiować adresu. Możesz zaznaczyć go i skopiować ręcznie.';
    }
  });
}
