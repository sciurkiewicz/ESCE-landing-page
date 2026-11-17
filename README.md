# ESCE

Strona kanału z czarnym tłem, prostym menu i panelem CMS chronionym hasłem. Frontend: TypeScript i Vite; backend: Node.js i SQLite.

- `/` — leśny krajobraz z białym napisem ESCE i paralaksą warstw podczas przewijania i ruchu kursora. Dolny odnośnik „Zejdź głębiej” prowadzi przez ziemię i korzenie do podziemnej sceny „Pod powierzchnią” z odnośnikiem do projektów. Przy preferencji ograniczonego ruchu obie sceny pozostają nieruchome i dostępne przez przewijanie. Grafiki wygenerowano AI; [opis warstw i prompty](./public/landscape/README.md).
- `/about` — opis autora w Markdown.
- `/videos` — filmy z YouTube i materiały dodane ręcznie.
- `/projects` oraz `/tools` — wyśrodkowane galerie po trzy kolumny; przed dodaniem treści pokazują po sześć placeholderów. Na mniejszych ekranach mają mniej kolumn.
- `/blog` oraz `/blog/:slug` — opublikowane wpisy i artykuły z bezpiecznie renderowanym Markdown.
- `/contact` — e-mail z opcją kopiowania i skonfigurowane odnośniki społecznościowe.
- `/adminpanel` — panel autora, otwierany bezpośrednio przez właściciela.

## Uruchomienie lokalne

Wymagane: **Node.js 24 lub nowszy** oraz npm.

```powershell
npm install
npm run setup
npm run dev
```

Strona i panel: http://127.0.0.1:5173 oraz http://127.0.0.1:5173/adminpanel. API działa na porcie 3001; Vite przekazuje do niego żądania `/api/*`. Zatrzymanie: `Ctrl+C`.

`npm run setup` tworzy `.env` z losowym `ADMIN_PASSWORD`, jeśli plik jeszcze nie istnieje. Istniejące hasło i ustawienia zostają zachowane. Własne hasło musi mieć przynajmniej 12 znaków; hasło odczytuje wyłącznie serwer, bez prefiksu `VITE_`. Przykład konfiguracji: [.env.example](./.env.example). Po zmianie `.env` uruchom serwer ponownie; zmiana hasła unieważnia dotychczasowe sesje.

## Edycja treści

Otwórz bezpośrednio `/adminpanel` i zaloguj się hasłem z `.env`; publiczna strona nie zawiera odnośnika do panelu. Zakładki **Blog, Projekty, Narzędzia i Filmy** umożliwiają dodawanie, edycję, usuwanie oraz zapisywanie szkiców i publikowanie. Szkice są widoczne tylko w panelu. Obrazki i odnośniki podaje się jako adresy URL; panel nie przesyła plików na serwer.

W **Ustawieniach** zmienisz nazwę strony, e-mail, kanał YouTube lub jego identyfikator `UC…`, GitHub, Discord oraz opis „O mnie” w Markdown. Tutaj najlepiej ustawić dane kontaktowe i kanał; [src/site.config.ts](./src/site.config.ts) służy jedynie jako konfiguracja zapasowa. Nie skonfigurowano przykładowego adresu e-mail ani cudzego kanału.

Filmy pobierane są z oficjalnego RSS YouTube, bez klucza API: do dziewięciu najnowszych, z pamięcią podręczną na 10 minut. Możesz również dodawać własne materiały w zakładce **Filmy**, podając adres `youtube.com/watch`, `youtube.com/shorts` albo `youtu.be`. Lista łączy oba źródła bez duplikowania tego samego filmu.

`YOUTUBE_CHANNEL_URL` i `YOUTUBE_CHANNEL_ID` w `.env` są początkową konfiguracją zapasową. Po zapisaniu ustawień CMS to one mają pierwszeństwo; wyczyszczenie obu pól kanału w panelu wyłącza automatyczne pobieranie.

## Build i sprawdzenie

```powershell
npm test
npm run build
npm run test:e2e
npm run test:parallax
```

`npm test` uruchamia testy backendu. Build sprawdza typy TypeScript i buduje frontend. Testy przeglądarkowe CMS i paralaksy wymagają zainstalowanego Google Chrome lub Microsoft Edge; własną ścieżkę przeglądarki można podać przez `BROWSER_EXECUTABLE`.

## Uruchomienie produkcyjne i dane

```powershell
npm run build
npm start
```

Strona i API działają pod http://127.0.0.1:3000; port i adres nasłuchiwania zmienisz przez `PORT` i `HOST`. Projekt wymaga hostingu z Node.js i trwałym dyskiem. To lokalny projekt w repozytorium; nie opublikowano go w Sites.

Na publicznym hostingu z HTTPS ustaw:

```dotenv
NODE_ENV=production
COOKIE_SECURE=true
SITE_ORIGIN=https://twoja-domena.pl
```

`SITE_ORIGIN` musi odpowiadać dokładnemu publicznemu adresowi strony: protokołowi, domenie i ewentualnemu portowi, bez ścieżki. Jeśli hosting wymaga nasłuchiwania na wszystkich interfejsach, ustaw `HOST=0.0.0.0`. Własne `ADMIN_PASSWORD` przechowuj w sekretach serwera.

Wpisy, galerie, ustawienia i sesje są zapisywane w `data/blog.sqlite`. Zachowaj **cały katalog `data/`** między restartami i wdrożeniami. Kopię zapasową wykonuj po zatrzymaniu serwera, kopiując cały katalog; SQLite używa trybu WAL, więc pojedynczy plik otwartej bazy nie wystarcza.
