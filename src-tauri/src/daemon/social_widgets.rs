//! Client-hydrated social widgets for the public gallery pages: the follow
//! button + follower count, and the signed-in notification bell strip.
//!
//! The daemon's pages are server-rendered and publicly cached, so the
//! embedded markup must be identical for every viewer — all per-viewer
//! state (follow state, bell, badge) hydrates client-side over the
//! HttpOnly `astra_session` cookie (`fetch(..., {credentials:
//! 'same-origin'})`). Worker-era parity: `worker/src/lib/social-widgets.ts`
//! + `auth-nav.ts`, minus the Clerk/localStorage token model.
//!
//! The pages carrying this snippet style themselves independently (inline
//! profile CSS, the viewer bundle), so the CSS here is self-contained —
//! literal colors from the landing palette, no `var()` dependencies.

/// Follow widget + bell embed for the profile page: rendered inline in the
/// document flow, under the `@handle` heading.
pub fn embed(target_user_id: &str, handle: &str) -> String {
    render(target_user_id, handle, "")
}

/// The same embed for the gallery viewer page, injected before `</body>`:
/// the widget floats as a fixed chip so it overlays the viewer chrome.
pub fn embed_floating(target_user_id: &str, handle: &str) -> String {
    render(target_user_id, handle, " floating")
}

fn render(target_user_id: &str, handle: &str, extra_class: &str) -> String {
    format!(
        r#"<style>{WIDGET_CSS}</style><div class="follow-widget{extra_class}" data-target-id="{id}" data-handle="{handle}"><span class="follower-count"></span><button type="button" class="btn-follow" hidden></button><a class="follow-signin" href="/app" hidden>Sign in to follow</a></div><script>{WIDGET_JS}</script>"#,
        id = escape(target_user_id),
        handle = escape(handle),
    )
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

const WIDGET_CSS: &str = r#"
.follow-widget{display:inline-flex;align-items:center;gap:.75rem;margin:.5rem 0;font-family:system-ui,sans-serif}
.follow-widget.floating{position:fixed;left:1rem;bottom:1rem;z-index:60;background:rgba(15,20,36,.92);border:1px solid rgba(99,102,241,.25);border-radius:2px;padding:.45rem .9rem;backdrop-filter:blur(6px)}
.follower-count{font-size:.8rem;color:#6b7280;letter-spacing:.04em}
.follow-signin{font-size:.78rem;color:#8ab4ff;text-decoration:none;letter-spacing:.04em}
.follow-signin:hover{color:#c4b5fd}
.btn-follow{padding:.4rem 1.2rem;border-radius:2px;font-size:.75rem;font-weight:500;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:all .3s;border:1px solid rgba(99,102,241,.3);background:transparent;color:#c8cdd8}
.btn-follow:hover{border-color:#8b5cf6;color:#e8ecf4}
.btn-follow.following{background:#6366f1;border-color:#6366f1;color:#fff}
.btn-follow.following:hover{background:#ef4444;border-color:#ef4444}
.astra-social-strip{position:fixed;top:.75rem;right:.75rem;z-index:70;display:flex;align-items:center;gap:.8rem;background:rgba(15,20,36,.92);border:1px solid rgba(99,102,241,.25);border-radius:2px;padding:.4rem .8rem;font-family:system-ui,sans-serif;font-size:.8rem;backdrop-filter:blur(6px)}
.astra-social-strip a{color:#c8cdd8;text-decoration:none}
.astra-social-strip a:hover{color:#c4b5fd}
.notif-bell{position:relative;background:none;border:none;cursor:pointer;font-size:.95rem;line-height:1;padding:.1rem;color:#c8cdd8}
.notif-badge{position:absolute;top:-7px;right:-9px;background:#ef4444;color:#fff;font-size:.58rem;border-radius:50%;min-width:14px;height:14px;line-height:14px;text-align:center;padding:0 2px}
.notif-dropdown{position:fixed;top:3rem;right:.75rem;z-index:70;width:20rem;max-width:calc(100vw - 1.5rem);background:#0f1424;border:1px solid rgba(99,102,241,.25);border-radius:2px;font-family:system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.notif-head{display:flex;justify-content:space-between;align-items:center;padding:.6rem .9rem;border-bottom:1px solid rgba(99,102,241,.15);color:#e8ecf4;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase}
.notif-head button{background:none;border:none;color:#8ab4ff;cursor:pointer;font-size:.72rem}
.notif-head button:hover{color:#c4b5fd}
.notif-list{list-style:none;margin:0;padding:0;max-height:19rem;overflow-y:auto}
.notif-item{display:block;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid rgba(99,102,241,.08);padding:.65rem .9rem;color:#8891a4;font-size:.8rem;line-height:1.45;cursor:pointer}
.notif-item:hover{background:#151b2e;color:#c8cdd8}
.notif-item.unread{color:#c8cdd8;border-left:2px solid #6366f1}
.notif-empty{padding:1rem .9rem;color:#6b7280;font-size:.8rem}
"#;

const WIDGET_JS: &str = r#"
(function(){
'use strict';
var w=document.querySelector('.follow-widget');
if(!w)return;
var targetId=w.getAttribute('data-target-id');
var countEl=w.querySelector('.follower-count');
var btn=w.querySelector('.btn-follow');
var signin=w.querySelector('.follow-signin');
var followers=0;

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function renderCount(){countEl.textContent=followers+' follower'+(followers===1?'':'s');}

fetch('/api/social/counts/user/'+encodeURIComponent(targetId))
  .then(function(r){return r.ok?r.json():null;})
  .then(function(d){if(d){followers=d.followers||0;renderCount();}})
  .catch(function(){});

fetch('/api/me',{credentials:'same-origin',headers:{'Accept':'application/json'}})
  .then(function(r){return r.ok?r.json():null;})
  .then(function(me){
    if(!me){signin.hidden=false;return;}
    buildStrip(me);
    if(me.user_id===targetId)return;
    fetch('/api/social/is-following?target_kind=user&target_id='+encodeURIComponent(targetId),{credentials:'same-origin'})
      .then(function(r){return r.ok?r.json():null;})
      .then(function(d){if(d){setState(!!d.following);btn.hidden=false;}})
      .catch(function(){});
  })
  .catch(function(){});

function setState(following){
  btn.textContent=following?'Following':'Follow';
  btn.classList.toggle('following',following);
}

btn.addEventListener('click',function(){
  if(btn.disabled)return;
  btn.disabled=true;
  var following=btn.classList.contains('following');
  fetch('/api/social/follow',{
    method:following?'DELETE':'POST',
    credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({target_kind:'user',target_id:targetId})
  }).then(function(r){
    btn.disabled=false;
    if(!r.ok)return;
    setState(!following);
    followers=Math.max(0,followers+(following?-1:1));
    renderCount();
  }).catch(function(){btn.disabled=false;});
});

function buildStrip(me){
  var strip=document.createElement('div');
  strip.className='astra-social-strip';
  strip.innerHTML='<a href="/app">@'+esc(me.username||me.user_id)+'</a>'+
    '<button type="button" class="notif-bell" title="Notifications">&#128276;<span class="notif-badge" hidden></span></button>';
  document.body.appendChild(strip);
  var badge=strip.querySelector('.notif-badge');
  var bell=strip.querySelector('.notif-bell');
  var dropdown=null;

  function refreshBadge(){
    fetch('/api/social/notifications/unread-count',{credentials:'same-origin'})
      .then(function(r){return r.ok?r.json():null;})
      .then(function(d){
        if(!d)return;
        var n=d.count||0;
        badge.hidden=n===0;
        badge.textContent=n>9?'9+':String(n);
      })
      .catch(function(){});
  }
  refreshBadge();
  setInterval(refreshBadge,60000);

  function displaySource(e){
    var url=e.event&&e.event.payload&&e.event.payload.url;
    if(url&&url.charAt(0)==='/'){
      var seg=url.split('/')[1]||'';
      if(seg.charAt(0)==='@')return seg;
    }
    return '@'+(e.event&&e.event.source?e.event.source:'someone');
  }

  function closeDropdown(){if(dropdown){dropdown.remove();dropdown=null;}}

  bell.addEventListener('click',function(){
    if(dropdown){closeDropdown();return;}
    dropdown=document.createElement('div');
    dropdown.className='notif-dropdown';
    dropdown.innerHTML='<div class="notif-head">Notifications<button type="button" class="notif-read-all">Mark all read</button></div><ul class="notif-list"><li class="notif-empty">Loading…</li></ul>';
    document.body.appendChild(dropdown);
    dropdown.querySelector('.notif-read-all').addEventListener('click',function(){
      fetch('/api/social/notifications/read-all',{method:'POST',credentials:'same-origin'})
        .then(function(){
          badge.hidden=true;
          dropdown&&dropdown.querySelectorAll('.notif-item.unread').forEach(function(el){el.classList.remove('unread');});
        })
        .catch(function(){});
    });
    fetch('/api/social/notifications?limit=10',{credentials:'same-origin'})
      .then(function(r){return r.ok?r.json():null;})
      .then(function(d){
        if(!dropdown)return;
        var list=dropdown.querySelector('.notif-list');
        var items=(d&&d.items)||[];
        if(items.length===0){list.innerHTML='<li class="notif-empty">Nothing yet — follow a photographer and their publishes land here.</li>';return;}
        list.innerHTML=items.map(function(e){
          var title=(e.event&&e.event.payload&&e.event.payload.title)||'a gallery';
          var url=(e.event&&e.event.payload&&e.event.payload.url)||'';
          return '<li><button type="button" class="notif-item'+(e.read?'':' unread')+'" data-id="'+esc(e.id)+'" data-url="'+esc(url)+'">'+esc(displaySource(e))+' published '+esc(title)+'</button></li>';
        }).join('');
        list.querySelectorAll('.notif-item').forEach(function(el){
          el.addEventListener('click',function(){
            var id=el.getAttribute('data-id');
            var url=el.getAttribute('data-url');
            fetch('/api/social/notifications/'+encodeURIComponent(id)+'/read',{method:'POST',credentials:'same-origin'})
              .catch(function(){})
              .then(function(){if(url){location.href=url;}else{el.classList.remove('unread');refreshBadge();}});
          });
        });
      })
      .catch(function(){});
  });
}
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embed_escapes_and_carries_target_attributes() {
        let html = embed("user-\"1\"", "alice<h>");
        assert!(html.contains(r#"data-target-id="user-&quot;1&quot;""#));
        assert!(html.contains(r#"data-handle="alice&lt;h&gt;""#));
        assert!(html.contains("follow-widget"));
        assert!(html.contains("follow-signin"));
        // One embeddable unit: style + markup + script.
        assert!(html.starts_with("<style>"));
        assert!(html.ends_with("</script>"));
    }

    #[test]
    fn floating_variant_adds_the_class() {
        assert!(embed_floating("u1", "alice").contains(r#"class="follow-widget floating""#));
        assert!(embed("u1", "alice").contains(r#"class="follow-widget""#));
        assert!(!embed("u1", "alice").contains(r#"class="follow-widget floating""#));
    }
}
