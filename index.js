/* ========= CONFIG ========= */
const CONFIG = {
  SUPABASE_URL: 'https://ewkiscysdkjqavbjxlfb.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3a2lzY3lzZGtqcWF2Ymp4bGZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY1NjQ1NTMsImV4cCI6MjA3MjE0MDU1M30.UwPBfewrCAgFsVqnw7BeRddLJUOVW1IHJ3qWyWPyMHo',
};

/* ========= LIBS ========= */
const supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const tg = window.Telegram?.WebApp; tg && tg.expand();

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

/* ========= FX: Confetti ========= */
const fx = $('#fx'); const ctx = fx.getContext('2d');
function resizeFx(){ fx.width = innerWidth; fx.height = innerHeight; }
addEventListener('resize', resizeFx); resizeFx();
let confetti = [];
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
}
function tick(){
  ctx.clearRect(0,0,fx.width,fx.height);
  confetti.forEach(p=>{
    p.x+=p.vx; p.y+=p.vy; p.vy+=p.g; p.a-=0.008;
    ctx.fillStyle = `hsla(${p.hue} 90% 60% / ${Math.max(p.a,0)})`;
    ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fill();
  });
  confetti = confetti.filter(p=>p.a>0 && p.y<fx.height+10);
  requestAnimationFrame(tick);
}
tick();

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
let queue = [];     // [{id, deck, term, translation, example}]
let pointer = 0;    // індекс поточної картки
let mode = 'flash'; // 'flash' | 'typing' | 'mcq'
let total = 0;

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
};

function setDue(){ el.due.textContent = 'Черга: ' + Math.max(0, queue.length - pointer); }
function setProgress(){
  el.progTotal.textContent = total;
  const done = Math.min(pointer, total);
  el.progNow.textContent = done;
  const pct = total ? Math.round(100*done/total) : 0;
  el.bar.style.width = pct + '%';
}

function showCardAnim(){
  [el.term, el.translation, el.example].forEach(n=>{ n.classList.remove('reveal'); void n.offsetWidth; n.classList.add('reveal'); });
}

function loadCard(){
  setDue(); setProgress();
  const c = queue[pointer];
  if (!c){
    el.deckName.textContent = '—';
    el.term.textContent = '🎉 Все на сьогодні!';
    el.translation.textContent = ''; el.example.textContent='';
    shootConfetti();
    return;
  }
  el.deckName.textContent = c.deck;
  el.term.textContent = c.term;
  el.translation.textContent = c.translation || '';
  el.example.textContent = c.example || '';
  el.translation.style.opacity = 0; el.example.style.opacity = 0;
  showCardAnim();

  // Підготовка режимів
  if (mode === 'typing'){
    el.typingInput.value = '';
    el.typingFeedback.textContent = '';
  } else if (mode === 'mcq'){
    buildMCQOptions(c);
  }
}

function reveal(){ el.translation.style.opacity = 1; el.example.style.opacity = 1; tg?.HapticFeedback?.impactOccurred('soft'); }
function speak(){ const c = queue[pointer]; if(!c) return; if('speechSynthesis' in window){ const u = new SpeechSynthesisUtterance(c.term); u.lang='en-US'; speechSynthesis.speak(u);} }

async function grade(q){ const c = queue[pointer]; if(!c) return; await srsUpdate(c.id, q); pointer++; loadCard(); }

/* ========= MODES ========= */
function switchMode(next){
  mode = next;
  $$('.tab').forEach(b=>b.classList.toggle('active', b.dataset.mode===mode));
  $$('.mode-area').forEach(a=>a.classList.add('hidden'));
  $('#mode-'+mode).classList.remove('hidden');
  loadCard();
}

function normalize(s){ return (s||'').toLowerCase().trim(); }

function checkTyping(){
  const c = queue[pointer]; if(!c) return;
  const userAns = normalize(el.typingInput.value);
  const expected = normalize(c.translation);
  if (!userAns){ el.typingFeedback.textContent = 'Введи відповідь'; return; }
  if (userAns === expected){
    el.typingFeedback.textContent = '✅ Правильно!';
    grade(5);
  } else {
    el.typingFeedback.textContent = `❌ Правильна: ${c.translation}`;
    grade(1);
  }
}

function pickDistractors(correct, pool, n=3){
  const uniq = Array.from(new Set(pool.filter(x=>normalize(x)!==normalize(correct))));
  const shuffled = uniq.sort(()=>Math.random()-0.5);
  return shuffled.slice(0, n);
}
function buildMCQOptions(card){
  // джерело варіантів: переклади з queue (або fallback — саме слово)
  const pool = queue.map(x=>x.translation || x.term);
  const distract = pickDistractors(card.translation || card.term, pool, 3);
  const options = [...distract, card.translation || card.term].sort(()=>Math.random()-0.5);
  el.mcq.innerHTML = '';
  options.forEach(opt=>{
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = opt;
    b.onclick = ()=>{
      if (normalize(opt) === normalize(card.translation || card.term)){ toast('✅'); grade(5); }
      else { toast('❌'); reveal(); setTimeout(()=>grade(1), 500); }
    };
    el.mcq.appendChild(b);
  });
}

/* ========= LIST / DICTIONARY ========= */
async function renderList(){
  const q = ($('#search').value||'').toLowerCase();
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
      div.innerHTML = `
        <div>
          <div class="title">${x.term}</div>
          <div class="muted">${x.translation||''}</div>
          ${x.example? `<div class="muted" style="margin-top:4px">${x.example}</div>` : '' }
        </div>
        <button class="btn" data-id="${x.id}">Тренувати</button>
      `;
      div.querySelector('button').onclick = ()=>{
        queue.unshift({ id:x.id, deck:'My Deck', term:x.term, translation:x.translation, example:x.example||'' });
        total = Math.max(total, queue.length);
        pointer = 0; loadCard(); toast('Додано в початок черги'); scrollTo({top:0,behavior:'smooth'});
      };
      list.appendChild(div);
    });
}

/* ========= FLOW ========= */
async function refreshQueue(){
  await ensureUser();
  pointer = 0;
  queue = await fetchDueWords();
  total = queue.length;

  if (!queue.length){
    const { data, error } = await supabase.from('words').select('*').eq('user_id', user.id).order('created_at',{ascending:false}).limit(10);
    if (error) toast('words.select: '+asText(error));
    queue = (data||[]).map(w=>({id:w.id, deck:'My Deck', term:w.term, translation:w.translation, example:w.example||''}));
    total = queue.length;
  }

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
$('#search').oninput = renderList;

$$('.tab').forEach(b=> b.onclick = ()=> switchMode(b.dataset.mode));
$('#btnCheckTyping').onclick = checkTyping;
$('#btnSkipTyping').onclick = ()=>{ reveal(); setTimeout(()=>grade(3), 400); };
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

/* ========= INIT ========= */
refreshQueue().catch(e => toast('init: '+asText(e)));
