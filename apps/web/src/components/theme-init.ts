// Pre-paint theme script (UI redesign 2026-11-11). Rendered inline in the root
// layout WITH the request nonce (the CSP has no 'unsafe-inline'). Server-safe module.
export const THEME_KEY = 'cw-theme';

export const THEME_INIT = `(function(){var t=null;try{t=localStorage.getItem('${THEME_KEY}')}catch(e){}if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light'}document.documentElement.setAttribute('data-theme',t)})();`;
