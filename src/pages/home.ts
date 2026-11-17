let disposeHome: (() => void) | undefined;

type Scene = {
  section: HTMLElement; stage: HTMLElement; layers: { element: HTMLElement; depth: number }[];
  top: number; height: number; stageHeight: number; width: number; left: number; travel: number;
  visible: boolean; targetProgress: number; progress: number; targetX: number; targetY: number; x: number; y: number;
};

/** Independent landscape scenes follow native scroll and a fine pointer. */
export function renderHome(main: HTMLElement, name: string): void {
  disposeHome?.();
  document.body.classList.add('home-page');
  main.classList.add('home-hero');
  main.innerHTML = `<div class="surface-section"><div class="parallax-stage">
    <div class="landscape-layer landscape-layer--distant" data-depth="0.08" aria-hidden="true"><img src="/landscape/distant.png" alt="" fetchpriority="high" decoding="async" draggable="false"></div>
    <div class="landscape-layer landscape-layer--forest" data-depth="0.28" aria-hidden="true"><img src="/landscape/forest.png" alt="" decoding="async" draggable="false"></div>
    <div class="landscape-layer landscape-layer--foreground" data-depth="0.52" aria-hidden="true"><img src="/landscape/foreground.png" alt="" decoding="async" draggable="false"></div>
    <div class="landscape-grade" aria-hidden="true"></div>
    <div class="home-title-position"><h1 class="home-title"></h1></div>
    <a class="descent-cue" href="#podziemia">Zejdź głębiej<span class="descent-chevron" aria-hidden="true"></span></a>
  </div></div>
  <section id="podziemia" class="underground-section" aria-labelledby="underground-heading">
    <div class="soil-bridge" aria-hidden="true"><img src="/landscape/soil.png" alt="" loading="lazy" decoding="async" draggable="false"></div>
    <div class="underground-stage">
      <div class="underground-layer underground-layer--distant" data-depth="0.10" aria-hidden="true"><img src="/landscape/underground.png" alt="" loading="lazy" decoding="async" draggable="false"></div>
      <div class="underground-layer underground-layer--foreground" data-depth="0.44" aria-hidden="true"><img src="/landscape/cave-foreground.png" alt="" loading="lazy" decoding="async" draggable="false"></div>
      <div class="underground-grade" aria-hidden="true"></div>
      <div class="underground-copy"><h2 id="underground-heading">Pod powierzchnią</h2><p>Pomysły. Prototypy. Nowe światy.</p><a href="/projects">Zobacz projekty</a></div>
    </div>
  </section>`;
  main.querySelector('.home-title')!.textContent = name.toUpperCase();

  function scene(sectionSelector: string, stageSelector: string, layerSelector: string): Scene {
    const section = main.querySelector<HTMLElement>(sectionSelector)!;
    const stage = section.querySelector<HTMLElement>(stageSelector)!;
    return { section, stage, layers: [...stage.querySelectorAll<HTMLElement>(layerSelector)].map((element) => ({ element, depth: Number(element.dataset.depth) })), top: 0, height: 0, stageHeight: 1, width: 1, left: 0, travel: 1, visible: false, targetProgress: 0, progress: 0, targetX: 0, targetY: 0, x: 0, y: 0 };
  }
  const scenes = [scene('.surface-section', '.parallax-stage', '.landscape-layer'), scene('.underground-section', '.underground-stage', '.underground-layer')];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  let attached = false;
  let disposed = false;
  let frame = 0;
  let hashFrame = 0;
  let lastTime = 0;
  let geometryDirty = true;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  function readScroll() {
    const scroll = window.scrollY;
    for (const state of scenes) {
      state.targetProgress = clamp((scroll - state.top) / state.travel, 0, 1);
      state.visible = scroll + window.innerHeight > state.top && scroll < state.top + state.height;
      if (!state.visible) { state.targetX = 0; state.targetY = 0; }
    }
  }

  function measure() {
    for (const state of scenes) {
      const bounds = state.section.getBoundingClientRect();
      const stageBounds = state.stage.getBoundingClientRect();
      state.top = bounds.top + window.scrollY;
      state.height = bounds.height;
      state.stageHeight = Math.max(1, stageBounds.height);
      state.width = Math.max(1, stageBounds.width);
      state.left = stageBounds.left;
      state.travel = Math.max(1, state.height - state.stageHeight);
    }
    geometryDirty = false;
    readScroll();
  }

  function draw(state: Scene) {
    const horizontal = Math.min(state.width * 0.014, 22);
    const vertical = Math.min(state.stageHeight * 0.012, 12);
    const maxDepth = Math.max(...state.layers.map(({ depth }) => depth));
    for (const { element, depth } of state.layers) {
      const x = state.x * horizontal * depth / maxDepth;
      const y = -state.progress * state.stageHeight * depth * 0.32 + state.y * vertical * depth / maxDepth;
      element.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
    }
  }

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
  }

  function schedule() {
    if (frame || disposed || !attached || reducedMotion.matches || document.hidden || (!geometryDirty && !scenes.some(({ visible }) => visible))) return;
    frame = requestAnimationFrame(animate);
  }

  function animate(time: number) {
    frame = 0;
    if (disposed || !attached || reducedMotion.matches || document.hidden) { lastTime = 0; return; }
    if (geometryDirty) measure();
    const delta = lastTime ? Math.min(time - lastTime, 64) : 16;
    const blend = 1 - Math.exp(-delta / 85);
    let unsettled = false;
    for (const state of scenes) {
      if (!state.visible) continue;
      state.progress += (state.targetProgress - state.progress) * blend;
      state.x += (state.targetX - state.x) * blend;
      state.y += (state.targetY - state.y) * blend;
      const moving = Math.abs(state.targetProgress - state.progress) > 0.0001 || Math.abs(state.targetX - state.x) > 0.0005 || Math.abs(state.targetY - state.y) > 0.0005;
      if (!moving) { state.progress = state.targetProgress; state.x = state.targetX; state.y = state.targetY; }
      unsettled ||= moving;
      draw(state);
    }
    lastTime = unsettled ? time : 0;
    if (unsettled) schedule();
  }

  function onScroll() { readScroll(); if (scenes.some(({ visible }) => visible)) schedule(); else stop(); }
  function onResize() { geometryDirty = true; if (reducedMotion.matches) measure(); else schedule(); }

  function onPointer(event: PointerEvent) {
    if (!finePointer.matches || reducedMotion.matches || event.pointerType === 'touch') return;
    const state = scenes.find(({ stage }) => stage === event.currentTarget)!;
    const stageTop = Math.min(Math.max(state.top - window.scrollY, 0), state.top + state.height - window.scrollY - state.stageHeight);
    state.targetX = clamp(((event.clientX - state.left) / state.width) * 2 - 1, -1, 1);
    state.targetY = clamp(((event.clientY - stageTop) / state.stageHeight) * 2 - 1, -1, 1);
    schedule();
  }

  function onPointerLeave(event: PointerEvent) {
    const state = scenes.find(({ stage }) => stage === event.currentTarget)!;
    state.targetX = 0; state.targetY = 0; schedule();
  }

  function onPreferences() {
    measure();
    for (const state of scenes) {
      state.targetX = 0; state.targetY = 0; state.progress = state.targetProgress;
      if (reducedMotion.matches) {
        state.x = 0; state.y = 0;
        for (const { element } of state.layers) element.style.removeProperty('transform');
      }
    }
    if (reducedMotion.matches) stop();
    else schedule();
  }

  function onVisibility() { if (document.hidden) stop(); else { geometryDirty = true; schedule(); } }

  function attach() {
    if (attached || disposed) return;
    attached = true;
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('pagehide', onPageHide);
    for (const { stage } of scenes) {
      stage.addEventListener('pointermove', onPointer, { passive: true });
      stage.addEventListener('pointerleave', onPointerLeave, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    reducedMotion.addEventListener('change', onPreferences);
    finePointer.addEventListener('change', onPreferences);
  }

  function detach() {
    stop();
    if (hashFrame) cancelAnimationFrame(hashFrame);
    hashFrame = 0;
    attached = false;
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pagehide', onPageHide);
    for (const { stage } of scenes) {
      stage.removeEventListener('pointermove', onPointer);
      stage.removeEventListener('pointerleave', onPointerLeave);
    }
    document.removeEventListener('visibilitychange', onVisibility);
    reducedMotion.removeEventListener('change', onPreferences);
    finePointer.removeEventListener('change', onPreferences);
  }

  function onPageShow() { attach(); onPreferences(); }
  function onPageHide(event: PageTransitionEvent) {
    detach();
    if (event.persisted) window.addEventListener('pageshow', onPageShow, { once: true });
    else disposed = true;
  }

  disposeHome = () => { disposed = true; detach(); window.removeEventListener('pageshow', onPageShow); };
  attach();
  measure();
  for (const state of scenes) { state.progress = state.targetProgress; if (!reducedMotion.matches) draw(state); }
  if (location.hash === '#podziemia') {
    hashFrame = requestAnimationFrame(() => {
      hashFrame = 0;
      if (disposed) return;
      scenes[1].section.scrollIntoView({ block: 'start', behavior: 'instant' });
      measure();
      for (const state of scenes) { state.progress = state.targetProgress; if (!reducedMotion.matches) draw(state); }
    });
  }
}
