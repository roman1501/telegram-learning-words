// ====== CONFIG (твій реальний проєкт Supabase) ======
const CONFIG = {
  SUPABASE_URL: 'https://ewkiscysdkjqavbjxlfb.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3a2lzY3lzZGtqcWF2Ymp4bGZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY1NjQ1NTMsImV4cCI6MjA3MjE0MDU1M30.UwPBfewrCAgFsVqnw7BeRddLJUOVW1IHJ3qWyWPyMHo',
};

// ====== SUPABASE ======
const supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ====== TELEGRAM / USER ======
const tg = window.Telegram?.WebApp;
tg && tg.expand();

function getUser() {
  // у Telegram WebApp беремо реального user.id
  const tUser = tg?.initDataUnsafe?.user;
  if (tUser?.id) {
    return { id: tUser.id, name: tUser.first_name || 'Learner', username: tUser.username || '' };
  }
  // щоб працювало і в браузері без Telegram — демо-користувач
  let id = localStorage.getItem('demo_user_id');
  if (!id) {
    id = String(900000000 + Math.floor(Math.random() * 100000)); // псевдо-id
    localStorage.setItem('demo_user_id', id);
  }
  return { id: Number(id), name: 'Demo', username: 'demo' };
}

const user = getUser();
document.getElementById('userPill').textContent = `${user.name} ${user.username ? '('+user.username+')': ''} #${user.id}`;

// ====== UI HELPERS ======
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2800);
}
function asText(err){
  try{
    if(err == null) return 'Unknown error';
    if(typeof err === 'string') return err;
    if(err instanceof Error) return err.message || String(err);
    if(typeof err === 'object') return JSON.stringify(err, null, 2);
    return String(err);
  }catch{ return 'Unstringifiable error'; }
}

// ====== DB HELPERS ======
async function ensureUser() {
  const { error } = await supabase.from('users').upsert({ id: user.id, username: user.username }).select();
  if (error) toast('users.upsert: ' + asText(error));
}

async function ensureDefaultDeck() {
  let { data: deck, error } = await supabase
    .from('decks')
    .select('*')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  if (error) toast('decks.select: ' + asText(error));
  if (!deck) {
    const ins = await supabase.from('decks').insert({ user_id: user.id, name: 'My Deck' }).select().single();
    if (ins.error) { toast('decks.insert: ' + asText(ins.error)); return null; }
    deck = ins.data;
  }
  return deck;
}

async function addWord(term, translation, example) {
  const deck = await ensureDefaultDeck();
  if (!deck) return;
  const ins = await supabase
    .from('words')
    .insert({ user_id: user.id, deck_id: deck.id, term, translation, example })
    .select().single();
  if (ins.error) { toast('words.insert: ' + asText(ins.error)); return; }
  await supabase.from('user_words').upsert({ user_id: user.id, word_id: ins.data.id });
  toast('Додано ✔');
}

async function fetchDueWords() {
  const { data, error } = await supabase
    .from('due_words_view')
    .select('*')
    .eq('user_id', user.id);
  if (error) { toast('due_words_view: ' + asText(error)); return []; }
  return (data || []).map(r => ({
    id: r.word_id,
    deck: r.deck_name || 'My Deck',
    term: r.term,
    translation: r.translation,
    example: r.example || ''
  }));
}

async function srsUpdate(wordId, quality) {
  const { error } = await supabase.rpc('srs_update', {
    p_user_id: user.id, p_word_id: wordId, p_quality: quality
  });
  if (error) toast('srs_update: ' + asText(error));
}

// ====== STATE / RENDER ======
let queue = [];
let pointer = 0;

function setDue() {
  document.getElementById('duePill').textContent = 'Черга: ' + Math.max(0, queue.length - pointer);
}

function loadCard() {
  setDue();
  const c = queue[pointer];
  const termEl = document.getElementById('term');
  const trEl = document.getElementById('translation');
  const exEl = document.getElementById('example');
  const deckEl = document.getElementById('deckName');

  if (!c) {
    termEl.textContent = '🎉 Все на сьогодні!';
    trEl.textContent = '';
    exEl.textContent = '';
    deckEl.textContent = '—';
    return;
  }
  deckEl.textContent = c.deck;
  termEl.textContent = c.term;
  trEl.textContent = c.translation || '';
  exEl.textContent = c.example || '';
  trEl.style.opacity = 0;
  exEl.style.opacity = 0;
}

function reveal() {
  document.getElementById('translation').style.opacity = 1;
  document.getElementById('example').style.opacity = 1;
  tg?.HapticFeedback?.impactOccurred('soft');
}

function speak() {
  const c = queue[pointer]; if (!c) return;
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(c.term);
    u.lang = 'en-US';
    window.speechSynthesis.speak(u);
  }
}

async function grade(q) {
  const c = queue[pointer]; if (!c) return;
  await srsUpdate(c.id, q);
  pointer++;
  loadCard();
}

async function refreshQueue() {
  await ensureUser();
  pointer = 0;
  queue = await fetchDueWords();

  // Якщо на сьогодні нічого — візьмемо останні додані слова (до 10)
  if (!queue.length) {
    const { data, error } = await supabase
      .from('words')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) toast('words.select: ' + asText(error));
    queue = (data || []).map(w => ({
      id: w.id, deck: 'My Deck', term: w.term, translation: w.translation, example: w.example || ''
    }));
  }

  loadCard();
  renderList(); // оновити словник
}

async function renderList() {
  const q = (document.getElementById('search').value || '').toLowerCase();
  const list = document.getElementById('list'); list.innerHTML = '';

  const { data, error } = await supabase
    .from('words')
    .select('id, term, translation, example, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) { toast('words.list: ' + asText(error)); return; }

  (data || [])
    .filter(x => x.term.toLowerCase().includes(q) || (x.translation || '').toLowerCase().includes(q))
    .forEach(x => {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <div>
          <div class="title">${x.term}</div>
          <div class="muted">${x.translation || ''}</div>
          ${x.example ? `<div class="muted" style="margin-top:4px">${x.example}</div>` : ''}
        </div>
        <button class="btn" data-id="${x.id}">Тренувати</button>
      `;
      div.querySelector('button').onclick = async () => {
        queue.unshift({ id: x.id, deck: 'My Deck', term: x.term, translation: x.translation, example: x.example || '' });
        pointer = 0; loadCard(); toast('Додано в початок черги');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
      list.appendChild(div);
    });
}

// ====== EVENTS ======
document.getElementById('btnStart').onclick = refreshQueue;
document.getElementById('btnReveal').onclick = reveal;
document.getElementById('btnSpeak').onclick = speak;
document.getElementById('btnHard').onclick = () => grade(1);
document.getElementById('btnDoubt').onclick = () => grade(3);
document.getElementById('btnEasy').onclick = () => grade(5);
document.getElementById('btnSync').onclick = refreshQueue;
document.getElementById('search').oninput = renderList;

document.getElementById('btnAdd').onclick = async () => {
  const term = document.getElementById('termInput').value.trim();
  const tr = document.getElementById('transInput').value.trim();
  const ex = document.getElementById('exInput').value.trim();
  if (!term || !tr) { toast('Вкажи слово та переклад'); return; }
  await addWord(term, tr, ex);
  document.getElementById('termInput').value = '';
  document.getElementById('transInput').value = '';
  document.getElementById('exInput').value = '';
  await renderList();
};

// ====== INIT ======
refreshQueue().catch(e => toast('init: ' + asText(e)));
