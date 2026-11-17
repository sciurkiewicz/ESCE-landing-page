# Krajobraz ekranu tytułowego

Oryginalne warstwy wygenerowane wbudowanym narzędziem image_gen (umiejętność imagegen).

- [distant.png](./distant.png): nieprzezroczyste niebo i dalekie góry.
- [forest.png](./forest.png): środkowa warstwa lasu z przezroczystością.
- [foreground.png](./foreground.png): pierwszy plan i drzewa z przezroczystością.

Dodatkowe warstwy zejścia do podziemi:

- [underground.png](./underground.png): wnętrze jaskini.
- [soil.png](./soil.png): przekrój ziemi i korzeni.
- [cave-foreground.png](./cave-foreground.png): skalna rama pierwszego planu.

Dokładne prompty nowych warstw: [podziemia](./underground-prompts.md).

Dokładne prompty użyte do wygenerowania warstw:

## distant

Przezroczyste tło: nie.

Use case: stylized-concept. Asset type: original background layer for a cinematic parallax website hero. Generate a wide 16:9 landscape image, not a website screenshot. A beautifully painted mountain valley at blue-hour twilight with a dark pine wilderness mood, subtle painterly texture and clear layered silhouettes. Cool desaturated midnight-blue and deep teal palette, pale mist in the far valley, a subdued warm silver horizon, very dark blue sky at the upper edge. Big majestic distant mountain ridges lie mainly in the lower half; the upper half is a spacious calm twilight sky. Keep the exact central region around 50% width and 42% height quiet and dark enough for large white text to be placed later in HTML. Wide scenic composition spanning the full image, strong atmospheric depth. This is the backmost OPAQUE layer: include sky and distant mountain ranges ONLY, no near trees, no foreground land, no text, no lettering, no logo, no UI, no people, no buildings. Original concept art inspired by the sense of depth of layered game key art, not a copy of any existing game's art. Full bleed edge-to-edge, seamless dark bottom that will be covered by separate layers. High visual quality, restrained lighting, no neon, no purple.

## forest

Przezroczyste tło: tak.

Use case: stylized-concept. Asset type: TRANSPARENT middle layer for a cinematic parallax website hero. Generate a wide 16:9 PNG on genuine transparent background. Original painterly game-landscape art: the MIDDLE DISTANCE of a dark pine forest valley at blue-hour twilight, cool desaturated deep teal and slate-blue. This is a cutout landscape layer, not a complete landscape. The top 48 percent of the full canvas MUST be empty transparent alpha. A rolling forested mountain ridge rises from around 56 percent height on the left, drops into a spacious valley opening near center, and rises gently toward 52 percent height on the right. Paint small and medium pine forest silhouettes with subtle atmospheric mist hugging the ridge. All land and trees below the ridge extend continuously down to the bottom edge, completely filled opaque dark teal, left-to-right. Entire central upper region remains TRANSPARENT to reveal sky and a big HTML title behind/above. No sky whatsoever, no solid background, no white background, no checkerboard drawn into image, no sun or moon, no text, no logos, no people, no buildings, no border. Need a single cohesive forest ridge silhouette across the bottom half with gently detailed pine tops; avoid isolated floating islands. Rich understated painterly quality and readable depth, consistent midnight-blue/teal low-light palette.

## foreground

Przezroczyste tło: tak.

Use case: stylized-concept. Asset type: TRANSPARENT foreground framing layer for an original cinematic parallax website hero. Generate a wide 16:9 PNG with real transparent alpha. Original painterly forest silhouette art in near-black evergreen tones (#050d10 with very subtle deep teal highlights), at blue-hour dusk. A natural uneven low ridge of dark earth spans the entire bottom 17 percent of the canvas, filled fully opaque down to the bottom edge. Clusters of tall beautifully shaped conifer pines grow from that ground at both outer sides, tallest tops around 30 percent height at the far left and 24 percent height at the far right, then smaller pines step inward. Keep the central 45 percent of the image wide open and TRANSPARENT above the low bottom ridge so a large title and distant valley can show through. A few close pine branches enter from the far sides, graceful asymmetric forest framing, authentic varied tree silhouettes with fine branch edges but not a photo. This must be only the near foreground land and pine trees as one separate compositing plane: no sky, no mountains, no background paint, no white or gray background, no drawn transparency checkerboard, no horizon light, no water, no text, no logo, no UI, no people, no buildings. Full-bleed bottom, left and right foreground silhouettes, rest genuinely transparent. High quality original game key art, understated and atmospheric.

