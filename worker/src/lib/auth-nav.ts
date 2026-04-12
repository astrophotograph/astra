/**
 * Shared auth-aware navigation helpers for server-rendered pages.
 *
 * Auth state lives in localStorage (client-side). The server renders a
 * placeholder `<li id="auth-nav">` and the shared script fills it in.
 */

/**
 * SVG favicon as a data URI — a simple star/constellation icon.
 * Include in <head> on all pages.
 */
export function faviconLink(): string {
  return `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14' fill='%230a0e1a'/><circle cx='16' cy='12' r='2' fill='%236366f1'/><circle cx='10' cy='20' r='1.5' fill='%238b5cf6'/><circle cx='22' cy='18' r='1.5' fill='%238b5cf6'/><circle cx='14' cy='25' r='1' fill='%23c4b5fd'/><circle cx='24' cy='10' r='1' fill='%23c4b5fd'/><line x1='16' y1='12' x2='10' y2='20' stroke='%236366f180' stroke-width='0.5'/><line x1='16' y1='12' x2='22' y2='18' stroke='%236366f180' stroke-width='0.5'/><line x1='10' y1='20' x2='22' y2='18' stroke='%236366f180' stroke-width='0.5'/></svg>" />`;
}

/**
 * Returns the nav `<li>` placeholder + client-side script that populates
 * it based on localStorage auth state.
 */
export function authNavItem(): string {
  return `<li id="auth-nav"></li>`;
}

/**
 * Returns the shared auth script to include before </body>.
 * Reads localStorage, shows @username or Sign In link.
 */
export function authNavScript(): string {
  return `<script>
(function() {
  var t = localStorage.getItem('astra_api_token');
  var e = localStorage.getItem('astra_token_expires');
  var u = localStorage.getItem('astra_username');
  var el = document.getElementById('auth-nav');
  if (!el) return;
  if (t && e && new Date(e) > new Date() && u) {
    el.innerHTML = '<a href="/@' + encodeURIComponent(u) + '">@' + u + '</a>';
    var so = document.createElement('li');
    so.innerHTML = '<a href="#" id="astra-sign-out">Sign Out</a>';
    el.parentNode.appendChild(so);
    document.getElementById('astra-sign-out').addEventListener('click', function(ev) {
      ev.preventDefault();
      localStorage.removeItem('astra_api_token');
      localStorage.removeItem('astra_token_expires');
      localStorage.removeItem('astra_username');
      localStorage.removeItem('astra_user_id');
      location.reload();
    });
  } else {
    el.innerHTML = '<a href="/auth/callback?return=' + encodeURIComponent(location.pathname) + '">Sign In</a>';
  }
})();
</script>`;
}
