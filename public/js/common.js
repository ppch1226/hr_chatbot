/* 인사해삐 공통 스크립트: 세션 · 레이아웃(헤더/푸터) · API · 마크다운 */
window.HR = (() => {
  const store = {
    get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  // 로그인 세션은 탭마다 따로 (sessionStorage) → 한 브라우저에서 탭별로 다른 계정 동시 사용 가능
  // localStorage에는 '로그인 유지' 때 마지막 로그인만 기본값으로 남겨, 새로 연 탭이 그 계정으로 시작하게 함
  const tab = {
    get(k, d = '') { try { return sessionStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
    del(k) { try { sessionStorage.removeItem(k); } catch {} },
  };
  (function adoptDefaultLogin() {
    if (tab.get('hrhappy.role')) return;
    const r = store.get('hrhappy.last.role'), n = store.get('hrhappy.last.name');
    if (r && n) { tab.set('hrhappy.role', r); tab.set('hrhappy.name', n); }
  })();
  const role = () => tab.get('hrhappy.role');
  const name = () => tab.get('hrhappy.name', 'OO');
  const isAdmin = () => role() === 'admin';
  const botName = () => (isAdmin() ? '인사해삐m' : '인사해삐');
  const mascot = () => (isAdmin() ? '/img/chars/rabbit-m.webp' : '/img/chars/rabbit.webp');

  // 프로필 캐릭터: 기본 토끼 + 12간지 (토끼 자리는 고양이)
  const CHARS = [
    { id: 'rabbit', name: '토끼해삐', zodiac: '묘(卯)' }, { id: 'rat', name: '쥐해삐', zodiac: '자(子)' }, { id: 'ox', name: '소해삐', zodiac: '축(丑)' },
    { id: 'tiger', name: '호랑이해삐', zodiac: '인(寅)' }, { id: 'cat', name: '고양이해삐', zodiac: '묘(卯)' }, { id: 'dragon', name: '용해삐', zodiac: '진(辰)' },
    { id: 'snake', name: '뱀해삐', zodiac: '사(巳)' }, { id: 'horse', name: '말해삐', zodiac: '오(午)' }, { id: 'goat', name: '양해삐', zodiac: '미(未)' },
    { id: 'monkey', name: '원숭이해삐', zodiac: '신(申)' }, { id: 'rooster', name: '닭해삐', zodiac: '유(酉)' }, { id: 'dog', name: '강아지해삐', zodiac: '술(戌)' },
    { id: 'pig', name: '돼지해삐', zodiac: '해(亥)' },
  ];
  const charKey = () => `hrhappy.char.${role()}.${name()}`;
  const charOf = (id) => CHARS.find((c) => c.id === id) || CHARS[0];
  const char = () => charOf(store.get(charKey(), 'rabbit'));
  const charImg = (c = char()) => (c.id === 'rabbit' ? mascot() : `/img/chars/${c.id}.webp`);
  function setChar(id) {
    store.set(charKey(), charOf(id).id);
    document.querySelectorAll('[data-avatar]').forEach((e) => (e.src = charImg()));
  }

  // 챗봇 대화 세션 ID도 탭마다 따로 (두 탭의 대화가 섞이지 않게)
  function sessionId() {
    let id = tab.get('hrhappy.sid');
    if (!id) { id = Math.random().toString(36).slice(2, 10); tab.set('hrhappy.sid', id); }
    return id;
  }

  function login(r, n, { keep = true } = {}) {
    tab.set('hrhappy.role', r); tab.set('hrhappy.name', n || 'OO'); tab.del('hrhappy.sid'); tab.del('hrhappy.bellToast');
    if (keep) { store.set('hrhappy.last.role', r); store.set('hrhappy.last.name', n || 'OO'); }
    else { store.del('hrhappy.last.role'); store.del('hrhappy.last.name'); }
  }
  function logout() {
    // 이 탭의 계정이 '로그인 유지' 기본값이면 그것도 지움 (다른 탭의 세션은 그대로)
    if (store.get('hrhappy.last.role') === role() && store.get('hrhappy.last.name') === name()) { store.del('hrhappy.last.role'); store.del('hrhappy.last.name'); }
    ['hrhappy.role', 'hrhappy.name', 'hrhappy.sid', 'hrhappy.bellToast'].forEach(tab.del);
    location.href = '/';
  }

  // 개인정보 수집·이용 동의 ('Y' | 'N' | '' = 미선택) — 계정별로 저장
  const consentKey = () => `hrhappy.consent.${role()}.${name()}`;
  const consent = () => store.get(consentKey());
  function setConsent(v) { store.set(consentKey(), v); }
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
      { href: '/chat.html', icon: 'smart_toy', label: '인사해삐m(AI챗봇)' },
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
      return `<a href="${i.href}" ${on ? 'aria-current="page"' : ''} class="nav-item relative inline-flex items-center gap-1.5 px-3 xl:px-3.5 text-[13.5px] xl:text-sm whitespace-nowrap rounded-lg transition-colors ${on ? 'font-bold text-slate-900' : 'font-medium text-slate-500 hover:text-slate-900 hover:bg-slate-50'}">
        <span class="material-symbols-outlined text-[18px] ${on ? 'text-[#E60012]' : 'text-slate-400'}">${i.icon}</span><span>${i.label}</span>
        ${on ? '<span class="nav-bar absolute bottom-0 inset-x-3 h-[3px] bg-[#E60012] rounded-t-full"></span>' : ''}</a>`;
    }).join('');
    const initials = esc(name()).slice(0, 2);
    const who = isAdmin() ? '인사담당자' : '임직원';

    document.body.insertAdjacentHTML('afterbegin', `
      <div class="bg-wave"><img src="/img/wave.svg" alt=""><div class="fade-l"></div><div class="fade-b"></div><div class="glow"></div></div>
      <header class="relative z-30 w-full bg-white/90 backdrop-blur-md border-b border-slate-200">
        <div class="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 flex items-stretch justify-between h-16 md:h-[76px] gap-4">
          <div class="flex items-stretch min-w-0">
            <a href="/chat.html" class="flex items-center gap-3 md:gap-4 shrink-0 pr-5 xl:pr-8">${logo()}<div class="h-5 w-px bg-slate-200"></div>
              <span class="text-base md:text-lg font-extrabold tracking-tight text-slate-900">HR Happy AI</span></a>
            <nav class="hidden lg:flex items-stretch gap-0.5 xl:gap-1.5 py-0 [&>a]:my-0">${nav}</nav>
          </div>
          <div class="flex items-center gap-2 shrink-0 self-center">
            <div class="relative">
              <button id="bell-btn" type="button" title="알림" aria-label="알림" aria-haspopup="true" aria-expanded="false" class="relative w-9 h-9 rounded-xl text-slate-500 hover:text-[#E60012] hover:bg-red-50 flex items-center justify-center">
                <span class="material-symbols-outlined text-[22px]">notifications</span>
                <span id="bell-badge" class="hidden absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[#E60012] text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-white"></span>
              </button>
              <div id="bell-panel" class="hidden absolute right-0 mt-2 w-[min(92vw,380px)] bg-white rounded-2xl shadow-2xl border border-slate-200 z-50 overflow-hidden"></div>
            </div>
            <a href="/mypage.html" title="마이페이지" class="flex items-center gap-2 hover:opacity-80">
            <img data-avatar src="${charImg()}" alt="${initials} 프로필 캐릭터" class="w-9 h-9 object-contain">
            <div class="hidden md:flex flex-col text-left">
              <span class="text-xs font-bold text-slate-900 leading-tight">${who} (${esc(name())}님)</span>
              <span class="text-[10px] text-slate-400">사내인사포털 로그인됨</span>
            </div></a>
            <button onclick="HR.logout()" title="로그아웃" class="ml-1 w-8 h-8 rounded-lg text-slate-400 hover:text-[#E60012] hover:bg-red-50 flex items-center justify-center"><span class="material-symbols-outlined text-[20px]">logout</span></button>
          </div>
        </div>
        <nav class="lg:hidden flex items-stretch h-11 gap-1 overflow-x-auto scrollbar-none px-3 border-t border-slate-100">${nav}</nav>
      </header>`);

    document.body.insertAdjacentHTML('beforeend', `
      <footer class="relative z-20 w-full bg-white/95 border-t border-slate-200/80 py-6 mt-auto">
        <div class="max-w-[1600px] mx-auto px-6 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <div class="flex items-center gap-3">${logo('h-5')}<span class="text-xs font-bold text-slate-700">KT IS 인사해삐 (HR Happy AI) 노무·인사 지원 포털</span></div>
          <div class="flex flex-wrap items-center justify-center gap-4 text-xs text-slate-500 font-medium">
            <a class="text-[#E60012] font-bold hover:underline" href="#">개인정보처리방침</a><span>·</span>
            <a class="hover:text-[#E60012]" href="#">정보보안 규정</a><span>·</span>
            <a class="hover:text-[#E60012]" href="/chat.html?q=${encodeURIComponent('취업규칙 주요 내용 알려줘')}">취업규칙 안내</a><span>·</span>
            <a class="hover:text-[#E60012]" href="#">사내 헬프데스크</a>
          </div>
          <div class="text-[11px] text-slate-400 flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">shield</span><span>© 2026 KT IS Corp. All rights reserved.</span></div>
        </div>
      </footer>`);
    initBell();
  }

  // ── 최근 질문 주제 (질문 원문이 아니라 주제만, 이 브라우저에만 저장)
  const TOPIC_WORDS = [
    ['휴가·휴직', /휴가|연차|휴직|병가|공가|청원/], ['출산·육아', /출산|육아|임신|태아|난임|자녀|보육/], ['급여·수당', /급여|월급|연봉|수당|보수|상여|퇴직금|성과급/],
    ['복지', /복지|포인트|학자금|의료비|경조|사택|주택/], ['평가·승진', /평가|승진|고과|인사고과/], ['징계·복무', /징계|복무|무단|해고|괴롭힘|성희롱/],
    ['채용·인사이동', /채용|전보|발령|전직|이동|임용/], ['근무시간·유연근무', /근무시간|유연|재택|시간외|연장근무|야근|출퇴근/], ['국외근무', /국외|해외|지사|파견/], ['교육·연수', /교육|연수|자기개발/],
  ];
  const rtKey = () => `hrhappy.recentTopics.${role()}.${name()}`;
  function recentTopics() {
    try { return JSON.parse(store.get(rtKey(), '[]')); } catch { return []; }
  }
  function addRecentTopics(question) {
    const hit = TOPIC_WORDS.filter(([, re]) => re.test(question)).map(([t]) => t);
    if (!hit.length) return;
    const list = [...hit, ...recentTopics().filter((t) => !hit.includes(t))].slice(0, 5);
    store.set(rtKey(), JSON.stringify(list));
  }
  const clearRecentTopics = () => store.del(rtKey());

  // ── 헤더 알림함
  const KIND = {
    'reg-change': { icon: 'gavel', color: 'bg-red-50 text-[#E60012]', label: '사규 개정' },
    'law-change': { icon: 'balance', color: 'bg-blue-50 text-[#0050CC]', label: '법령 개정' },
    effective: { icon: 'event', color: 'bg-amber-50 text-amber-600', label: '시행일' },
    compliance: { icon: 'verified_user', color: 'bg-emerald-50 text-emerald-600', label: '정합성 분석' },
    risk: { icon: 'warning', color: 'bg-orange-50 text-orange-600', label: '리스크' },
  };
  let bellData = null, bellTab = 'related';
  const who = () => `user=${encodeURIComponent(name())}&role=${isAdmin() ? 'admin' : 'employee'}`;
  async function refreshBell({ toastOnLogin = false } = {}) {
    try {
      bellData = await api(`/api/notifications?${who()}&recent=${encodeURIComponent(recentTopics().join(','))}`);
    } catch { return; }
    const badge = document.getElementById('bell-badge');
    if (!badge) return;
    const n = bellData.unreadRelated || 0;
    badge.textContent = n > 99 ? '99+' : n;
    badge.classList.toggle('hidden', !n);
    if (toastOnLogin && n && !sessionStorage.getItem('hrhappy.bellToast')) {
      sessionStorage.setItem('hrhappy.bellToast', '1');
      toast(`나와 관련된 새 알림 ${n}건이 있어요. 오른쪽 위 종을 눌러 확인하세요.`);
    }
    if (!document.getElementById('bell-panel').classList.contains('hidden')) renderBell();
  }
  function renderBell() {
    const panel = document.getElementById('bell-panel');
    const items = (bellData && bellData.items) || [];
    const rel = items.filter((x) => x.related), all = items;
    const list = bellTab === 'related' ? rel : all;
    const tab = (k, label, n) => `<button data-tab="${k}" class="flex-1 py-2.5 text-xs font-bold border-b-2 ${bellTab === k ? 'border-[#E60012] text-slate-900' : 'border-transparent text-slate-400 hover:text-slate-700'}">${label} <span class="ml-0.5 text-[10px] ${bellTab === k ? 'text-[#E60012]' : ''}">${n}</span></button>`;
    panel.innerHTML = `
      <div class="flex items-center justify-between px-4 pt-3.5 pb-1"><span class="text-sm font-extrabold text-slate-900">알림</span>
        <button id="bell-readall" class="text-[11px] font-semibold text-slate-400 hover:text-[#E60012]">모두 읽음</button></div>
      <div class="flex px-2">${tab('related', '나와 관련', rel.filter((x) => !x.read).length)}${tab('all', '전체', all.filter((x) => !x.read).length)}</div>
      <div class="max-h-[60vh] overflow-y-auto divide-y divide-slate-100">
        ${list.length ? list.slice(0, 30).map((x) => {
          const k = KIND[x.kind] || KIND['reg-change'];
          return `<a href="${x.kind === 'risk' ? x.link : '/notifications.html?id=' + encodeURIComponent(x.id)}" data-id="${esc(x.id)}" class="bell-item flex gap-3 px-4 py-3 hover:bg-slate-50 ${x.read ? 'opacity-60' : ''}">
            <span class="w-8 h-8 rounded-lg ${k.color} flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-[18px]">${k.icon}</span></span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5 text-[10px] text-slate-400"><span class="font-bold">${k.label}</span>·<span>${esc(String(x.createdAt).slice(0, 10))}</span>${x.read ? '' : '<span class="w-1.5 h-1.5 rounded-full bg-[#E60012]"></span>'}</span>
              <span class="block text-xs font-bold text-slate-900 leading-snug mt-0.5">${esc(x.title)}</span>
              ${x.reasons && x.reasons.length && x.related ? `<span class="flex flex-wrap gap-1 mt-1">${x.reasons.slice(0, 3).map((r) => `<span class="px-1.5 py-0.5 rounded bg-red-50 text-[#E60012] text-[10px] font-semibold">${esc(r)}</span>`).join('')}</span>` : ''}
            </span></a>`;
        }).join('') : `<div class="px-4 py-10 text-center text-xs text-slate-400">${bellTab === 'related' ? '나와 관련된 알림이 없어요.<br><a href="/mypage.html#prefs" class="text-[#E60012] font-semibold underline">알림 맞춤 설정</a>을 하면 더 정확해져요.' : '알림이 없어요.'}</div>`}
      </div>
      <a href="/notifications.html" class="block text-center py-2.5 text-xs font-bold text-slate-600 hover:text-[#E60012] border-t border-slate-100">알림 전체 보기</a>`;
    panel.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); bellTab = b.dataset.tab; renderBell(); }));
    panel.querySelector('#bell-readall').onclick = async (e) => {
      e.stopPropagation();
      await api('/api/notifications/read', { method: 'POST', body: { user: name(), role: isAdmin() ? 'admin' : 'employee', all: true } });
      refreshBell();
    };
    panel.querySelectorAll('.bell-item').forEach((a) => (a.onclick = () => { api('/api/notifications/read', { method: 'POST', body: { user: name(), role: isAdmin() ? 'admin' : 'employee', ids: [a.dataset.id] } }).catch(() => {}); }));
  }
  function initBell() {
    const btn = document.getElementById('bell-btn'), panel = document.getElementById('bell-panel');
    if (!btn) return;
    btn.onclick = (e) => {
      e.stopPropagation();
      const open = panel.classList.toggle('hidden') === false;
      btn.setAttribute('aria-expanded', open);
      if (open) renderBell();
    };
    panel.onclick = (e) => e.stopPropagation();
    document.addEventListener('click', () => { panel.classList.add('hidden'); btn.setAttribute('aria-expanded', false); });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && panel.classList.add('hidden'));
    refreshBell({ toastOnLogin: true });
    setInterval(() => refreshBell(), 5 * 60e3);
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

  return { CHARS, char, charImg, charOf, setChar, role, name, isAdmin, consent, setConsent, requireConsent, botName, mascot, sessionId, login, logout, guard, esc, md, api, toast, layout, statBars, logo, recentTopics, addRecentTopics, clearRecentTopics, refreshBell, KIND };
})();
