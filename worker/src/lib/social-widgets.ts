/**
 * Shared client-side social widgets: follow buttons, follower counts.
 * Included on profile and object pages.
 */

/**
 * Renders a follow button placeholder + follower count.
 * Client-side JS hydrates based on auth state.
 */
export function followButton(targetKind: string, targetId: string): string {
  return `<div class="follow-widget" data-target-kind="${targetKind}" data-target-id="${targetId}">
    <span class="follower-count" id="follower-count"></span>
    <button class="btn-follow" id="follow-btn" style="display:none;"></button>
  </div>`;
}

/**
 * CSS for social widgets.
 */
export function socialWidgetStyles(): string {
  return `
.follow-widget {
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.follower-count {
  font-size: 0.8rem;
  color: var(--text-dim);
  letter-spacing: 0.04em;
}

.btn-follow {
  padding: 0.4rem 1.2rem;
  border-radius: 2px;
  font-family: var(--sans);
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 0.3s;
  border: 1px solid rgba(99, 102, 241, 0.3);
  background: transparent;
  color: var(--text);
}

.btn-follow:hover {
  border-color: var(--light);
  color: var(--text-bright);
}

.btn-follow.following {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btn-follow.following:hover {
  background: #ef4444;
  border-color: #ef4444;
}`;
}

/**
 * Client-side script that hydrates follow buttons and loads counts.
 */
export function socialWidgetScript(): string {
  return `<script>
(function() {
  var widget = document.querySelector('.follow-widget');
  if (!widget) return;

  var targetKind = widget.getAttribute('data-target-kind');
  var targetId = widget.getAttribute('data-target-id');
  var countEl = document.getElementById('follower-count');
  var btn = document.getElementById('follow-btn');
  var token = localStorage.getItem('astra_api_token');
  var expires = localStorage.getItem('astra_token_expires');
  var userId = localStorage.getItem('astra_user_id');
  var isAuthed = token && expires && new Date(expires) > new Date();

  // Load follower count (public)
  fetch('/api/social/counts/' + encodeURIComponent(targetKind) + '/' + encodeURIComponent(targetId))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var n = data.followers || 0;
      countEl.textContent = n + ' follower' + (n === 1 ? '' : 's');
    })
    .catch(function() {});

  // Don't show follow button for own profile
  if (targetKind === 'user' && targetId === userId) return;

  // Show follow button if authenticated
  if (!isAuthed) {
    btn.style.display = '';
    btn.textContent = 'Follow';
    btn.addEventListener('click', function() {
      location.href = '/auth/callback?return=' + encodeURIComponent(location.pathname);
    });
    return;
  }

  btn.style.display = '';
  btn.textContent = '...';
  btn.disabled = true;

  // Check if already following
  fetch('/api/social/is-following/' + encodeURIComponent(targetKind) + '/' + encodeURIComponent(targetId), {
    headers: { 'Authorization': 'Bearer ' + token }
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      btn.disabled = false;
      setFollowState(data.following);
    })
    .catch(function() { btn.style.display = 'none'; });

  btn.addEventListener('click', function() {
    if (btn.disabled) return;
    btn.disabled = true;
    var isFollowing = btn.classList.contains('following');
    var method = isFollowing ? 'DELETE' : 'POST';

    fetch('/api/social/follow', {
      method: method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ targetKind: targetKind, targetId: targetId })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        btn.disabled = false;
        setFollowState(data.following);
        // Update count
        var current = parseInt(countEl.textContent) || 0;
        var newCount = data.following ? current + 1 : Math.max(0, current - 1);
        countEl.textContent = newCount + ' follower' + (newCount === 1 ? '' : 's');
      })
      .catch(function() { btn.disabled = false; });
  });

  function setFollowState(following) {
    if (following) {
      btn.textContent = 'Following';
      btn.classList.add('following');
    } else {
      btn.textContent = 'Follow';
      btn.classList.remove('following');
    }
  }
})();
</script>`;
}
