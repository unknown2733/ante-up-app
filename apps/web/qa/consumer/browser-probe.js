/* Paste this file into DevTools Console on an Ante Up page after choosing a viewport.
   Read-only DOM inspection. It does not click, sign, fetch, or inspect wallet storage. */
(() => {
  const viewport = document.documentElement.clientWidth;
  const bodyWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
  const visible = el => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const label = el => el.getAttribute('aria-label') || el.labels?.[0]?.textContent?.trim() || el.getAttribute('placeholder') ||
    el.textContent?.trim().slice(0, 60) || el.getAttribute('title') || '';
  const controls = [...document.querySelectorAll('button,a,input,select,textarea,[role="button"]')].filter(visible);
  const report = {
    url: location.origin + location.pathname,
    viewport: { width: viewport, height: document.documentElement.clientHeight },
    documentLanguage: document.documentElement.lang,
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content ?? null,
    iconHref: document.querySelector('link[rel="icon"],link[rel="shortcut icon"]')?.href ?? null,
    horizontalOverflowPx: Math.max(0, bodyWidth - viewport),
    unnamedControls: controls.filter(el => !label(el)).map(el => el.outerHTML.slice(0, 120)),
    smallTouchTargets: controls.filter(el => { const r = el.getBoundingClientRect(); return r.width < 40 || r.height < 40; }).map(el => ({ label: label(el), width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height) })),
    brokenImages: [...document.images].filter(image => visible(image) && image.complete && image.naturalWidth === 0).map(image => image.src),
  };
  console.log('Ante Up read-only browser probe', report);
  return report;
})();
