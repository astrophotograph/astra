/**
 * Shared auth-aware navigation helpers for server-rendered pages.
 *
 * Auth state lives in localStorage (client-side). The server renders a
 * placeholder `<li id="auth-nav">` and the shared script fills it in.
 */

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
