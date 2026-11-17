import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

try {
  writeFileSync('.env', [
    '# Osobiste hasło do panelu CMS. Ten plik jest ignorowany przez Git.',
    '# Możesz ustawić własne hasło (minimum 12 znaków) i ponownie uruchomić serwer.',
    `ADMIN_PASSWORD=${randomBytes(24).toString('base64url')}`,
    'PORT=3000',
    'HOST=127.0.0.1',
    'COOKIE_SECURE=false',
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('Utworzono .env z osobistym, losowym hasłem do panelu CMS. Hasło znajdziesz w pliku .env.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Plik .env już istnieje — zachowano Twoje ustawienia.');
}
