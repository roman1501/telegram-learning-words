/* ========= CONFIG ========= */
const CONFIG = {
  SUPABASE_URL: 'https://ewkiscysdkjqavbjxlfb.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3a2lzY3lzZGtqcWF2Ymp4bGZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY1NjQ1NTMsImV4cCI6MjA3MjE0MDU1M30.UwPBfewrCAgFsVqnw7BeRddLJUOVW1IHJ3qWyWPyMHo',
};

/* ========= LIBS ========= */
const supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const tg = window.Telegram?.WebApp; tg && tg.expand();

/* ========= USER ========= */
function getUser() {
  const tUser = tg?.initDataUnsafe?.user;
  if (tUser?.id) return { id: tUser.id, name: tUser.first_name || 'Learner', username: tUser.username || '' };
  let id = localStorage.getItem('demo_user_id');
  if (!id) { id = String(900000000 + Math.floor(Math.random()*100000)); localStorage.setItem('demo_user_id', id); }
  return { id: Number(id), name: 'Demo', username: 'demo' };
}
const user = getUser();
document.getElementById('userPill').textContent = `${user.name} ${user.username? '('+user.username+')':''} #${user.id}`;

/* ========= UTILS ========= */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function toast(msg){ const el = $('#toast'); el.textContent = msg; el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'), 2600); }
function asText(err){ try{ if(err==null) return 'Unknown'; if(typeof err==='string') return err; if(err instanceof Error) return err.message||String(err); if(typeof err==='object') return JSON.stringify(err); return String(err);}catch{ return 'Unstringifiable'; }}

/* HTML escape + safe highlight */
function escapeHTML(s=''){ return s
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function markMatch(str='', q=''){
  if (!q) return escapeHTML(str);
  const safe = escapeHTML(str);
  const re = new RegExp('('+q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','ig');
  return safe.replace(re, '<mark>$1</mark>');
}
const debounce = (fn,ms)=>{ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; };

/* ========= FX: Confetti ========= */
const fx = $('#fx'); const ctx = fx.getContext('2d');
function resizeFx(){ fx.width = innerWidth; fx.height = innerHeight; }
addEventListener('resize', resizeFx); resizeFx();
let confetti = [];
let animId = null;
function shootConfetti(){
  const N = 90;
  for(let i=0;i<N;i++){
    confetti.push({
      x: fx.width/2, y: fx.height/2,
      vx: (Math.random()*2-1)*6, vy: (Math.random()*-2-4),
      g: 0.15 + Math.random()*0.2,
      r: 2 + Math.random()*4,
      a: 1, hue: 40 + Math.random()*80
    });
  }
  if (!animId) animId = requestAnimationFrame(tick);
}
function tick(){
  ctx.clearRect(0,0,fx.width,fx.height);
  confetti.forEach(p=>{
    p.x+=p.vx; p.y+=p.vy; p.vy+=p.g; p.a-=0.008;
    ctx.fillStyle = `hsla(${p.hue} 90% 60% / ${Math.max(p.a,0)})`;
    ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fill();
  });
  confetti = confetti.filter(p=>p.a>0 && p.y<fx.height+10);
  if (confetti.length){
    animId = requestAnimationFrame(tick);
  } else {
    animId = null;
  }
}

/* ========= DB HELPERS ========= */
async function ensureUser(){
  const { error } = await supabase.from('users').upsert({ id: user.id, username: user.username }).select();
  if (error) toast('users.upsert: '+asText(error));
}
async function ensureDefaultDeck(){
  let { data: deck, error } = await supabase.from('decks').select('*').eq('user_id', user.id).limit(1).maybeSingle();
  if (error) toast('decks.select: '+asText(error));
  if (!deck){
    const ins = await supabase.from('decks').insert({ user_id: user.id, name:'My Deck' }).select().single();
    if (ins.error){ toast('decks.insert: '+asText(ins.error)); return null; }
    deck = ins.data;
  }
  return deck;
}
async function addWord(term, translation, example){
  const deck = await ensureDefaultDeck(); if(!deck) return;
  const ins = await supabase.from('words').insert({ user_id:user.id, deck_id:deck.id, term, translation, example }).select().single();
  if (ins.error){ toast('words.insert: '+asText(ins.error)); return; }
  await supabase.from('user_words').upsert({ user_id:user.id, word_id: ins.data.id });
  toast('Додано ✔');
}
async function fetchDueWords(){
  const { data, error } = await supabase.from('due_words_view').select('*').eq('user_id', user.id);
  if (error){ toast('due_words_view: '+asText(error)); return []; }
  return (data||[]).map(r=>({ id:r.word_id, deck:r.deck_name||'My Deck', term:r.term, translation:r.translation, example:r.example||'' }));
}
async function srsUpdate(wordId, quality){
  const { error } = await supabase.rpc('srs_update', { p_user_id:user.id, p_word_id:wordId, p_quality:quality });
  if (error) toast('srs_update: '+asText(error));
}

/* ========= STATE ========= */
let queue = [];        // [{id, deck, term, translation, example}]
let pointer = 0;       // індекс поточної картки
let mode = 'flash';    // 'flash' | 'typing' | 'mcq'
let sessionTotal = 0;  // фіксується на старті сесії
let revealed = false;  // чи показана відповідь у flash

const el = {
  deckName: $('#deckName'),
  term: $('#term'),
  translation: $('#translation'),
  example: $('#example'),
  due: $('#duePill'),
  bar: $('#barFill'),
  progNow: $('#progNow'),
  progTotal: $('#progTotal'),
  typingInput: $('#typingInput'),
  typingFeedback: $('#typingFeedback'),
  mcq: $('#mcqOptions'),
  btnEasy: $('#btnEasy'),
};

/* ========= DAILY GOAL ========= */
const DAILY_GOAL = 10;
function todayKey(){
  const d = new Date();
  return d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');
}
let daily = { key: todayKey(), count: 0 };
function loadGoal(){
  const raw = localStorage.getItem('daily');
  const nowKey = todayKey();
  if (raw){
    try {
      const obj = JSON.parse(raw);
      daily = (obj.key===nowKey) ? obj : { key: nowKey, count: 0 };
    } catch { daily = { key: nowKey, count: 0 }; }
  } else {
    daily = { key: nowKey, count: 0 };
  }
  updateGoalPill();
}
function saveGoal(){ localStorage.setItem('daily', JSON.stringify(daily)); }
function addDailyProgress(q){ if (q>=4){ daily.count++; saveGoal(); updateGoalPill(); } }
function updateGoalPill(){ $('#goalPill').textContent = `Ціль/день: ${daily.count}/${DAILY_GOAL}`; }

/* ========= PROGRESS ========= */
function setDue(){ el.due.textContent = 'Черга: ' + Math.max(0, sessionTotal - pointer); }
function setProgress(){
  el.progTotal.textContent = sessionTotal;
  const done = Math.min(pointer, sessionTotal);
  el.progNow.textContent = done;
  const pct = sessionTotal ? Math.round(100*done/sessionTotal) : 0;
  el.bar.style.width = pct + '%';
}

/* ========= RENDER ========= */
function showCardAnim(){
  [el.term, el.translation, el.example].forEach(n=>{ n.classList.remove('reveal'); void n.offsetWidth; n.classList.add('reveal'); });
}

function highlightExample(example, term){
  if(!example) return '';
  const esc = escapeHTML(example);
  // коректне екранування всіх спецсимволів регекспу
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // межі слова з урахуванням будь-яких літер (Unicode), з фолбеком
  try {
    const re = new RegExp(`(?<!\\p{L})(${escaped})(?!\\p{L})`, 'giu');
    return esc.replace(re, '<mark>$1</mark>');
  } catch {
    // якщо движок не підтримує lookbehind — простіше підсвітити без меж
    const re = new RegExp(`(${escaped})`, 'gi');
    return esc.replace(re, '<mark>$1</mark>');
  }
}
function loadCard(){
  setDue(); setProgress();
  const atEndOfSession = pointer >= sessionTotal;
  const c = atEndOfSession ? null : queue[pointer];

  if (!c){
    el.deckName.textContent = '—';
    const extra = Math.max(0, queue.length - sessionTotal);
    el.term.textContent = extra ? `🎉 Сесію завершено! (+${extra} в черзі наступної)` : '🎉 Все на сьогодні!';
    el.translation.textContent = ''; el.example.textContent='';
    shootConfetti();
    return;
  }

  el.deckName.textContent = c.deck || 'My Deck';
  el.term.textContent = c.term;
  el.translation.textContent = c.translation || '';
  el.example.innerHTML = c.example ? highlightExample(c.example, c.term) : '';
  el.translation.style.opacity = 0; el.example.style.opacity = 0;
  revealed = false;
  el.btnEasy.disabled = false;
  showCardAnim();

  if (mode === 'typing'){
    el.typingInput.value = '';
    el.typingFeedback.textContent = '';
    setTimeout(()=> el.typingInput?.focus?.(), 0);
  } else if (mode === 'mcq'){
    buildMCQOptions(c);
  }
}

function reveal(){
  revealed = true;
  el.btnEasy.disabled = true;          // не дозволяємо Easy після підглядання
  el.translation.style.opacity = 1;
  el.example.style.opacity = 1;
  tg?.HapticFeedback?.impactOccurred('soft');
}

/* ========= SPEAK ========= */
let voiceLang = localStorage.getItem('voiceLang') || 'en-US';
function speak(){
  const c = queue[pointer]; if(!c || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(c.term);
  u.lang = voiceLang; u.rate = 0.95; u.pitch = 1.0;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

/* ========= SRS/GRADING ========= */
function normalize(s){ return (s||'').toLowerCase().trim().replace(/^[\-\–—(,.\s]+|[\-\–—),.\s]+$/g,''); }
function expectedList(s){ return (s||'').split(/[;|,\/]/).map(x=>normalize(x)).filter(Boolean); }

function lev(a,b){
  const m=a.length,n=b.length; const dp=Array.from({length:m+1},(_,i)=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0]=i;
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++) for(let j=1;j<=n;j++)
    dp[i][j]=Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return dp[m][n];
}

async function grade(q){
  const c = queue[pointer]; if(!c) return;

  // після reveal Easy заборонено
  if (revealed && q === 5){ toast('Після «Показати» — не можна «Легко»'); return; }

  await srsUpdate(c.id, q);
  addDailyProgress(q);

  // локальний re-queue, якщо відповів погано: повтор через кілька карток
  if (q <= 2 && pointer < queue.length){
    const again = { ...c };
    queue.splice(pointer, 1);
    const insertAt = Math.min(pointer + 4, queue.length);
    queue.splice(insertAt, 0, again);
    // pointer не змінюємо: підемо до наступної картки на цій позиції
  } else {
    pointer++;
  }
  revealed = false;
  loadCard();
}

/* ========= MODES ========= */
function switchMode(next){
  mode = next;
  $$('.tab').forEach(b=>b.classList.toggle('active', b.dataset.mode===mode));
  $$('.mode-area').forEach(a=>a.classList.add('hidden'));
  $('#mode-'+mode).classList.remove('hidden');
  loadCard();
}

/* Typing check з «майже правильно» */
function checkTyping(){
  const c = queue[pointer]; if(!c) return;
  const userAns = normalize(el.typingInput.value);
  const variants = expectedList(c.translation || c.term);
  if (!userAns){ el.typingFeedback.textContent = 'Введи відповідь'; return; }

  if (variants.some(v => v === userAns)){
    el.typingFeedback.textContent = '✅ Правильно!';
    grade(5);
  } else if (variants.some(v => lev(userAns, v) <= 2)){
    el.typingFeedback.textContent = `🟡 Майже: ${c.translation}`;
    grade(4);
  } else {
    el.typingFeedback.textContent = `❌ Правильна: ${c.translation}`;
    reveal();
    setTimeout(()=>grade(1), 700);
  }
}

/* MCQ: чисті дистрактори */
function pickDistractors(correct, pool, n=3){
  const c = normalize(correct);
  const uniq = Array.from(new Set(pool
    .map(x => normalize(x||''))
    .filter(x => x && x !== c)
  ));
  while (uniq.length < n) uniq.push('—');
  return uniq.sort(()=>Math.random()-0.5).slice(0, n);
}
function buildMCQOptions(card){
  const pool = queue.map(x => x.translation || x.term).filter(Boolean);
  const distract = pickDistractors(card.translation || card.term, pool, 3);
  const options = [...distract, card.translation || card.term]
    .map(o => o || '—')
    .filter((v,i,a)=>a.indexOf(v)===i)
    .sort(()=>Math.random()-0.5);

  el.mcq.innerHTML = '';
  options.forEach(opt=>{
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = opt;
    b.onclick = ()=>{
      const correct = normalize(opt) === normalize(card.translation || card.term);
      if (correct){ toast('✅'); grade(4); }     // MCQ = 4
      else { toast('❌'); reveal(); setTimeout(()=>grade(1), 700); }
    };
    el.mcq.appendChild(b);
  });
}

/* ========= LIST / DICTIONARY ========= */
async function renderList(){
  const q = ($('#search').value||'').toLowerCase().trim();
  const list = $('#list'); list.innerHTML = '';
  const { data, error } = await supabase.from('words')
    .select('id, term, translation, example, created_at')
    .eq('user_id', user.id).order('created_at', { ascending:false }).limit(100);
  if (error){ toast('words.list: '+asText(error)); return; }

  (data||[])
    .filter(x => x.term.toLowerCase().includes(q) || (x.translation||'').toLowerCase().includes(q))
    .forEach(x=>{
      const div = document.createElement('div');
      div.className = 'item';
      const termHTML = markMatch(x.term, q);
      const trHTML = markMatch(x.translation||'', q);
      const exHTML = x.example ? `<div class="muted" style="margin-top:4px">${escapeHTML(x.example)}</div>` : '';
      div.innerHTML = `
        <div>
          <div class="title">${termHTML}</div>
          <div class="muted">${trHTML}</div>
          ${exHTML}
        </div>
        <button class="btn" data-id="${x.id}">Тренувати</button>
      `;
      div.querySelector('button').onclick = ()=>{
        // додаємо в КІНЕЦЬ поточної черги, не ламаючи «фініш сесії»
        queue.push({ id:x.id, deck:'My Deck', term:x.term, translation:x.translation, example:x.example||'' });
        toast('Додано в кінець черги');
        // sessionTotal НЕ чіпаємо; прогрес залишається чесним
        setDue(); setProgress();
      };
      list.appendChild(div);
    });
}

/* ========= FLOW ========= */
async function refreshQueue(){
  await ensureUser();
  pointer = 0;
  queue = await fetchDueWords();

  if (!queue.length){
    const { data, error } = await supabase.from('words')
      .select('*').eq('user_id', user.id)
      .order('created_at',{ascending:false}).limit(10);
    if (error) toast('words.select: '+asText(error));
    queue = (data||[]).map(w=>({id:w.id, deck:'My Deck', term:w.term, translation:w.translation, example:w.example||''}));
  }

  sessionTotal = queue.length;  // фіксуємо розмір сесії
  setProgress();
  loadCard();
  renderList();
}

/* ========= EVENTS ========= */
$('#btnStart').onclick = refreshQueue;
$('#btnReveal').onclick = reveal;
$('#btnSpeak').onclick = speak;
$('#btnHard').onclick = ()=>grade(1);
$('#btnDoubt').onclick = ()=>grade(3);
$('#btnEasy').onclick = ()=>grade(5);
$('#btnSync').onclick = refreshQueue;

$('#btnAdd').onclick = async ()=>{
  const term = $('#termInput').value.trim();
  const tr = $('#transInput').value.trim();
  const ex = $('#exInput').value.trim();
  if (!term || !tr){ toast('Вкажи слово та переклад'); return; }
  await addWord(term, tr, ex);
  $('#termInput').value = ''; $('#transInput').value=''; $('#exInput').value='';
  await renderList();
};

/* парсер формату "term — переклад ; приклад" при вставці у поле терміна */
function parseOneLine(s){
  const m = s.match(/^\s*(.+?)\s*[–—-]\s*(.+?)(?:\s*;\s*(.+))?\s*$/);
  return m ? { term:m[1], translation:m[2], example:m[3]||'' } : null;
}
$('#termInput').addEventListener('paste', (e)=>{
  const text = (e.clipboardData || window.clipboardData).getData('text');
  const r = parseOneLine(text);
  if (r){
    e.preventDefault();
    $('#termInput').value = r.term;
    $('#transInput').value = r.translation;
    $('#exInput').value = r.example;
  }
});

$('#search').addEventListener('input', debounce(renderList, 200));

$$('.tab').forEach(b=> b.onclick = ()=> switchMode(b.dataset.mode));
$('#btnCheckTyping').onclick = checkTyping;
$('#btnSkipTyping').onclick = ()=>{ reveal(); setTimeout(()=>grade(3), 500); };
$('#btnRefreshMCQ').onclick = ()=>{ const c = queue[pointer]; if(c) buildMCQOptions(c); };

/* ========= THEME ========= */
const themeToggle = $('#themeToggle');
(function initTheme(){
  const saved = localStorage.getItem('theme') || 'dark';
  if (saved==='light'){ document.documentElement.classList.add('light'); themeToggle.checked = true; }
})();
themeToggle.onchange = ()=>{
  const light = themeToggle.checked;
  document.documentElement.classList.toggle('light', light);
  localStorage.setItem('theme', light?'light':'dark');
};

/* ========= HOTKEYS ========= */
addEventListener('keydown', (e)=>{
  if (mode==='typing' && e.key==='Enter'){ checkTyping(); }
  if (mode!=='typing' && e.code==='Space'){ e.preventDefault(); reveal(); }
  if (e.key==='1') grade(1);
  if (e.key==='2') grade(3);
  if (e.key==='3') grade(5); // захист від Easy після reveal у grade()
});

/* ========= INIT ========= */
loadGoal();
refreshQueue().catch(e => toast('init: '+asText(e)));
