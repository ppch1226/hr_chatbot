/* 인사해삐 공통 스크립트: 세션 · 레이아웃(헤더/푸터) · API · 마크다운 */
window.HR = (() => {
  const store = {
    get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const role = () => store.get('hrhappy.role');
  const name = () => store.get('hrhappy.name', 'OO');
  const isAdmin = () => role() === 'admin';
  const botName = () => (isAdmin() ? '인사해삐M' : '인사해삐');
  const mascot = () => (isAdmin() ? '/img/mascot-m.svg' : '/img/mascot.svg');

  function sessionId() {
    let id = store.get('hrhappy.sid');
    if (!id) { id = Math.random().toString(36).slice(2, 10); store.set('hrhappy.sid', id); }
    return id;
  }

  function login(r, n) { store.set('hrhappy.role', r); store.set('hrhappy.name', n || 'OO'); store.del('hrhappy.sid'); }
  function logout() { ['hrhappy.role', 'hrhappy.name', 'hrhappy.sid'].forEach(store.del); location.href = '/'; }

  // 개인정보 수집·이용 동의 ('Y' | 'N' | '' = 미선택)
  const consent = () => store.get('hrhappy.consent');
  function setConsent(v) { store.set('hrhappy.consent', v); }
  function requireConsent() {
    if (consent() === 'Y') return true;
    location.replace('/mypage.html?next=chat');
    return false;
  }

  function guard(adminOnly = false) {
    if (!role()) { location.replace('/'); return false; }
    if (adminOnly && !isAdmin()) { location.replace('/chat.html'); return false; }
    return true;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = (t) => DOMPurify.sanitize(marked.parse(String(t ?? ''), { breaks: true, gfm: true }));

  async function api(path, { method = 'GET', body } = {}) {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `요청 실패 (${r.status})`);
    return j;
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  const NAV = {
    employee: [
      { href: '/chat.html', icon: 'smart_toy', label: '인사해삐(AI챗봇)' },
      { href: '/faq.html', icon: 'help', label: '자주 찾는 질문(FAQ)' },
      { href: '/mypage.html', icon: 'account_circle', label: '마이페이지' },
    ],
    admin: [
      { href: '/chat.html', icon: 'smart_toy', label: '인사해삐M(AI챗봇)' },
      { href: '/faq-admin.html', icon: 'help', label: '자주 찾는 질문 관리' },
      { href: '/risk.html', icon: 'notifications_active', label: '리스크 조기 알림' },
      { href: '/compliance.html', icon: 'verified_user', label: '컴플라이언스 관리' },
      { href: '/mypage.html', icon: 'account_circle', label: '마이페이지' },
    ],
  };

  const logo = (h = 'h-8 md:h-9') =>
    `<img src="/img/logo.png" alt="KT IS" class="${h} object-contain" onerror="this.outerHTML='<span class=&quot;text-xl md:text-2xl font-extrabold tracking-tight text-slate-900&quot;>KT IS</span>'">`;

  function layout(activeHref) {
    const items = NAV[isAdmin() ? 'admin' : 'employee'];
    const nav = items.map((i) => {
      const on = i.href === activeHref;
      return `<a href="${i.href}" class="relative inline-flex items-center gap-2 px-3 py-2 text-sm whitespace-nowrap transition-all ${on ? 'font-bold text-slate-900' : 'font-medium text-slate-500 hover:text-slate-900'}">
        <span class="material-symbols-outlined text-[18px] ${on ? 'text-[#E60012]' : 'text-slate-400'}">${i.icon}</span><span>${i.label}</span>
        ${on ? '<span class="absolute bottom-0 inset-x-2 h-[2.5px] bg-[#E60012] rounded-full"></span>' : ''}</a>`;
    }).join('');
    const initials = esc(name()).slice(0, 2);
    const who = isAdmin() ? '인사담당자' : '임직원';

    document.body.insertAdjacentHTML('afterbegin', `
      <div class="bg-wave"><img src="/img/wave.svg" alt=""><div class="fade-l"></div><div class="fade-b"></div><div class="glow"></div></div>
      <header class="relative z-30 w-full bg-white/90 backdrop-blur-md border-b border-slate-200">
        <div class="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between py-4 md:py-6 gap-4">
          <div class="flex items-center gap-6 lg:gap-8 min-w-0">
            <a href="/chat.html" class="flex items-center gap-4 shrink-0">${logo()}<div class="h-5 w-px bg-slate-200"></div>
              <span class="text-base md:text-lg font-extrabold tracking-tight text-slate-900">HR Happy AI</span></a>
            <nav class="hidden lg:flex items-center gap-1.5">${nav}</nav>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <a href="/mypage.html" title="마이페이지" class="flex items-center gap-2 hover:opacity-80">
            <div class="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center font-bold text-xs ring-2 ring-red-500/20">${initials}</div>
            <div class="hidden md:flex flex-col text-left">
              <span class="text-xs font-bold text-slate-900 leading-tight">${who} (${esc(name())}님)</span>
              <span class="text-[10px] text-slate-400">사내인사포털 로그인됨</span>
            </div></a>
            <button onclick="HR.logout()" title="로그아웃" class="ml-1 w-8 h-8 rounded-lg text-slate-400 hover:text-[#E60012] hover:bg-red-50 flex items-center justify-center"><span class="material-symbols-outlined text-[20px]">logout</span></button>
          </div>
        </div>
        <nav class="lg:hidden flex items-center gap-1 overflow-x-auto scrollbar-none px-3 pb-2">${nav}</nav>
      </header>`);

    document.body.insertAdjacentHTML('beforeend', `
      <footer class="relative z-20 w-full bg-white/95 border-t border-slate-200/80 py-6 mt-auto">
        <div class="max-w-[1600px] mx-auto px-6 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <div class="flex items-center gap-3">${logo('h-5 opacity-80')}<span class="text-xs font-bold text-slate-700">KT IS 인사해삐 (HR Happy AI) 노무·인사 지원 포털</span></div>
          <div class="flex flex-wrap items-center justify-center gap-4 text-xs text-slate-500 font-medium">
            <a class="text-[#E60012] font-bold hover:underline" href="#">개인정보처리방침</a><span>·</span>
            <a class="hover:text-[#E60012]" href="#">정보보안 규정</a><span>·</span>
            <a class="hover:text-[#E60012]" href="/chat.html?q=${encodeURIComponent('취업규칙 주요 내용 알려줘')}">취업규칙 안내</a><span>·</span>
            <a class="hover:text-[#E60012]" href="#">사내 헬프데스크</a>
          </div>
          <div class="text-[11px] text-slate-400 flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">shield</span><span>© 2026 KT IS Corp. All rights reserved.</span></div>
        </div>
      </footer>`);
  }

  // 공통 위젯: 통계 막대
  function statBars(list, { limit = 5 } = {}) {
    const max = Math.max(1, ...list.map((x) => x.count));
    const colors = ['bg-[#E60012]', 'bg-slate-800', 'bg-slate-400', 'bg-slate-400', 'bg-slate-300'];
    const badge = ['bg-[#E60012] text-white', 'bg-slate-800 text-white', 'bg-slate-200 text-slate-800', 'bg-slate-200 text-slate-800', 'bg-slate-200 text-slate-800'];
    return list.slice(0, limit).map((x, i) => `
      <div class="space-y-2">
        <div class="flex items-center justify-between text-sm gap-3">
          <div class="flex items-center gap-2.5 min-w-0"><span class="w-6 h-6 rounded-md ${badge[i]} flex items-center justify-center font-bold text-xs shrink-0">${i + 1}</span>
            <span class="font-bold text-slate-900 text-base truncate">${esc(x.key)}</span></div>
          <span class="text-slate-700 font-semibold text-sm shrink-0">${x.count.toLocaleString()}건 (${x.pct}%)</span>
        </div>
        <div class="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden"><div class="${colors[i]} h-full rounded-full transition-all" style="width:${Math.round((x.count / max) * 90)}%"></div></div>
      </div>`).join('');
  }

  return { role, name, isAdmin, consent, setConsent, requireConsent, botName, mascot, sessionId, login, logout, guard, esc, md, api, toast, layout, statBars, logo };
})();
