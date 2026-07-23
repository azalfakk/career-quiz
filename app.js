/* Угадай футболиста по карьере — v4
   Режимы: обычный (постепенное раскрытие карьеры), соревновательный (60с),
   игрок дня, «Кто дороже», дуэль по ссылке. Ачивки + эмблема клуба к нику. */

const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }

// ---------- тема ----------
function applyTheme() {
  const light = tg && tg.colorScheme === 'light';
  document.documentElement.classList.toggle('light', !!light);
}
applyTheme();
if (tg && tg.onEvent) tg.onEvent('themeChanged', applyTheme);

// ---------- хранилище ----------
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    if (tg && tg.CloudStorage) { try { tg.CloudStorage.setItem(k, JSON.stringify(v), () => {}); } catch (e) {} }
  }
};

let coins = store.get('coins', 100);
let winStreak = store.get('winStreak', 0);
let solved = store.get('solvedIds', []);
let everSolved = new Set(store.get('everSolved', []));
let stats = store.get('stats', { totalWins: 0, bestComp: 0, bestPrice: 0, dailyStreakMax: 0 });
let badge = store.get('badge', 0);
let difficulty = store.get('difficulty', null);

let mode = 'normal'; // normal | comp | daily | duel
let cur = null;
let finished = false;
let openedIdx = [];
let revealedRows = 1;
let photoOpen = false;

// comp
let compTime = 60, compScoreVal = 0, compTimer = null, compQueue = [];
// duel
let duel = null; // {seed, players:[], i, score, opp:{name, score}|null}
// price
let price = { streak: 0, total: 0, coins: 0, a: null, b: null, lock: false };

const DIFF_LABEL = { easy: 'Лёгкая', medium: 'Средняя', hard: 'Сложная', all: 'Микс' };
const $ = id => document.getElementById(id);

// ---------- сид-рандом ----------
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function seededShuffle(arr, seed) {
  const rnd = mulberry32(hashStr(seed)); const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function todayKey() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// ---------- ежедневный бонус ----------
(function daily() {
  const today = new Date().toDateString();
  const last = store.get('lastDay', '');
  if (last === today) return;
  const yesterday = new Date(Date.now() - 864e5).toDateString();
  let days = store.get('dayStreak', 0);
  days = (last === yesterday) ? days + 1 : 1;
  const bonus = 25 + Math.min((days - 1) * 5, 25);
  coins += bonus;
  store.set('dayStreak', days); store.set('lastDay', today); store.set('coins', coins);
  setTimeout(() => toast(`🎁 Ежедневный бонус: +${bonus} монет (день ${days})`), 600);
})();

// ---------- нечёткое сравнение ----------
function normRu(s) { return s.toLowerCase().replace(/ё/g, 'е').replace(/й/g, 'и').replace(/[^а-яе]/g, ''); }
function normEn(s) { return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ø/g, 'o').replace(/[^a-z]/g, ''); }
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 5) return 99;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[n];
}
function threshold(len) { return len <= 4 ? 1 : len <= 7 ? 2 : len <= 10 ? 3 : 4; }
function lastWord(s) { const p = s.trim().split(/\s+/); return p[p.length - 1]; }
function checkGuess(guess, p) {
  const isLatin = /[a-z]/i.test(guess) && !/[а-я]/i.test(guess);
  const norm = isLatin ? normEn : normRu;
  const targets = isLatin
    ? [p.en, lastWord(p.en)]
    : [p.n, lastWord(p.n), p.full, lastWord(p.full), ...(p.alt || []), ...(p.alt || []).map(lastWord)];
  // формы догадки: целиком и её последнее слово («Маркос Алонсо» → «Алонсо»)
  const gWhole = norm(guess);
  const gLast = norm(lastWord(guess));
  const gForms = gLast && gLast !== gWhole ? [gWhole, gLast] : [gWhole];
  const cands = [];
  targets.forEach(c => { const nc = norm(c || ''); if (nc) gForms.forEach(g => cands.push([g, nc])); });
  let best = 99, bestLen = 1;
  for (const [g, c] of cands) {
    if (!c) continue;
    const d = lev(g, c);
    if (d - threshold(c.length) < best - threshold(bestLen)) { best = d; bestLen = c.length; }
  }
  if (best <= threshold(bestLen)) return 2;
  if (best <= threshold(bestLen) + 1) return 1;
  return 0;
}

// ---------- лидерборд ----------
const BOARD_URL = 'https://jsonblob.com/api/jsonBlob/019f8f02-5291-78e4-9616-07a7671ed12b';
const PAGE_URL = 'https://azalfakk.github.io/career-quiz/';
function me() {
  const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  if (u) return { id: 'tg' + u.id, name: u.username ? '@' + u.username : [u.first_name, u.last_name].filter(Boolean).join(' ') };
  let gid = store.get('guestId', null);
  if (!gid) { gid = 'g' + Math.random().toString(36).slice(2, 8); store.set('guestId', gid); }
  return { id: gid, name: 'Гость-' + gid.slice(1, 5) };
}
async function boardGet() {
  const r = await fetch(BOARD_URL, { cache: 'no-store' });
  if (!r.ok) throw new Error('board http ' + r.status);
  const j = await r.json();
  return Array.isArray(j.scores) ? j.scores : [];
}
async function boardSubmit(score) {
  const who = me();
  const apply = scores => {
    const mine = scores.find(x => x.id === who.id);
    if (mine) { if (score > mine.s) { mine.s = score; mine.t = Date.now(); } mine.name = who.name; mine.b = badge || 0; }
    else scores.push({ id: who.id, name: who.name, s: score, t: Date.now(), b: badge || 0 });
    scores.sort((a, b) => b.s - a.s || a.t - b.t);
    return scores.slice(0, 100);
  };
  try {
    const scores = apply(await boardGet());
    await fetch(BOARD_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scores }) });
    return scores;
  } catch (e) {
    const scores = apply(store.get('localBoard', []));
    store.set('localBoard', scores);
    return scores;
  }
}
function crestImg(idOrUrl, cls) {
  const src = typeof idOrUrl === 'string' ? idOrUrl : `https://tmssl.akamaized.net/images/wappen/head/${idOrUrl}.png`;
  return `<img class="${cls}" src="${src}" alt="" onerror="this.style.display='none'">`;
}
function boardHTML(scores, highlightId) {
  if (!scores.length) return '<div class="sub">Пока никто не играл — будь первым!</div>';
  const medals = ['🥇', '🥈', '🥉'];
  const top3 = scores.slice(0, 3);
  const order = top3.length === 3 ? [top3[1], top3[0], top3[2]] : top3;
  const nm = p => esc(p.name) + (p.b ? ' ' + crestImg(p.b, 'nickCrest') : '');
  let h = '<div class="podium">' + order.map(p => {
    const isFirst = p === top3[0];
    return `<div class="pod ${isFirst ? 'first' : ''}"><div class="medal">${medals[top3.indexOf(p)]}</div><div class="pn">${nm(p)}</div><div class="ps">${p.s}</div></div>`;
  }).join('') + '</div>';
  if (scores.length > 3) {
    h += '<div class="lboard">' + scores.slice(3, 30).map((p, i) =>
      `<div class="lrow ${p.id === highlightId ? 'me' : ''}"><span class="pos">${i + 4}</span><span class="nm">${nm(p)}</span><span class="sc">${p.s}</span></div>`).join('') + '</div>';
  }
  const myPos = scores.findIndex(x => x.id === highlightId);
  if (myPos >= 0) h += `<div class="lnote">Твоё место: ${myPos + 1} из ${scores.length}</div>`;
  return h;
}
function esc(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

// ---------- ачивки ----------
const ACH = [
  { id: 'first', icon: '🎯', name: 'Дебют', desc: 'Угадай первого футболиста' },
  { id: 'w25', icon: '🏅', name: 'Четвертак', desc: 'Угадай 25 футболистов' },
  { id: 'w100', icon: '🎖', name: 'Сотка', desc: 'Угадай 100 футболистов' },
  { id: 'streak5', icon: '🔥', name: 'Горячая серия', desc: '5 верных подряд' },
  { id: 'streak10', icon: '☄️', name: 'В огне', desc: '10 верных подряд' },
  { id: 'comp10', icon: '⚡', name: 'Спринтер', desc: '10+ за минуту в соревновательном' },
  { id: 'comp15', icon: '🚀', name: 'Машина', desc: '15+ за минуту в соревновательном' },
  { id: 'daily3', icon: '📅', name: 'Постоянство', desc: 'Игрок дня 3 дня подряд' },
  { id: 'daily7', icon: '🗓', name: 'Неделя силы', desc: 'Игрок дня 7 дней подряд' },
  { id: 'price10', icon: '💰', name: 'Оценщик', desc: 'Серия 10 в «Кто дороже»' },
  { id: 'rich', icon: '🤑', name: 'Богач', desc: 'Накопи 500 монет' }
];
let achDone = new Set(store.get('achDone', []));
function unlock(id) {
  if (achDone.has(id)) return;
  achDone.add(id);
  store.set('achDone', [...achDone]);
  const a = ACH.find(x => x.id === id);
  if (a) setTimeout(() => toast(`${a.icon} Достижение: ${a.name}!`), 800);
}
function checkAch() {
  if (stats.totalWins >= 1) unlock('first');
  if (stats.totalWins >= 25) unlock('w25');
  if (stats.totalWins >= 100) unlock('w100');
  if (winStreak >= 5) unlock('streak5');
  if (winStreak >= 10) unlock('streak10');
  if (stats.bestComp >= 10) unlock('comp10');
  if (stats.bestComp >= 15) unlock('comp15');
  if (stats.dailyStreakMax >= 3) unlock('daily3');
  if (stats.dailyStreakMax >= 7) unlock('daily7');
  if (stats.bestPrice >= 10) unlock('price10');
  if (coins >= 500) unlock('rich');
}
// клубные эмблемы: текущий клуб = последняя строка карьеры
function currentClubOf(p) { const r = p.c[p.c.length - 1]; return r && typeof r[2] === 'number' && r[2] ? { id: r[2], name: r[1] } : null; }
function clubRosters() {
  const m = new Map();
  PLAYERS.forEach(p => {
    const c = currentClubOf(p);
    if (!c) return;
    if (!m.has(c.id)) m.set(c.id, { name: c.name, ids: [] });
    m.get(c.id).ids.push(p.id);
  });
  return [...m.entries()].filter(([, v]) => v.ids.length >= 4)
    .sort((a, b) => b[1].ids.length - a[1].ids.length);
}
function renderAch() {
  let h = '<div class="achSec">Эмблемы клубов — угадай всех действующих игроков клуба и носи герб рядом с ником:</div><div class="clubGrid">';
  for (const [id, v] of clubRosters()) {
    const done = v.ids.filter(x => everSolved.has(x)).length;
    const full = done === v.ids.length;
    const sel = badge === id;
    h += `<div class="clubCell ${full ? 'unlocked' : ''} ${sel ? 'sel' : ''}" data-club="${full ? id : ''}" title="${esc(v.name)}">
      ${crestImg(id, 'clubCrest')}<div class="cc-name">${esc(v.name)}</div>
      <div class="cc-prog">${full ? (sel ? '✅ выбрана' : 'выбрать') : done + '/' + v.ids.length}</div></div>`;
  }
  h += '</div><div class="achSec">Достижения:</div>';
  h += ACH.map(a => `<div class="achRow ${achDone.has(a.id) ? 'done' : ''}"><span class="ai">${a.icon}</span><span class="grow"><b>${a.name}</b><small>${a.desc}</small></span><span>${achDone.has(a.id) ? '✅' : '🔒'}</span></div>`).join('');
  $('achBox').innerHTML = h;
}

// ---------- меню ----------
const overlay = $('overlay');
const screens = ['scrMain', 'scrDiff', 'scrComp', 'scrEnd', 'scrBoard', 'scrAch', 'scrPrice', 'scrDaily', 'scrDuel', 'scrDuelEnd', 'scrReport', 'scrReports'];
function show(id) {
  overlay.classList.remove('hidden');
  screens.forEach(s => $(s).style.display = s === id ? '' : 'none');
  if (id === 'scrMain') $('backMain').style.display = cur ? '' : 'none';
}
function hideMenu() { overlay.classList.add('hidden'); }

function doConfirm(msg, cb) {
  if (tg && tg.showConfirm) tg.showConfirm(msg, ok => ok && cb());
  else if (confirm(msg)) cb();
}
// единый выход в меню из любого квиза (обычный/дневной/help — состояние сохраняется)
function goMenu() {
  if (mode === 'comp' && compTimer) {
    doConfirm('Выйти из соревнования? Текущий результат будет засчитан.', () => stopComp());
    return;
  }
  if (mode === 'duel') {
    doConfirm('Выйти из дуэли? Прогресс не сохранится.', () => {
      duel = null; mode = 'normal'; syncTopBar();
      if (difficulty && !restoreGame()) { /* нет сохранёнки — покажем меню */ }
      show('scrMain');
    });
    return;
  }
  if (mode === 'help') { mode = 'normal'; syncTopBar(); if (difficulty && !restoreGame()) cur = null; show('scrMain'); return; }
  show('scrMain'); // обычный/дневной: игрок и открытое сохраняются в памяти
}
$('menuBtn').onclick = goMenu;
$('backTop').onclick = goMenu;
$('backMain').onclick = hideMenu;
$('goNormal').onclick = () => {
  const c = { easy: 0, medium: 0, hard: 0 };
  PLAYERS.forEach(p => c[p.d]++);
  $('cntEasy').textContent = c.easy; $('cntMedium').textContent = c.medium;
  $('cntHard').textContent = c.hard; $('cntAll').textContent = PLAYERS.length;
  show('scrDiff');
};
$('backDiff').onclick = () => show('scrMain');
$('goComp').onclick = () => show('scrComp');
$('backComp').onclick = () => show('scrMain');
$('compStart').onclick = startComp;
$('compAgain').onclick = startComp;
$('endMenu').onclick = () => show('scrMain');
$('goBoard').onclick = async () => {
  show('scrBoard');
  $('boardBox').innerHTML = '<div class="sub">Загружаю…</div>';
  let scores; try { scores = await boardGet(); } catch (e) { scores = store.get('localBoard', []); }
  $('boardBox').innerHTML = boardHTML(scores, me().id);
};
$('backBoard').onclick = () => show('scrMain');
$('goAch').onclick = () => { renderAch(); show('scrAch'); };
$('backAch').onclick = () => show('scrMain');
$('achBox').addEventListener('click', e => {
  const cell = e.target.closest('.clubCell');
  if (!cell || !cell.dataset.club) return;
  badge = +cell.dataset.club === badge ? 0 : +cell.dataset.club;
  store.set('badge', badge);
  renderAch();
  toast(badge ? '✅ Эмблема выбрана — появится в таблице лидеров' : 'Эмблема снята');
});

$('scrDiff').addEventListener('click', e => {
  const b = e.target.closest('.dopt'); if (!b || !b.dataset.d) return;
  const prev = difficulty;
  const wasNormalRound = mode === 'normal' && cur && !finished;
  difficulty = b.dataset.d;
  store.set('difficulty', difficulty);
  hideMenu();
  mode = 'normal'; syncTopBar();
  // античит: активный обычный раунд не перекатывается при смене сложности
  if (wasNormalRound && prev !== null) { progress(); toast('Сложность применится со следующего игрока'); }
  else next();
});

function updateMenuBtn() {
  const b = $('menuBtn');
  if (mode === 'comp') { b.textContent = '🏆'; b.className = 'diffBtn'; return; }
  if (mode === 'duel') { b.textContent = '⚔️'; b.className = 'diffBtn'; return; }
  if (mode === 'daily') { b.textContent = '🌟'; b.className = 'diffBtn'; return; }
  if (mode === 'help') { b.textContent = '🆘'; b.className = 'diffBtn'; return; }
  b.textContent = DIFF_LABEL[difficulty] || 'Меню';
  b.className = 'diffBtn ' + (difficulty && difficulty !== 'all' ? difficulty : '');
}
function syncTopBar() {
  $('statNormal').style.display = (mode === 'comp' || mode === 'duel' || mode === 'help') ? 'none' : '';
  $('statComp').style.display = mode === 'comp' ? '' : 'none';
  $('statDuel').style.display = mode === 'duel' ? '' : 'none';
  $('giveBtn').textContent = mode === 'comp' ? 'Пропустить ➜'
    : mode === 'duel' ? 'Не знаю ➜'
    : mode === 'help' ? 'Показать ответ 👀'
    : 'Сдаться (серия сгорит)';
  updateMenuBtn();
}

// ---------- шаринг ----------
function shareTg(text, url) {
  const link = 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text);
  if (tg && tg.openTelegramLink) tg.openTelegramLink(link);
  else window.open(link, '_blank');
}
$('shareComp').onclick = () => {
  const s = $('endScore').textContent;
  shareTg(`⚽ Я отгадал ${s} футболистов по карьере за 60 секунд! 🔥\nСможешь больше?`, PAGE_URL);
};

// ---------- эффекты ----------
const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function confetti() {
  if (reducedMotion) return;
  const cv = $('fx'); const ctx = cv.getContext('2d');
  cv.width = innerWidth; cv.height = innerHeight; cv.style.display = 'block';
  const colors = ['#ffc24b', '#00a86b', '#6fc2ff', '#e05656', '#ffffff'];
  const parts = Array.from({ length: 90 }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 160, y: innerHeight * .45,
    vx: (Math.random() - .5) * 11, vy: -(4 + Math.random() * 8),
    s: 4 + Math.random() * 5, c: colors[Math.floor(Math.random() * colors.length)], r: Math.random() * Math.PI
  }));
  let t0 = null;
  function frame(ts) {
    if (!t0) t0 = ts;
    const dt = ts - t0;
    ctx.clearRect(0, 0, cv.width, cv.height);
    parts.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.vy += .25; p.r += .1;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * .6); ctx.restore();
    });
    if (dt < 1300) requestAnimationFrame(frame);
    else { ctx.clearRect(0, 0, cv.width, cv.height); cv.style.display = 'none'; }
  }
  requestAnimationFrame(frame);
}
function shakeInput() {
  const el = $('guessRow');
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
}

// ---------- соревновательный ----------
function startComp() {
  mode = 'comp'; compTime = 60; compScoreVal = 0;
  compQueue = shuffle([...PLAYERS]);
  syncTopBar(); hideMenu();
  $('compScore').textContent = '0';
  const tEl = $('timer'); tEl.textContent = '60'; tEl.classList.remove('low');
  clearInterval(compTimer);
  compTimer = setInterval(() => {
    compTime--; tEl.textContent = compTime;
    if (compTime <= 10) tEl.classList.add('low');
    if (compTime <= 0) stopComp();
  }, 1000);
  compNext();
}
function compNext() {
  if (!compQueue.length) compQueue = shuffle([...PLAYERS]);
  cur = compQueue.pop(); openedIdx = []; revealedRows = 1; finished = false;
  render();
}
function stopComp() {
  clearInterval(compTimer); compTimer = null;
  const s = compScoreVal;
  if (s > stats.bestComp) { stats.bestComp = s; store.set('stats', stats); }
  checkAch();
  if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('warning');
  $('endScore').textContent = s;
  $('endNote').textContent = s === 0 ? 'В следующий раз получится!' : (s === 1 ? 'игрок отгадан' : (s < 5 ? 'игрока отгадано' : 'игроков отгадано'));
  $('endBoard').innerHTML = '<div class="sub">Отправляю результат…</div>';
  show('scrEnd');
  boardSubmit(s).then(scores => { $('endBoard').innerHTML = boardHTML(scores, me().id); });
  mode = 'normal'; cur = null; syncTopBar();
  if (difficulty) next();
}

// ---------- игрок дня ----------
function dailyState() { return store.get('daily2', { date: '', status: '', streak: 0 }); }
function dailyPlayer() {
  const idx = hashStr('daily-' + todayKey()) % PLAYERS.length;
  return PLAYERS[idx];
}
$('goDaily').onclick = () => {
  const st = dailyState();
  const done = st.date === todayKey() && st.status;
  $('dailyInfo').innerHTML =
    `Один игрок на всех, новый — каждый день.<br>Угадал — <b>+25 🪙</b> и стрик 🔥.<br>Бонусы: 3 дня подряд +25 🪙, 7 дней +100 🪙.` +
    (st.streak ? `<br><br>Твой стрик: <b>🔥 ${st.streak}</b>` : '');
  $('dailyStart').style.display = done ? 'none' : '';
  $('dailyDone').style.display = done ? '' : 'none';
  if (done) $('dailyDone').innerHTML = st.status === 'win'
    ? `✅ Сегодня угадано! Стрик: 🔥 ${st.streak}<br>Возвращайся завтра за новым игроком.`
    : `😔 Сегодня не вышло. Стрик сгорел.<br>Новый шанс — завтра!`;
  show('scrDaily');
};
$('backDaily').onclick = () => show('scrMain');
$('dailyStart').onclick = () => {
  mode = 'daily';
  cur = dailyPlayer(); openedIdx = []; revealedRows = 1; finished = false;
  syncTopBar(); hideMenu(); render();
};
function dailyFinish(win) {
  const st = dailyState();
  const yesterday = (() => { const d = new Date(Date.now() - 864e5); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
  let streak = win ? ((st.date === yesterday && st.status === 'win') ? st.streak + 1 : 1) : 0;
  store.set('daily2', { date: todayKey(), status: win ? 'win' : 'fail', streak });
  if (win) {
    let reward = 25;
    if (streak === 3) reward += 25;
    if (streak === 7) reward += 100;
    coins += reward; store.set('coins', coins);
    stats.totalWins++;
    if (streak > stats.dailyStreakMax) stats.dailyStreakMax = streak;
    store.set('stats', stats);
    toast(`🌟 Игрок дня угадан! +${reward} 🪙 · стрик ${streak}`);
  }
  checkAch();
}

// ---------- кто дороже ----------
$('goPrice').onclick = () => { startPrice(); show('scrPrice'); };
$('backPrice').onclick = () => { show('scrMain'); };
function pricePool() { return PLAYERS.filter(p => p.mv >= 1 && p.img); }
function startPrice() {
  price = { streak: 0, total: 0, coins: 0, a: null, b: null, lock: false };
  $('priceStreak').textContent = '0';
  $('priceMsg').textContent = 'Кто стоит дороже прямо сейчас? Жми на игрока!';
  nextPricePair();
}
function nextPricePair() {
  const pool = pricePool();
  let a, b, guard = 0;
  do { a = pool[Math.floor(Math.random() * pool.length)]; b = pool[Math.floor(Math.random() * pool.length)]; }
  while ((a.id === b.id || a.mv === b.mv) && ++guard < 50);
  price.a = a; price.b = b; price.lock = false;
  $('priceCards').innerHTML = [a, b].map((p, i) => `
    <div class="pcard" data-i="${i}">
      <img class="pphoto" src="${p.img}" alt="" onerror="this.style.visibility='hidden'">
      <div class="pcName">${esc(p.full)}</div>
      <div class="pcClub">${esc(p.c[p.c.length - 1][1])}</div>
      <div class="pcVal" data-v="${p.mv}">?</div>
    </div>`).join('');
}
$('priceCards').addEventListener('click', e => {
  const card = e.target.closest('.pcard');
  if (!card || price.lock) return;
  price.lock = true;
  const pick = +card.dataset.i === 0 ? price.a : price.b;
  const win = pick.mv === Math.max(price.a.mv, price.b.mv);
  document.querySelectorAll('.pcVal').forEach(el => { el.textContent = el.dataset.v + ' млн €'; el.classList.add('revealed'); });
  card.classList.add(win ? 'right' : 'wrong');
  if (win) {
    price.streak++; price.total++;
    let gain = 5;
    if (price.streak === 5) gain += 20;
    if (price.streak === 10) gain += 40;
    if (price.streak > 10 && price.streak % 5 === 0) gain += 40;
    price.coins += gain; coins += gain; store.set('coins', coins);
    $('priceStreak').textContent = price.streak;
    $('priceMsg').innerHTML = `✅ Верно! +${gain} 🪙` + (price.streak === 5 ? ' · бонус за серию 5!' : price.streak === 10 ? ' · бонус за серию 10!' : '');
    if (price.streak > stats.bestPrice) { stats.bestPrice = price.streak; store.set('stats', stats); }
    checkAch(); updateStats();
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    setTimeout(nextPricePair, 1400);
  } else {
    $('priceMsg').innerHTML = `❌ Мимо! Серия: <b>${price.streak}</b> · заработано ${price.coins} 🪙 — начинаем заново`;
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('error');
    price.streak = 0; price.coins = 0;
    $('priceStreak').textContent = '0';
    setTimeout(nextPricePair, 1800);
  }
});

// ---------- дуэль ----------
function parseDuelLink() {
  const q = new URLSearchParams(location.search);
  const p = q.get('duel');
  if (!p) return null;
  return { seed: p, oppScore: q.get('s') !== null ? +q.get('s') : null, oppName: q.get('n') || 'Соперник' };
}
$('goDuel').onclick = () => { openDuelIntro(null); };
function openDuelIntro(incoming) {
  const inc = incoming || null;
  $('duelInfo').innerHTML = inc
    ? `<b>${esc(inc.oppName)}</b> вызывает тебя на дуэль!<br>${inc.oppScore !== null ? `Счёт соперника: <b>${inc.oppScore}/10</b>.<br>` : ''}Вам достались одинаковые 10 игроков. Без подсказок. Побей результат!`
    : `10 одинаковых игроков тебе и другу.<br>Сыграй, а потом отправь вызов — у друга будут те же игроки.`;
  $('duelStart').dataset.seed = inc ? inc.seed : ('d' + Math.random().toString(36).slice(2, 8));
  $('duelStart').dataset.opp = inc ? JSON.stringify({ name: inc.oppName, score: inc.oppScore }) : '';
  show('scrDuel');
}
$('backDuel').onclick = () => show('scrMain');
$('duelStart').onclick = e => {
  const seed = e.currentTarget.dataset.seed;
  const opp = e.currentTarget.dataset.opp ? JSON.parse(e.currentTarget.dataset.opp) : null;
  duel = { seed, players: seededShuffle(PLAYERS, 'duel-' + seed).slice(0, 10), i: 0, score: 0, opp };
  mode = 'duel'; syncTopBar(); hideMenu();
  duelRound();
};
function duelRound() {
  cur = duel.players[duel.i];
  openedIdx = []; revealedRows = 1; finished = false;
  $('duelProg').textContent = (duel.i + 1) + '/10';
  $('duelScore').textContent = duel.score;
  render();
}
function duelAnswer(correct) {
  if (correct) duel.score++;
  duel.i++;
  if (duel.i >= 10) return duelEnd();
  duelRound();
}
function duelEnd() {
  const d = duel;
  mode = 'normal'; cur = null; syncTopBar();
  $('duelEndScore').textContent = d.score + '/10';
  let verdict = '';
  if (d.opp && d.opp.score !== null) {
    verdict = d.score > d.opp.score ? `🏆 Ты победил! ${esc(d.opp.name)}: ${d.opp.score}/10`
      : d.score < d.opp.score ? `😤 ${esc(d.opp.name)} сильнее: ${d.opp.score}/10. Реванш?`
      : `🤝 Ничья с ${esc(d.opp.name)}: ${d.opp.score}/10`;
  } else verdict = 'Теперь отправь вызов другу — у него будут те же игроки!';
  $('duelVerdict').innerHTML = verdict;
  $('shareDuel').onclick = () => {
    const url = PAGE_URL + '?duel=' + d.seed + '&s=' + d.score + '&n=' + encodeURIComponent(me().name);
    shareTg(`⚔️ Вызываю на дуэль в «Угадай футболиста»! Мой счёт: ${d.score}/10. Побей!`, url);
  };
  show('scrDuelEnd');
  if (difficulty) next();
  duel = null;
}
$('duelEndMenu').onclick = () => show('scrMain');

// ---------- помощь: поделиться карьерой другу ----------
function roundRectPath(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
// рисует картинку карьеры в текущем состоянии (раскрытые клубы + открытые буквы)
function drawHelpImage(p, revealed, opened) {
  return new Promise(resolve => {
    const W = 920, padX = 40, headH = 100, colH = 36, rowH = 54, nameH = 110, footH = 54;
    const rows = p.c.slice(0, Math.min(revealed, p.c.length));
    const H = headH + colH + rows.length * rowH + nameH + footH;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const C = { bg: '#0e1420', row: '#182236', text: '#e8edf5', muted: '#8494ab', gold: '#ffc24b', green: '#00a86b', blue: '#6fc2ff', red: '#e05656', border: '#223049', open: '#1d3a2c' };
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    g.fillStyle = C.gold; g.font = 'bold 36px "Segoe UI",Arial,sans-serif';
    g.fillText('⚽ Кто этот футболист?', padX, 58);
    g.fillStyle = C.muted; g.font = '21px "Segoe UI",Arial'; g.fillText('Угадай по карьере', padX, 88);
    const cSeason = padX, cClub = padX + 150, cGamesR = W - padX - 120, cGoalR = W - padX - 20;
    let y = headH;
    g.fillStyle = C.muted; g.font = 'bold 16px "Segoe UI",Arial';
    g.fillText('СЕЗОН', cSeason, y + 24); g.fillText('КОМАНДА', cClub, y + 24);
    g.textAlign = 'right'; g.fillText('М', cGamesR, y + 24); g.fillText('Г', cGoalR, y + 24); g.textAlign = 'left';
    y += colH;
    rows.forEach((r, i) => {
      const [span, club, , league, , games, goals] = r;
      if (i % 2 === 0) { g.fillStyle = C.row; g.fillRect(padX - 12, y, W - 2 * (padX - 12), rowH); }
      g.fillStyle = C.muted; g.font = '18px "Segoe UI",Arial'; g.fillText(span, cSeason, y + 33);
      g.fillStyle = C.text; g.font = 'bold 20px "Segoe UI",Arial';
      let cn = club, maxW = cGamesR - 60 - cClub;
      while (g.measureText(cn).width > maxW && cn.length > 4) cn = cn.slice(0, -2);
      if (cn !== club) cn += '…';
      g.fillText(cn, cClub, league ? y + 26 : y + 33);
      if (league) { g.fillStyle = C.muted; g.font = '15px "Segoe UI",Arial'; g.fillText(league, cClub, y + 46); }
      g.textAlign = 'right';
      g.fillStyle = C.text; g.font = 'bold 19px "Segoe UI",Arial'; g.fillText(String(games), cGamesR, y + 33);
      const conceded = typeof goals === 'number' && goals < 0;
      g.fillStyle = conceded ? C.red : C.blue; g.fillText(String(goals), cGoalR, y + 33);
      g.textAlign = 'left';
      y += rowH;
    });
    y += 30;
    const name = [...p.n];
    const bw = Math.max(26, Math.min(46, (W - 2 * padX) / name.length - 6)), bh = bw * 1.25, gap = 6;
    const totalW = name.reduce((a, ch) => a + ((ch === ' ' || ch === '-') ? bw * 0.4 : bw) + gap, 0) - gap;
    let x = (W - totalW) / 2;
    name.forEach((ch, i) => {
      if (ch === ' ' || ch === '-') { x += bw * 0.4 + gap; return; }
      const isOpen = opened.includes(i);
      g.fillStyle = isOpen ? C.open : C.row; g.strokeStyle = isOpen ? C.green : C.border; g.lineWidth = 2;
      roundRectPath(g, x, y, bw, bh, 8); g.fill(); g.stroke();
      if (isOpen) { g.fillStyle = C.text; g.font = 'bold ' + Math.floor(bh * 0.5) + 'px "Segoe UI",Arial'; g.textAlign = 'center'; g.fillText(ch.toUpperCase(), x + bw / 2, y + bh * 0.68); g.textAlign = 'left'; }
      x += bw + gap;
    });
    g.fillStyle = C.muted; g.font = '19px "Segoe UI",Arial'; g.textAlign = 'center';
    g.fillText('Помоги угадать · azalfakk.github.io/career-quiz', W / 2, H - 22); g.textAlign = 'left';
    cv.toBlob(b => resolve(b), 'image/png');
  });
}
async function shareHelp() {
  if (!cur) { toast('Сначала открой игрока'); return; }
  const url = PAGE_URL + '?help=' + cur.id + '.' + revealedRows + '.' + openedIdx.join('-');
  const text = 'Помоги угадать футболиста по карьере! 🤔⚽';
  let blob = null;
  try { blob = await drawHelpImage(cur, revealedRows, openedIdx); } catch (e) {}
  if (blob && navigator.canShare) {
    const file = new File([blob], 'career.png', { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text: text + '\n' + url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
  }
  // фолбэк: ссылка через Telegram — получатель откроет карьеру в том же состоянии
  shareTg(text, url);
  if (blob) { try { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'career.png'; a.click(); } catch (e) {} }
  toast('Отправь ссылку другу — он увидит эту карьеру');
}
$('helpBtn').onclick = shareHelp;

function parseHelpLink() {
  const h = new URLSearchParams(location.search).get('help');
  if (!h) return null;
  const [id, rev, op] = h.split('.');
  return { id: +id, rev: +rev || 1, opened: op ? op.split('-').map(Number).filter(x => !isNaN(x)) : [] };
}
function openHelp(hp) {
  const p = PLAYERS.find(x => x.id === hp.id);
  if (!p) { show('scrMain'); return; }
  mode = 'help'; cur = p;
  openedIdx = hp.opened; revealedRows = Math.max(1, Math.min(hp.rev, p.c.length)); finished = false;
  syncTopBar(); hideMenu(); render();
  $('helpBanner').style.display = '';
  $('helpBanner').innerHTML = '🆘 <b>Друг просит помощь!</b> Узнаёшь футболиста? Введи фамилию или жми «Показать ответ», чтобы подсказать.';
}

// ---------- обычная игра ----------
function pool() { return difficulty && difficulty !== 'all' ? PLAYERS.filter(p => p.d === difficulty) : PLAYERS; }
function pick() {
  const ids = pool().filter(p => !solved.includes(p.id));
  if (!ids.length) {
    const poolIds = new Set(pool().map(p => p.id));
    solved = solved.filter(id => !poolIds.has(id));
    store.set('solvedIds', solved);
    toast('🏆 Всё отгадано на этой сложности! Начинаем заново.');
    return pick();
  }
  return ids[Math.floor(Math.random() * ids.length)];
}
// сохранение текущей партии обычного режима (игрок, открытые буквы, раскрытые клубы)
function saveGame() {
  if (mode !== 'normal' || !cur) return;
  store.set('game', { id: cur.id, opened: openedIdx.slice(), revealed: revealedRows, finished });
}
function restoreGame() {
  const g = store.get('game', null);
  if (!g || g.finished || !difficulty) return false; // завершённые не восстанавливаем
  const p = PLAYERS.find(x => x.id === g.id);
  if (!p) return false;
  mode = 'normal'; cur = p;
  openedIdx = Array.isArray(g.opened) ? g.opened : [];
  revealedRows = g.revealed || 1;
  finished = false;
  syncTopBar(); render();
  return true;
}

const CREST1 = id => `https://tmssl.akamaized.net/images/wappen/head/${id}.png`;
const CREST2 = id => `https://tmssl.akamaized.net/images/wappen/normquad/${id}.png`;
const FLAG = cc => `https://flagcdn.com/w20/${cc}.png`;

function rewardNow() {
  // старт: min(25, 5 × клубов); каждое открытие клуба −5; минимум 5
  const start = Math.min(25, 5 * cur.c.length);
  return Math.max(5, start - 5 * (revealedRows - 1));
}
function careerRow(r, idx) {
  const [span, club, clubId, league, cc, games, goals] = r;
  const isUrl = typeof clubId === 'string';
  const crest = clubId
    ? `<img class="crest" src="${isUrl ? clubId : CREST1(clubId)}" alt="" loading="lazy" data-alt="${isUrl ? '' : CREST2(clubId)}" onerror="crestFallback(this)">`
    : `<span class="crest ph">⚽</span>`;
  const lg = league
    ? `<span class="lg">${cc ? `<img src="${FLAG(cc)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}${league}</span>` : '';
  const conceded = typeof goals === 'number' && goals < 0;
  return `<div class="crow" style="--i:${idx}"><span class="season">${span}</span><span class="club">${crest}<span class="cinfo"><b>${club}</b>${lg}</span></span><span class="num">${games}</span><span class="num goals${conceded ? ' conceded' : ''}">${goals}</span></div>`;
}
window.crestFallback = function (img) {
  if (img.dataset.alt) { img.src = img.dataset.alt; img.dataset.alt = ''; }
  else img.outerHTML = '<span class="crest ph">⚽</span>';
};
function renderCareer() {
  const limited = (mode === 'normal' || mode === 'help') && !finished;
  const vis = limited ? Math.min(revealedRows, cur.c.length) : cur.c.length;
  let h = cur.c.slice(0, vis).map(careerRow).join('');
  const hidden = cur.c.length - vis;
  if (hidden > 0 && mode === 'normal') {
    h += `<button class="crow lockedRow" id="revealBtn">🔒 Показать следующий клуб (ещё ${hidden}) — награда снизится до 🪙 ${Math.max(5, rewardNow() - 5)}</button>`;
  }
  $('rows').innerHTML = h;
  const rb = $('revealBtn');
  if (rb) rb.onclick = () => { revealedRows++; renderCareer(); updateRewardLabel(); saveGame(); };
}
function updateRewardLabel() {
  if (mode !== 'normal' || finished) { $('rewardLabel').textContent = ''; return; }
  $('rewardLabel').innerHTML = `Награда за игрока: <b>🪙 ${rewardNow()}</b>`;
}
function renderPhoto() {
  const box = $('photoBox');
  if (mode === 'comp' || !cur.img) { box.style.display = 'none'; return; }
  box.style.display = '';
  const img = $('photoImg');
  img.src = cur.img;
  photoOpen = false;
  img.classList.toggle('blurred', !finished);
  $('photoBtn').style.display = (finished || mode === 'duel' || mode === 'help') ? 'none' : '';
}
$('photoBtn').onclick = () => {
  if (photoOpen || finished) return;
  const cost = 20;
  const doIt = () => {
    if (coins < cost) { toast('Не хватает монет 😕'); return; }
    coins -= cost; store.set('coins', coins);
    photoOpen = true;
    $('photoImg').classList.remove('blurred');
    $('photoBtn').style.display = 'none';
    updateStats();
  };
  if (tg && tg.showConfirm) tg.showConfirm(`Открыть фото за ${cost} монет?`, ok => ok && doIt());
  else if (confirm(`Открыть фото за ${cost} монет?`)) doIt();
};

function render() {
  $('backTop').style.display = '';
  $('goalsHead').textContent = cur.gk ? '🧤' : 'Голы';
  $('gkNote').style.display = cur.gk ? '' : 'none';
  const fast = (mode === 'comp' || mode === 'duel');
  $('reportBtn').style.display = (fast || mode === 'help') ? 'none' : '';
  $('helpBtn').style.display = (mode === 'normal' || mode === 'daily') ? '' : 'none';
  if (mode !== 'help') $('helpBanner').style.display = 'none';
  renderCareer();
  renderBoxes();
  renderPhoto();
  updateRewardLabel();
  $('feedback').textContent = ''; $('feedback').className = 'feedback';
  $('reveal').style.display = 'none';
  $('guess').value = ''; $('guess').disabled = false;
  $('checkBtn').disabled = false;
  $('nextBtn').style.display = 'none'; $('nextBtn').textContent = 'Следующий игрок ➜';
  $('giveBtn').style.display = 'block';
  progress(); updateStats();
  if (fast || mode === 'help') $('guess').focus();
  if (mode === 'normal') saveGame();
}
function progress() {
  if (mode === 'help') { $('progress').textContent = '🆘 Помоги другу узнать игрока'; return; }
  if (mode === 'comp') { $('progress').textContent = 'Соревновательный режим'; return; }
  if (mode === 'duel') { $('progress').textContent = '⚔️ Дуэль'; return; }
  if (mode === 'daily') { $('progress').textContent = '🌟 Игрок дня'; return; }
  const total = pool().length;
  const done = pool().filter(p => solved.includes(p.id)).length;
  $('progress').textContent = `Отгадано: ${done} из ${total} · ${DIFF_LABEL[difficulty] || ''}`;
}
function letterCost() { return 5 * Math.pow(2, openedIdx.length); }
function renderBoxes() {
  const name = cur.n;
  const el = $('boxes');
  el.innerHTML = '';
  [...name].forEach((ch, i) => {
    const d = document.createElement('div');
    if (ch === ' ' || ch === '-') d.className = 'lbox space';
    else if (openedIdx.includes(i) || finished) { d.className = 'lbox open'; d.textContent = ch.toUpperCase(); }
    else if (mode === 'comp' || mode === 'duel' || mode === 'help') d.className = 'lbox locked';
    else { d.className = 'lbox'; d.onclick = () => buyLetter(i); }
    el.appendChild(d);
  });
  $('hintCost').innerHTML = (finished || mode === 'comp' || mode === 'duel' || mode === 'help') ? '' :
    `Открыть букву — <b>🪙 ${letterCost()}</b>`;
}
function buyLetter(i) {
  const cost = letterCost();
  if (coins < cost) { toast('Не хватает монет 😕 Заходи завтра за бонусом!'); return; }
  const doIt = () => {
    coins -= cost; openedIdx.push(i);
    store.set('coins', coins);
    renderBoxes(); updateStats(); saveGame();
  };
  if (tg && tg.showConfirm) tg.showConfirm(`Открыть букву за ${cost} монет?`, ok => ok && doIt());
  else if (confirm(`Открыть букву за ${cost} монет?`)) doIt();
}
function reveal() {
  const r = $('reveal');
  $('rname').textContent = cur.full;
  $('rdesc').textContent = cur.en;
  const img = $('rimg');
  if (cur.img) { img.src = cur.img; img.style.display = ''; } else img.style.display = 'none';
  r.style.display = 'flex';
}
function finishRound() {
  finished = true;
  renderCareer(); // раскрыть всю карьеру
  renderBoxes();
  renderPhoto();
  updateRewardLabel();
  $('guess').disabled = true; $('checkBtn').disabled = true;
  $('giveBtn').style.display = 'none';
  $('nextBtn').style.display = 'block';
  $('helpBtn').style.display = 'none';
  progress();
  if (mode === 'normal') saveGame();
}
function check() {
  if (finished || !cur) return;
  const guess = $('guess').value.trim();
  if (!guess) return;
  const res = checkGuess(guess, cur);
  const fb = $('feedback');
  if (res === 2) {
    if (mode === 'comp') {
      compScoreVal++;
      $('compScore').textContent = compScoreVal;
      fb.className = 'feedback ok'; fb.textContent = `✅ ${cur.full}!`;
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
      setTimeout(() => { if (mode === 'comp' && compTimer) compNext(); }, 350);
      return;
    }
    if (mode === 'duel') {
      fb.className = 'feedback ok'; fb.textContent = `✅ ${cur.full}!`;
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
      setTimeout(() => duelAnswer(true), 500);
      return;
    }
    if (mode === 'help') {
      confetti();
      fb.className = 'feedback ok'; fb.textContent = `✅ Это ${cur.full}! Подскажи другу 🙌`;
      reveal(); finishRound();
      $('nextBtn').textContent = '🎮 Играть самому';
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
      return;
    }
    // normal / daily
    confetti();
    if (mode === 'daily') {
      fb.className = 'feedback ok'; fb.textContent = `✅ Это ${cur.full}!`;
      dailyFinish(true);
      reveal(); finishRound();
      $('nextBtn').style.display = 'none';
    } else {
      winStreak++;
      const reward = rewardNow();
      coins += reward;
      solved.push(cur.id); everSolved.add(cur.id);
      stats.totalWins++;
      store.set('coins', coins); store.set('solvedIds', solved);
      store.set('everSolved', [...everSolved]); store.set('winStreak', winStreak); store.set('stats', stats);
      fb.className = 'feedback ok';
      fb.textContent = `✅ Верно! +${reward} 🪙`;
      reveal(); finishRound();
      checkAch();
    }
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
  } else if (res === 1) {
    fb.className = 'feedback close'; fb.textContent = '🔶 Очень близко! Проверь написание';
  } else {
    fb.className = 'feedback bad'; fb.textContent = '❌ Мимо, попробуй ещё';
    shakeInput();
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('error');
  }
  updateStats();
}
function giveUp() {
  if (finished || !cur) return;
  if (mode === 'help') { // в режиме помощи «Сдаться» = показать ответ, чтобы подсказать другу
    const fb = $('feedback');
    fb.className = 'feedback ok'; fb.textContent = `Это ${cur.full} — скажи другу!`;
    reveal(); finishRound();
    $('nextBtn').textContent = '🎮 Играть самому';
    return;
  }
  if (mode === 'comp') { if (compTimer) compNext(); return; }
  if (mode === 'duel') { duelAnswer(false); return; }
  if (mode === 'daily') {
    const fb = $('feedback');
    fb.className = 'feedback bad'; fb.textContent = 'Стрик сгорел…';
    dailyFinish(false);
    reveal(); finishRound();
    $('nextBtn').style.display = 'none';
    return;
  }
  winStreak = 0; store.set('winStreak', 0);
  const fb = $('feedback');
  fb.className = 'feedback bad'; fb.textContent = 'Не угадал…';
  solved.push(cur.id); store.set('solvedIds', solved);
  reveal(); finishRound(); updateStats();
}
function next() { mode = 'normal'; syncTopBar(); cur = pick(); openedIdx = []; revealedRows = 1; finished = false; render(); }
function updateStats() {
  $('coins').textContent = coins;
  $('streak').textContent = winStreak;
}
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

$('checkBtn').onclick = check;
$('guess').addEventListener('keydown', e => { if (e.key === 'Enter') check(); });
$('nextBtn').onclick = next;
$('giveBtn').onclick = () => {
  if (mode === 'comp' || mode === 'duel' || mode === 'help') { giveUp(); return; }
  const msg = mode === 'daily' ? 'Сдаться? Стрик игрока дня сгорит.' : 'Сдаться? Серия побед сгорит.';
  if (tg && tg.showConfirm) tg.showConfirm(msg, ok => ok && giveUp());
  else if (confirm(msg)) giveUp();
};

// ---------- отчёты об ошибках ----------
const REPORTS_URL = 'https://jsonblob.com/api/jsonBlob/019f903c-be40-763b-bbe5-afb287fb1099';
$('reportBtn').onclick = () => {
  if (!cur) { toast('Сначала открой игрока'); return; }
  $('reportPlayer').innerHTML = `Игрок: <b>${esc(cur.full)}</b> <span style="color:var(--muted)">(${esc(cur.en)})</span>`;
  $('reportText').value = '';
  show('scrReport');
};
$('reportCancel').onclick = () => hideMenu();
$('reportSend').onclick = async () => {
  const txt = $('reportText').value.trim();
  if (!txt) { toast('Напиши, что не так 🙂'); return; }
  const who = me();
  const rep = { id: cur ? cur.id : null, player: cur ? cur.full : '', en: cur ? cur.en : '',
    text: txt.slice(0, 500), user: who.name, ts: Date.now() };
  const btn = $('reportSend'); btn.disabled = true;
  try {
    let arr = [];
    try { const r = await fetch(REPORTS_URL, { cache: 'no-store' }); const j = await r.json(); arr = Array.isArray(j.reports) ? j.reports : []; } catch (e) {}
    arr.unshift(rep); arr = arr.slice(0, 500);
    await fetch(REPORTS_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reports: arr }) });
    toast('Спасибо! Отчёт отправлен 🙌');
  } catch (e) {
    const loc = store.get('localReports', []); loc.unshift(rep); store.set('localReports', loc);
    toast('Нет сети — сохранил локально');
  }
  btn.disabled = false;
  hideMenu();
};
// админ-просмотр отчётов: открывается ссылкой ...?reports
async function showReports() {
  show('scrReports');
  $('reportsBox').innerHTML = '<div class="sub">Загружаю…</div>';
  let arr = [];
  try { const r = await fetch(REPORTS_URL, { cache: 'no-store' }); const j = await r.json(); arr = Array.isArray(j.reports) ? j.reports : []; } catch (e) {}
  if (!arr.length) { $('reportsBox').innerHTML = '<div class="sub">Отчётов пока нет.</div>'; return; }
  $('reportsBox').innerHTML = `<div class="sub">Всего: ${arr.length}</div>` + arr.map(r => {
    const d = new Date(r.ts);
    const when = d.toLocaleDateString('ru') + ' ' + d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    return `<div class="reportRow"><div><div><b>${esc(r.player || '—')}</b> <span class="rp-when">· ${esc(r.user || '')} · ${when}</span></div><div class="rp-txt">${esc(r.text || '')}</div></div></div>`;
  }).join('');
}
$('reportsClose').onclick = () => { if (difficulty && cur) hideMenu(); else show('scrMain'); };

// ---------- запуск ----------
window.__check = checkGuess;
syncTopBar();
const helpLink = parseHelpLink();
const incomingDuel = parseDuelLink();
if (helpLink) {
  openHelp(helpLink);
} else if (incomingDuel) {
  if (difficulty) next();
  openDuelIntro(incomingDuel);
} else if (difficulty && restoreGame()) {
  hideMenu(); // продолжаем сохранённую партию сразу, без меню
} else {
  if (difficulty) next();
  show('scrMain');
}
if (new URLSearchParams(location.search).has('reports')) showReports();
checkAch();
