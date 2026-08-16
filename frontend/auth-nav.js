function getToken() {
  return localStorage.getItem('snip_token');
}

function getUser() {
  const raw = localStorage.getItem('snip_user');
  return raw ? JSON.parse(raw) : null;
}

function setSession(token, user) {
  localStorage.setItem('snip_token', token);
  localStorage.setItem('snip_user', JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem('snip_token');
  localStorage.removeItem('snip_user');
}

function renderNav(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const user = getUser();

  if (user) {
    el.innerHTML = `
      <span style="color:#55606f;">${escapeHtmlForNav(user.email)}</span>
      &nbsp;&middot;&nbsp;<a href="/my-links.html">my links</a>
      &nbsp;&middot;&nbsp;<a href="#" id="navLogout">log out</a>
    `;
    document.getElementById('navLogout').addEventListener('click', (e) => {
      e.preventDefault();
      clearSession();
      window.location.href = '/';
    });
  } else {
    el.innerHTML = `<a href="/auth.html">log in / sign up</a>`;
  }
}

function escapeHtmlForNav(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}