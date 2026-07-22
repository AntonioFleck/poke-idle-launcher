'use strict';

// Poke Idle Launcher — casca leve (Electron), coleta 100% pela REDE.
// Janela SEM MOLDURA. Disposição: barra no topo + PAINEL fixo à esquerda +
// JOGOS à direita (em GRADE ou ÚNICO). Vê-se o painel E os jogos ao mesmo tempo.
// Trocar de conta = clicar na aba (instantâneo). O DOM do jogo não é lido pra
// dado — só capturePage() pra print do MEU shiny.

const { app, BaseWindow, WebContentsView, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const gp = require('./game-parse');
const calc = require('./calc');
const api = require('./server-api');
const { createTokenVault } = require('./token-vault');

const SERVER_MODE = process.argv.includes('--server') || process.env.POKE_SERVER_MODE === '1';
if (SERVER_MODE && process.platform === 'linux') app.commandLine.appendSwitch('password-store', 'basic');
if (process.env.POKE_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.POKE_USER_DATA_DIR));
else app.setPath('userData', path.join(app.getPath('appData'), 'poke-coletor'));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// manter o jogo rodando a full mesmo escondido (não freia a hunt idle)
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const GAME_URL = 'https://poke.idleworld.online/play';
const MAXV = 4;
const LANDING_URL = 'https://idle247.antoniofleck.com.br/?ref=launcher';
const BAR = 46;      // altura da barra (bate com o app.html)
const SIDE_W = 312;  // largura da sidebar no modo "jogo em foco" (bate com .side.wide)

const rarityIdx = (r) => { const i = gp.RARITY_ORDER.indexOf((r || '').trim()); return i < 0 ? 1 : i; };

// catálogo de itens do jogo (id -> nome/ícone/categoria), pra montar a Bag
const GAME_ORIGIN = 'https://poke.idleworld.online';
// normaliza o ícone do item pra uma URL usável: absoluta fica; começando com "/" ganha o origin;
// nome cru vira /assets/items/<nome> (mesma regra do cliente do jogo).
function itemIconUrl(icon) {
  if (!icon) return null;
  if (/^https?:\/\//.test(icon)) return icon;
  if (icon.startsWith('/')) return GAME_ORIGIN + icon;
  return GAME_ORIGIN + '/assets/items/' + icon;
}
let itemCatalog = {};
async function loadItemCatalog() {
  try {
    const r = await fetch(GAME_ORIGIN + '/game/items.json');
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.items || Object.values(j));
    for (const it of arr) itemCatalog[it.id] = { name: it.name, icon: itemIconUrl(it.icon), category: it.category, rare: it.rare, npcPrice: it.npcPrice };
  } catch (e) { console.error('[coletor] items.json', e && e.message); }
}
function buildBag(inv) {
  if (!inv) return null;
  let total = 0; const items = [];
  for (const it of inv) {
    const c = itemCatalog[it.itemId] || {};
    total += it.quantity || 0;
    items.push({ id: it.itemId, name: c.name || ('item ' + it.itemId), icon: c.icon || null, category: c.category || 'loot', rare: !!c.rare, qty: it.quantity, price: c.npcPrice || 0 });
  }
  return { total, items };
}

// catálogo de espécies (pokédex): dex, nome, tipos, nível de hunt, raridade
let creatures = [];
// mapa nome(->dex NACIONAL) só das espécies base (pokeId<10000). Outland/variantes têm pokeId>=10000
// (ex.: "Brave Blastoise"=10001) e NÃO existem no PokeAPI — pra achar o sprite a gente casa pelo nome
// (última palavra) com o dex base ("Brave Blastoise" -> "blastoise" -> 9).
let dexByName = {};
function idxName(name, dex) {
  if (!name) return;
  const low = String(name).toLowerCase();
  if (dexByName[low] == null) dexByName[low] = dex;
  const toks = low.split(/[\s-]+/).filter(Boolean);
  const last = toks[toks.length - 1];
  if (last && dexByName[last] == null) dexByName[last] = dex;
}
// dex "renderável" no PokeAPI: se já é nacional (<10000) usa direto; senão resolve pelo nome (outland).
function resolveDex(id, name) {
  if (id != null && id > 0 && id < 10000) return id;
  if (name) {
    const low = String(name).toLowerCase();
    if (dexByName[low] != null) return dexByName[low];
    const toks = low.split(/[\s-]+/).filter(Boolean);
    for (let i = toks.length - 1; i >= 0; i--) if (dexByName[toks[i]] != null) return dexByName[toks[i]];
  }
  return (id != null && id > 0 && id < 10000) ? id : null;
}
async function loadCreatures() {
  try {
    const j = await (await fetch('https://poke.idleworld.online/game/creatures.json')).json();
    const arr = Array.isArray(j) ? j : (j.creatures || Object.values(j));
    creatures = arr.map((c) => ({ dex: c.pokeId, name: c.name, type1: c.type1, type2: c.type2 || null, huntLevel: c.huntLevel, rarity: c.rarity }));
    dexByName = {};
    for (const c of arr) if (c.pokeId != null && c.pokeId < 10000) idxName(c.name, c.pokeId);   // só as base viram fonte de sprite
  } catch (e) { console.error('[coletor] creatures.json', e && e.message); }
}

// LOGIN PERSISTENTE: o jogo autentica por cookie de SESSÃO, que o Electron apaga
// ao fechar. Aqui a gente converte esses cookies em PERSISTENTES (via API de sessão,
// no processo main — não toca no jogo, não envia nada ao servidor).
async function persistCookies(g) {
  try {
    const ses = g.view.webContents.session;
    const cookies = await ses.cookies.get({ domain: 'idleworld.online' });
    const far = Math.floor(Date.now() / 1000) + 60 * 24 * 3600; // 60 dias
    for (const c of cookies) {
      if (!c.session) continue;   // só as de sessão precisam virar persistentes
      const host = String(c.domain || '').replace(/^\./, '');
      if (!host) continue;
      const url = (c.secure ? 'https://' : 'http://') + host + (c.path || '/');
      try {
        const sameSite = c.sameSite && c.sameSite !== 'unspecified' ? c.sameSite : 'lax';   // 'unspecified' faz o set falhar em silêncio
        await ses.cookies.set({ url, name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite, expirationDate: far });
      } catch {}
    }
    await ses.cookies.flushStore();
  } catch {}
}

// SONDA read-only: grava só as CHAVES de storage (NUNCA valores/token) pra eu ver como o jogo guarda o login
async function debugAuth(g) {
  try {
    const ses = g.view.webContents.session;
    const cookies = await ses.cookies.get({ domain: 'idleworld.online' });
    let ls = [], ss = [];
    try { const r = await g.view.webContents.executeJavaScript('({ls:Object.keys(localStorage||{}),ss:Object.keys(sessionStorage||{})})', true); ls = r.ls || []; ss = r.ss || []; } catch {}
    const info = {
      slot: g.slot, t: Date.now(), url: (g.view.webContents.getURL() || '').split('?')[0],
      cookies: cookies.map((c) => ({ name: c.name, session: !!c.session, secure: !!c.secure, httpOnly: !!c.httpOnly })),
      localStorage: ls, sessionStorage: ss,   // SÓ as chaves — valores nunca são gravados
    };
    fs.writeFileSync(path.join(__dirname, `auth-debug-acc${g.slot}.json`), JSON.stringify(info, null, 2));
  } catch {}
}

// LEMBRAR LOGIN: o jogo guarda a sessão em sessionStorage['pokeweb:tokens'], que some ao fechar.
// A gente salva esse token (CRIPTOGRAFADO, na userData — nunca na pasta compartilhada) e restaura ao abrir.
// Só o token do próprio usuário volta pro lugar dele; nenhuma ação de jogo é injetada.
const TOKEN_KEY = 'pokeweb:tokens';
let tokenDir = null;
let tokenVault = null;
async function saveToken(g) {
  try {
    if (!tokenVault) return;
    const tok = await g.view.webContents.executeJavaScript(`sessionStorage.getItem(${JSON.stringify(TOKEN_KEY)})`, false);
    tokenVault.save(g.slot, tok);
  } catch {}
}
function loadToken(slot) {
  try { return tokenVault ? tokenVault.load(slot) : null; } catch { return null; }
}
function attachTokenRestore(g) {
  let tried = false;
  g.view.webContents.on('did-finish-load', async () => {
    if (tried) return;
    try {
      const has = await g.view.webContents.executeJavaScript(`sessionStorage.getItem(${JSON.stringify(TOKEN_KEY)})`, false);
      if (has) return;   // já logado nesta sessão
      const saved = loadToken(g.slot);
      if (!saved) return;
      tried = true;
      await g.view.webContents.executeJavaScript(`sessionStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(saved)})`, false);
      g.view.webContents.reload();   // recarrega já com o token → entra logado, sem relogar
    } catch {}
  });
}

let win = null;
let dashView = null;
const games = [];          // { view, slot, state, recent, startTs, leaderLevelStart, _lastPush }
const seenNothing = {};
let selectedSlot = null;
let gameMode = 'grid';     // 'grid' | 'single'
let view = 'accounts';     // 'accounts' | 'captures'
let overlayWin = null;
const globalSeen = new Map();
let diagOn = false;        // modo diagnóstico: grava os frames crus do WS pra realinhar o parser
let dumpPath = null;
const diagSeen = {};
// pra rodar a noite toda sem virar GB: capa só o RUÍDO repetido; guarda captura/eventos com folga; nunca descarta shiny.
const DIAG_CAP = { field: 15, 'field-kill': 400, 'catch-result': 400, 'poke-xp': 200, chat: 40, analyzer: 800, 'shiny-global': 400 };
const DIAG_DEFAULT_CAP = 3000;   // poke-delta (capturas), pokes, balls, inventory, events, field-init, profissão, tipos NOVOS...
function dumpFrame(slot, payload) {
  if (!dumpPath) return;
  try {
    let type = 'unknown'; try { const j = JSON.parse(payload); if (j && j.type) type = j.type; } catch {}
    if (!/"shiny":\s*true/.test(payload)) {                       // shiny nunca é descartado
      const cap = DIAG_CAP[type] != null ? DIAG_CAP[type] : DIAG_DEFAULT_CAP;
      diagSeen[type] = (diagSeen[type] || 0) + 1;
      if (diagSeen[type] > cap) return;
    }
    fs.appendFileSync(dumpPath, JSON.stringify({ slot, t: Date.now(), type, raw: payload }) + '\n');
  } catch {}
}

const activeSlots = () => games.map((g) => g.slot);
function nextFreeSlot() { for (let s = 1; s <= MAXV; s++) if (!activeSlots().includes(s)) return s; return null; }
function persistSlots() { try { store.setSettings({ activeSlots: activeSlots() }); } catch {} }
function charNameOf(slot) { const g = games.find((x) => x.slot === slot); return (g && g.state && g.state.charName) || null; }
// rótulo da conta: nome que o Antônio deu > nick do char (da REST) > "Conta N"
function realName(slot) { const n = (store.getSettings().accountNames || {})[String(slot)]; return n || charNameOf(slot) || null; }
function getName(slot) { return realName(slot) || `Conta ${slot}`; }
// grava o evento com o nome REAL da conta se já conhecido; o fallback "Conta N" nunca vai pro disco,
// só pra UI — assim o histórico ganha o nick retroativamente quando ele carregar
function appendEv(slot, obj) {
  const n = realName(slot);
  const ev = store.appendEvent(Object.assign({ account: `acc${slot}` }, n ? { accountName: n } : {}, obj));
  return ev.accountName ? ev : Object.assign({ accountName: getName(slot) }, ev);
}

// ---------------- layout ----------------
const GAP = 3;   // divisória fininha entre as telas
function _tiles(count, x, y, w, h) {
  if (count <= 1) return [{ x, y, width: w, height: h }];
  const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
  if (count === 2) return [{ x, y, width: hw, height: h }, { x: x + hw, y, width: w - hw, height: h }];
  if (count === 3) return [{ x, y, width: hw, height: hh }, { x: x + hw, y, width: w - hw, height: hh }, { x, y: y + hh, width: w, height: h - hh }];
  return [{ x, y, width: hw, height: hh }, { x: x + hw, y, width: w - hw, height: hh }, { x, y: y + hh, width: hw, height: h - hh }, { x: x + hw, y: y + hh, width: w - hw, height: h - hh }];
}
function tileRects(count, x, y, w, h) {
  return _tiles(count, x, y, w, h).map((r) => ({ x: r.x + GAP, y: r.y + GAP, width: Math.max(r.width - GAP * 2, 20), height: Math.max(r.height - GAP * 2, 20) }));
}
// ⚠️ FOCO: esconder/mover/re-addChildView uma WebContentsView FOCADA rouba o foco OS do
// input do jogo (era o bug "input desfoca sozinho": o painel re-mandava view/modo em todo
// render e cada layout() redundante escondia/re-adicionava as telas). Por isso o layout é
// IDEMPOTENTE: calcula o alvo e só aplica a DIFERENÇA; não re-adiciona child view
// (a ordem z já fica certa desde a criação: painel primeiro, jogos por cima).
function setViewBounds(v, r) {
  try { const c = v.getBounds(); if (c.x === r.x && c.y === r.y && c.width === r.width && c.height === r.height) return; } catch {}
  v.setBounds(r);
}
function layout() {
  if (!win) return;
  const b = win.getContentBounds();
  setViewBounds(dashView, { x: 0, y: 0, width: b.width, height: b.height });   // a UI (app.html) ocupa a janela toda
  const target = new Map();   // slot -> rect das telas que devem estar VISÍVEIS
  if (view === 'game') {
    const x0 = SIDE_W, y0 = BAR, w = Math.max(b.width - x0, 100), h = Math.max(b.height - y0, 100);
    if (gameMode === 'grid') {                                             // GRADE: todas as telas do jogo em 2×2 (1–4)
      const rects = tileRects(games.length, x0, y0, w, h);
      games.forEach((g, i) => { if (rects[i]) target.set(g.slot, rects[i]); });
    } else if (selectedSlot != null) {                                     // FOCO: só a conta selecionada, tela cheia à direita
      if (games.some((x) => x.slot === selectedSlot)) target.set(selectedSlot, { x: x0, y: y0, width: w, height: h });
    }
  }
  games.forEach((g) => {
    const r = target.get(g.slot);
    if (r) { setViewBounds(g.view, r); if (g._shown !== true) { g.view.setVisible(true); g._shown = true; } }
    else if (g._shown !== false) { g.view.setVisible(false); g._shown = false; }
  });
}

// ---------------- injeção de UX no jogo (CSS reversível — nada de gameplay/DOM de dado) ----------------
// O jogo usa classes CSS legíveis. A gente injeta 1 folha de estilo que, sob html.pcz-clean,
// esconde o chat (foi pro painel do coletor) e deixa as barras que sobrepõem tudo (nav, dock,
// auto-helper, barra de pokémon) BEM apagadas, voltando ao normal no hover. Só declutter visual.
const GAME_UX_CSS = [
  'html.pcz-clean .msg-chat{display:none !important;}',                                                      /* chat foi pro painel do coletor */
  'html.pcz-clean .game-hud,html.pcz-clean .game-dock{opacity:.08 !important;transition:opacity .18s ease !important;}',   /* MENU: some e volta no hover */
  'html.pcz-clean .game-hud:hover,html.pcz-clean .game-dock:hover{opacity:1 !important;}',
  'html.pcz-clean .phud{top:82px !important;}',        /* barra de pokémon: NÃO some, só desce */
  'html.pcz-clean .ah-panel{top:74px !important;}',    /* auto-helper: NÃO some, só desce */
].join('\n');
function injectGameUX(g) {
  try {
    const wc = g.view.webContents; if (!wc || wc.isDestroyed()) return;
    const clean = store.getSettings().gameClean !== false;
    const js = `(function(){try{var s=document.getElementById('pcz-ux');if(!s){s=document.createElement('style');s.id='pcz-ux';s.textContent=${JSON.stringify(GAME_UX_CSS)};(document.head||document.documentElement).appendChild(s);}document.documentElement.classList.toggle('pcz-clean', ${clean});}catch(e){}})()`;
    wc.executeJavaScript(js, false).catch(() => {});
  } catch {}
}

// ---------------- helper de UX injetado no jogo (seletor de nível no Mapa) ----------------
// NÃO automatiza gameplay nem lê dado da conta: adiciona um <select> de faixa de nível ao filtro
// do Mapa (mantém os inputs de/até, só preenche via setter React-aware).
const GAME_HELPERS_JS = `(function(){
  if(window.__pczHelpers) return; window.__pczHelpers=1;
  try{
    var nset=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    function setIn(i,v){ try{ nset.call(i,String(v)); i.dispatchEvent(new Event('input',{bubbles:true})); }catch(_){} }
    function enh(){ try{
      var lab=document.querySelector('label.map-filter-lvl'); if(!lab||lab.__pcz) return;
      var ins=lab.querySelectorAll('input[type=number]'); if(ins.length<2) return; lab.__pcz=1;
      var de=ins[0], ate=ins[1], s=document.createElement('select');
      s.title='Faixa de nível'; s.style.cssText='margin-left:6px;background:#182231;color:#e8edf5;border:1px solid #33405a;border-radius:6px;padding:2px 4px;font-size:12px;cursor:pointer';
      [['Nível…','',''],['1–20',1,20],['20–40',20,40],['40–60',40,60],['60–80',60,80],['80–100',80,100],['100–120',100,120],['120–140',120,140],['140+',140,'']].forEach(function(b){var o=document.createElement('option');o.value=b[1]+'|'+b[2];o.textContent=b[0];s.appendChild(o);});
      s.addEventListener('change',function(){var p=s.value.split('|');setIn(de,p[0]);setIn(ate,p[1]);});
      lab.appendChild(s);
    }catch(_){}}
    var mo=new MutationObserver(enh); mo.observe(document.documentElement,{childList:true,subtree:true}); enh();
  }catch(_){}
})();`;
function injectGameHelpers(g) {
  try { const wc = g.view.webContents; if (!wc || wc.isDestroyed()) return; wc.executeJavaScript(GAME_HELPERS_JS, false).catch(() => {}); } catch {}
}

// ---------------- proteção de venda (bloqueia venda de raro via interceptação REST) ----------------
const SELL_PATTERNS = ['*/api/game/pokemon/sell', '*/api/game/shop/sell', '*/api/game/flint/sell'];
// devolve o motivo (string) se a venda inclui algo PROTEGIDO; senão null
function protectedInSell(state, url, body) {
  if (!body) return null;
  if (/pokemon\/sell/.test(url)) {                        // pokes: shiny ou lendário+
    const team = state.team || [];
    for (const pid of (body.pokeIds || [])) {
      const p = team.find((x) => x.id === pid); if (!p) continue;
      if (p.shiny) return `${p.name} ✨ shiny`;
      const r = gp.rarityFromQuality(p.quality);
      if (rarityIdx(r) >= rarityIdx('Lendária')) return `${p.name} (${r})`;
    }
    return null;
  }
  // itens: categoria 'card' (shiny cards) + Rare Pokémon Picture + Strange Pheromone
  const entries = Array.isArray(body.items) ? body.items : (body.itemId != null ? [{ itemId: body.itemId }] : []);
  for (const e of entries) {
    const iid = e && e.itemId != null ? e.itemId : e;
    const cat = itemCatalog[iid] || {}; const nm = cat.name || ('item ' + iid);
    if (cat.category === 'card') return nm;
    if (/pheromone|picture/i.test(nm)) return nm;
  }
  return null;
}
function handleSellIntercept(g, wc, params) {
  const id = params.requestId;
  const cont = () => { try { wc.debugger.sendCommand('Fetch.continueRequest', { requestId: id }).catch(() => {}); } catch {} };
  try {
    if (store.getSettings().sellProtect === false) return cont();
    const url = (params.request && params.request.url) || '';
    let body = null; try { body = JSON.parse((params.request && params.request.postData) || '{}'); } catch {}
    const prot = protectedInSell(g.state, url, body);
    if (prot) {   // BLOQUEIA a venda e avisa
      try { wc.debugger.sendCommand('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' }).catch(() => {}); } catch {}
      fireAlert(g, 'sell_blocked', { what: prot });
      return;
    }
    return cont();
  } catch { return cont(); }   // fail-open: erro nunca trava o jogo
}

// ---------------- captura de rede (CDP) ----------------
function attachCapture(g) {
  const wc = g.view.webContents;
  const wsUrls = new Map();
  try { wc.debugger.attach('1.3'); }
  catch (e) { console.error('[coletor] attach', g.slot, e && e.message); return; }
  wc.debugger.sendCommand('Network.enable').catch(() => {});
  wc.debugger.sendCommand('Fetch.enable', { patterns: SELL_PATTERNS.map((p) => ({ urlPattern: p, requestStage: 'Request' })) }).catch(() => {});   // pausa SÓ as vendas
  wc.debugger.on('message', (_e, method, params) => {
    try {
      if (method === 'Fetch.requestPaused') handleSellIntercept(g, wc, params);
      else if (method === 'Network.webSocketCreated') wsUrls.set(params.requestId, params.url);
      else if (method === 'Network.webSocketFrameReceived') {
        const r = params.response;
        if (r && r.opcode === 1 && r.payloadData) {
          g._lastFrameTs = Date.now();
          if (g._al && g._al.disc) { g._al.disc = false; fireAlert(g, 'reconnected', {}); }   // voltou a receber → religou
          if (diagOn) dumpFrame(g.slot, r.payloadData);   // modo diagnóstico ligado: grava o frame cru
          const msg = gp.parseFrame(r.payloadData);
          if (msg) handleMessage(g, msg);
        }
      }
    } catch { /* nunca derruba */ }
  });
}

// ---------------- coleta SERVIDOR (REST autoritativo, sob demanda) ----------------
// O jogo empurra `pokes`/`balls`/`pokedex` pelo WS só quando o painel abre DENTRO do jogo.
// A gente PUXA o mesmo dado da API REST (só GET, leitura pura) pra completar o painel sem
// abrir nada no jogo. IMPORTANTE (regras do jogo, seção 03): ferramentas que "performam
// ações repetidas automaticamente / simulam presença" são proibidas. Por isso NÃO há
// timer/metrônomo: o pull dispara só em EVENTOS REAIS do usuário — 1× ao logar/carregar a
// conta e quando ele clica "Atualizar" no painel. É equivalente a abrir o painel no jogo. Ver server-api.js.
let shapesDumped = false;       // grava 1x o JSON cru de cada endpoint pra calibrar os parsers

function dumpServerShapes(snap) {
  if (shapesDumped || !snap) return;
  try {
    const p = path.join(__dirname, 'server-shapes.json');
    fs.writeFileSync(p, JSON.stringify(snap, null, 2));
    shapesDumped = true;
    console.log('[coletor] server-shapes.json gravado (calibração)');
  } catch {}
}

async function pollServer(g) {
  if (!g || !g.view || g.view.webContents.isDestroyed()) return;
  let snap;
  try { snap = await api.pullSnapshot(g.view.webContents); } catch { return; }
  if (!snap || snap.__noauth || snap.__error) return;   // ainda não logou / falhou → mantém o WS
  dumpServerShapes(snap);
  const s = g.state;

  // BOLAS (com preço certo) — autoritativo, sem depender de abrir a bag no jogo
  const balls = api.normBalls(snap.balls);
  if (balls) {
    if (balls.catalog) s.ballCatalog = balls.catalog;
    if (balls.counts) s.balls = balls.counts;
  }

  // PROFILE = jackpot: nick, nível+XP, contagem AUTORITATIVA da pokédex, saldo, rank global
  const prof = api.normProfile(snap.profile);
  if (prof) {
    if (prof.level != null) s.trainer = { level: prof.level, xpInLevel: prof.xpInLevel, xpForNext: prof.xpForNext, rank: prof.rank, totalPlayers: prof.totalPlayers, totalCatches: prof.totalCatches };
    if (prof.gold != null) s.accountGold = prof.gold;
    if (prof.diamonds != null) s.diamonds = prof.diamonds;
    // NICK do char (rótulo da conta em vez de "Conta 1")
    if (prof.name && typeof prof.name === 'string') { const had = s.charName; s.charName = prof.name; if (!had && !store.getSettings().accountNames[String(g.slot)]) send(dashView, 'accounts', activeSlots()); }
  }

  // POKÉDEX: contagem AUTORITATIVA = profile.pokedexCount (o /pokedex.species é parcial). total = catálogo.
  const pk = api.normPokedex(snap.pokedex);
  const caughtCount = (prof && prof.pokedexCount != null) ? prof.pokedexCount : (pk ? pk.caught : null);
  if (caughtCount != null) s.serverPokedex = { caught: caughtCount, total: creatures.length || (pk && pk.total) || null, unlockKills: pk ? pk.unlockKills : null };

  // PROFISSÃO (Treinador de Prestígio): rank + progresso — resolve o painel que dependia de abrir no jogo
  const pf = api.normProfessions(snap.professions);
  if (pf) s.serverProfessions = pf;

  // STREAK: pontos + kills por espécie AUTORITATIVOS (pras metas Shiny Card / bônus pokédex)
  const streak = api.normStreak(snap.streak);
  if (streak) { s.serverStreak = streak; if (Object.keys(streak.killsByName).length) s.serverKillsByName = streak.killsByName; }

  // coleção inteira / offline / used-balls — guarda cru (uso futuro)
  s.serverAllPokes = snap.allPokes || s.serverAllPokes || null;
  s.serverOffline = snap.offline || s.serverOffline || null;
  s.serverUsedBalls = snap.usedBalls || s.serverUsedBalls || null;
  s._serverTs = Date.now();

  pushState(g);
}

// ---------------- eventos ----------------
function isRare(cap, st) {
  if (rarityIdx(cap.rarity) >= rarityIdx(st.alertRarity)) return true;
  if (cap.iv && cap.iv / 192 >= (st.ivAlertFrac || 0.9)) return true;
  return false;
}
function dedupeGlobal(gl) {
  const key = `${gl.player}|${gl.name}`, now = Date.now(), last = globalSeen.get(key);
  globalSeen.set(key, now);
  if (globalSeen.size > 200) globalSeen.delete(globalSeen.keys().next().value);
  return !(last && now - last < 8000);
}

function handleMessage(g, msg) {
  if (msg.type === 'chat' && msg.msg) {   // chat do jogo → painel do coletor (o in-game fica oculto)
    const c = msg.msg;
    pushChat({ account: `acc${g.slot}`, accountName: getName(g.slot), channel: c.channel || 'world', from: c.fromName, level: c.level, vip: !!c.isVip, admin: !!c.isAdmin, body: c.body, at: c.at || new Date().toISOString() });
  }
  const evs = gp.applyMessage(g.state, msg);
  const st = store.getSettings();
  for (const e of evs) {
    if (e.type === 'capture' || e.type === 'shiny_capture') {
      const c = e.cap;
      const dex = resolveDex(c.speciesId, c.name);   // resolve sprite (outland casa pelo nome)
      const rec = { ts: Date.now(), name: c.name, dex, iv: c.iv, quality: c.quality, rarity: c.rarity, shiny: !!c.shiny };
      g.recent.push(rec); if (g.recent.length > 100) g.recent.shift();
      const kind = c.shiny ? 'shiny_capture' : (isRare(c, st) ? 'rare_capture' : 'capture');
      const ev = appendEv(g.slot, { type: kind, name: c.name, dex, iv: c.iv, ivMax: 192, quality: c.quality, rarity: c.rarity, ball: c.ball, shiny: !!c.shiny });
      const ui = ev;
      pushEvent(ui);
      if (kind !== 'capture') { alertUI(ui); if (kind === 'shiny_capture' && st.screenshotOnShiny) shoot(g, ev); }
    } else if (e.type === 'shiny_wild') {
      const ev = appendEv(g.slot, { type: 'shiny_wild', name: e.cap.name, dex: resolveDex(e.cap.speciesId, e.cap.name) });
      pushEvent(ev); alertUI(ev);
    } else if (e.type === 'shiny_global') {
      if (dedupeGlobal(e.global)) {
        const ev = appendEv(g.slot, { type: 'shiny_global', player: e.global.player, name: e.global.name, dex: e.global.dexId, tier: e.global.tier });
        pushEvent(ev); alertUI(ev);
        // (a pedido: SEM print no shiny global — só no MEU shiny)
      }
    } else if (e.type === 'hunt-reset') {
      g.startTs = Date.now(); g.leaderLevelStart = null; g.recent = [];   // zera o cronômetro dos "por hora"
    } else if (e.type === 'disconnected') {
      if (!g._al || !g._al.disc) { (g._al = g._al || {}).disc = true; fireAlert(g, 'disconnected', { reason: e.reason || null }); }
    } else if (e.type === 'died') {
      fireAlert(g, 'died', { name: e.name || null });
    }
  }
  evalAlerts(g);
  if (msg.type !== 'field' && msg.type !== 'chat') pushState(g);
}

// ---------------- alertas (balls/potions acabando, morte, desconexão) ----------------
function fireAlert(g, type, extra) {
  const ev = appendEv(g.slot, Object.assign({ type }, extra || {}));
  pushEvent(ev); alertUI(ev);
}
// total de bolas ÚTEIS (ignora Master id 5, que é rara/limitada e não conta pra "acabando")
function ballsTotalUsable(s) { if (!s.balls) return null; let t = 0; for (const [id, q] of Object.entries(s.balls)) { if (String(id) === '5') continue; t += q || 0; } return t; }
// total de potions (itens da categoria heal do inventário)
function potionsTotal(s) { if (!s.inventory) return null; let t = 0; for (const it of s.inventory) { const c = itemCatalog[it.itemId]; if (c && c.category === 'heal') t += it.quantity || 0; } return t; }
// dispara alertas por LIMIAR com histerese (só refoga quando volta bem acima → não fica repetindo)
function evalAlerts(g) {
  const s = g.state, st = store.getSettings();
  g._al = g._al || {};
  const ballsThr = st.ballsAlert != null ? st.ballsAlert : 200;
  const potThr = st.potionsAlert != null ? st.potionsAlert : 30;
  const bt = ballsTotalUsable(s);
  if (bt != null) {
    if (bt <= ballsThr && !g._al.balls) { g._al.balls = true; fireAlert(g, 'balls_low', { count: bt }); }
    else if (bt > ballsThr * 1.5) g._al.balls = false;
  }
  const pt = potionsTotal(s);
  if (pt != null) {
    if (pt <= 0 && !g._al.potOut) { g._al.potOut = true; fireAlert(g, 'potions_out', {}); }
    else if (pt > 0) g._al.potOut = false;
    if (pt > 0 && pt <= potThr && !g._al.pot) { g._al.pot = true; fireAlert(g, 'potions_low', { count: pt }); }
    else if (pt > potThr * 1.5) g._al.pot = false;
  }
}

const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const titleCase = (s) => String(s || '').split(/\s+/).map(cap1).join(' ');
// info do que está caçando (dex + tipo) pra a cena e o preview PokeAPI.
// o slug vem com underscore ("enraged_typhlosion") — normaliza pra casar com o nome da criatura,
// e resolve o dex de sprite (outland tem pokeId>=10000, cai no resolveDex pelo nome).
function huntInfo(slug) {
  if (!slug) return null;
  const norm = String(slug).replace(/_/g, ' ').toLowerCase();
  const c = creatures.find((x) => x.name && x.name.toLowerCase() === norm);
  return { slug, name: c ? c.name : titleCase(norm), dex: c ? resolveDex(c.dex, c.name) : resolveDex(null, norm), type: c ? (c.type1 || null) : null };
}

function compactState(g) {
  const s = g.state;
  const leader = (s.team || []).find((p) => p.leader) || (s.team || [])[0] || null;
  if (leader && g.leaderLevelStart == null) g.leaderLevelStart = leader.level;
  const now = Date.now();
  const hrs = Math.max((now - g.startTs) / 3600000, 1 / 3600);
  const L = s.live, a = s.analyzer;
  const hunt = huntInfo(s.hunt && s.hunt.slug);
  const captures = L.captures || 0;
  const cc = calc.catchCost(L, s.ballCatalog, s._lastBall);
  const shiny = calc.shinyStats(L, hrs);
  const gn = calc.goldNet(a);
  const xb = calc.xpBreakdown(L);
  const gl = calc.goals(s, hunt ? hunt.name : null);
  // OURO calculado por conta própria (não depende do analyzer aberto): loot×preço + venda das capturas − custo das balls
  const lootGold = Object.values(L.loot).reduce((sum, e) => sum + (e.qty || 0) * (((itemCatalog[e.itemId] || {}).npcPrice) || 0), 0);
  // loot detalhado com preço/ouro por item (pra tabela de loot do dashboard) — cópia, não mexe no estado
  const lootDetailed = {};
  for (const e of Object.values(L.loot)) {
    const cat = itemCatalog[e.itemId] || {};
    const price = cat.npcPrice || 0;
    lootDetailed[e.itemId] = { itemId: e.itemId, name: e.name, qty: e.qty, price, gold: (e.qty || 0) * price, icon: cat.icon || null };
  }
  const ballCost = Object.entries(L.ballsUsed || {}).reduce((sum, [bid, cnt]) => {
    const b = (s.ballCatalog || []).find((x) => String(x.id) === String(bid));
    return sum + cnt * (((b || {}).priceGold) || 0);
  }, 0);
  const captureGold = L.captureGold || 0;
  const netGoldCalc = lootGold + captureGold - ballCost;
  const goldPerHourCalc = Math.round(netGoldCalc / hrs);
  const caughtArr = store.getCaught(`acc${g.slot}`);
  // pokédex: prefere a contagem AUTORITATIVA do servidor; senão cai no acumulado do disco
  const sp = s.serverPokedex || null;
  const dexTotal = (sp && sp.total) || creatures.length || 0;
  const dexCaught = (sp && sp.caught != null) ? sp.caught : caughtArr.length;
  const ballList = (s.ballCatalog || []).map((b) => ({ id: b.id, name: b.name, qty: (s.balls || {})[b.id] || 0, icon: itemIconUrl(b.iconUrl) })).filter((b) => b.qty > 0);
  const live = {
    captures, shinyCaptures: L.shinyCaptures, kills: L.kills, xp: L.xp,
    xpPerHour: Math.round(L.xp / hrs), killsPerHour: Math.round(L.kills / hrs),
    attempts: L.attempts || 0, catchPct: L.attempts ? +(captures / L.attempts * 100).toFixed(2) : null,
    ballsPerCap: cc.ballsPerCap, goldPerCap: cc.goldPerCap,
    levelUps: L.levelUps,
    levelsPerHour: (g.leaderLevelStart != null && leader) ? +(Math.max(0, leader.level - g.leaderLevelStart) / hrs).toFixed(2) : null,
    byRarity: L.byRarity, sinceMs: now - g.startTs, loot: lootDetailed,
  };
  return {
    slot: g.slot, name: getName(g.slot),
    loggedIn: !!(s.hunt || a || (s.team && s.team.length) || L.kills > 0),
    hunt,
    leader: leader ? {
      name: leader.name, dex: resolveDex(leader.speciesId, leader.name), level: leader.level, iv: leader.ivTotal, ivMax: 192,
      quality: leader.quality, rarity: gp.rarityFromQuality(leader.quality), power: leader.power,
      shiny: !!leader.shiny, stats: leader.stats || null,
      evolvesTo: leader.evolvesToName || null, evolveNeedLevel: leader.evolveNeedLevel || null,
    } : null,
    teamCount: (s.team || []).filter((p) => p.team).length,   // pokes.list traz a coleção inteira; time = os com team:true
    analyzer: a || null, live,
    // OURO/h = SEMPRE o nosso cálculo fiel (loot+capturas−balls), que reseta por hunt.
    // (não usar o goldPerHour do analyzer OFICIAL: só existe com o painel aberto e fica velho na troca de hunt)
    kpi: { netPerHour: goldPerHourCalc, xpPerHour: Math.round(L.xp / hrs), captures, shinyCaught: L.shinyCaught || 0, ballsPerCap: cc.ballsPerCap },
    goldNet: gn, goldCalc: { lootGold, captureGold, ballCost, net: netGoldCalc, perHour: goldPerHourCalc }, xpBreak: xb, shiny, goals: gl,
    prof: { photos: s.profession.photos || 0 }, mail: s.mail || null,
    trainer: s.trainer || null, accountGold: s.accountGold != null ? s.accountGold : null, diamonds: s.diamonds != null ? s.diamonds : null,
    profession: s.serverProfessions || null,   // rank/rankName/pictures/nextStep (autoritativo da REST)
    pokedex: { caught: dexCaught, total: dexTotal, missing: dexTotal ? Math.max(dexTotal - dexCaught, 0) : null, source: sp ? 'server' : 'local' },
    balls: s.balls || null, ballList, bag: buildBag(s.inventory), caught: caughtArr,
    boosts: (s.boosts || []).map((b) => ({ name: b.name, emoji: b.emoji, desc: b.desc, until: b.until, pct: b.pct })),
    bestCatch: s.bestCatch || null,
    recent: g.recent.slice(-40).reverse(),
  };
}
function send(target, ch, payload) { try { if (target && !target.webContents.isDestroyed()) target.webContents.send(ch, payload); } catch {} }
function pushState(g) {
  const now = Date.now();
  if (now - (g._lastPush || 0) < 700) return;
  g._lastPush = now;
  store.addCaught(`acc${g.slot}`, [...g.state.caughtSpecies]);   // acumula a pokédex no disco
  store.saveProgress(`acc${g.slot}`, { analyzer: g.state.analyzer, profession: g.state.profession, mail: g.state.mail });   // persiste pra mostrar sem re-abrir
  const cs = compactState(g);
  store.setLatest(`acc${g.slot}`, cs);
  send(dashView, 'state', cs);
  if (overlayWin && !overlayWin.isDestroyed()) send(overlayWin, 'state', cs);
}
function pushEvent(ev) { send(dashView, 'event', ev); if (overlayWin && !overlayWin.isDestroyed()) send(overlayWin, 'event', ev); }
function pushChat(m) { send(dashView, 'chat', m); }
function alertUI(ev) { send(dashView, 'alert', ev); if (overlayWin && !overlayWin.isDestroyed()) send(overlayWin, 'alert', ev); }
function shoot(g, ev) {
  const wc = g.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.capturePage().then((img) => {
    const p = store.saveShot(`acc${g.slot}`, img.toPNG());
    if (p) pushEvent(appendEv(g.slot, { type: 'shot', shot: p, of: ev.type, name: ev.name || null }));
  }).catch(() => {});
}

// ---------------- telas ----------------
function seedFromCache(g) {   // preenche o estado com o que ficou salvo → painel aparece na hora, sem re-abrir pokédex/analyzer
  const acc = `acc${g.slot}`;
  try {
    const prog = store.getProgress(acc) || {};
    if (prog.analyzer) g.state.analyzer = prog.analyzer;
    if (prog.profession) g.state.profession = prog.profession;
    if (prog.mail) g.state.mail = prog.mail;
    for (const id of store.getCaught(acc)) g.state.caughtSpecies.add(id);   // pokédex acumulada no disco
  } catch {}
}
function createGame(slot) {
  const view2 = new WebContentsView({
    webPreferences: { partition: `persist:acc${slot}`, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const g = { view: view2, slot, state: gp.newState(), recent: [], startTs: Date.now(), leaderLevelStart: null, _lastPush: 0 };
  seedFromCache(g);   // mostra o último analyzer/profissão/pokédex antes mesmo do login
  attachTokenRestore(g);   // "lembrar login": restaura o token salvo antes do jogo pedir login
  attachCapture(g);   // antes do load, pra pegar o WS desde o começo
  // assim que a página carrega: injeta o declutter da UI + (com folga pro token) puxa o snapshot REST
  g.view.webContents.on('did-finish-load', () => { injectGameUX(g); injectGameHelpers(g); setTimeout(() => pollServer(g).catch(() => {}), 3500); });
  g.view.webContents.loadURL(GAME_URL).catch((e) => console.error('[coletor] loadURL', slot, e && e.message));
  win.contentView.addChildView(g.view);   // única vez — layout() não re-adiciona (roubaria o foco)
  g.view.setVisible(false); g._shown = false;
  games.push(g);
  return g;
}
function addGame() {
  if (games.length >= MAXV) return activeSlots();
  const slot = nextFreeSlot(); if (!slot) return activeSlots();
  createGame(slot); if (selectedSlot == null) selectedSlot = slot;
  persistSlots(); layout(); send(dashView, 'accounts', activeSlots());
  return activeSlots();
}
function removeGame(slot) {
  const i = games.findIndex((g) => g.slot === slot);
  if (i < 0) return activeSlots();
  const g = games[i];
  try { g.view.webContents.debugger.detach(); } catch {}
  try { win.contentView.removeChildView(g.view); } catch {}
  try { if (typeof g.view.webContents.close === 'function') g.view.webContents.close(); } catch {}
  games.splice(i, 1);
  if (selectedSlot === slot) selectedSlot = games[0] ? games[0].slot : null;
  persistSlots(); layout(); send(dashView, 'accounts', activeSlots());
  return activeSlots();
}

// ---------------- overlay ----------------
function toggleOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) { overlayWin.close(); overlayWin = null; return false; }
  overlayWin = new BrowserWindow({
    width: 300, height: 190, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; });
  games.forEach((g) => pushState(g));
  return true;
}

// ---------------- IPC ----------------
ipcMain.handle('addView', () => addGame());
ipcMain.handle('removeView', (_e, slot) => removeGame(slot));
// ⚠️ FOCO: os 3 handlers abaixo são NO-OP quando nada mudou — o painel re-manda o estado da
// UI em todo render (a cada 'state'), e um layout() redundante roubava o foco do jogo.
ipcMain.handle('selectAccount', (_e, slot) => { if (slot === selectedSlot) return selectedSlot; selectedSlot = slot; layout(); return selectedSlot; });
ipcMain.handle('setGameMode', (_e, m) => { const nm = m === 'single' ? 'single' : 'grid'; if (nm === gameMode) return gameMode; gameMode = nm; layout(); return gameMode; });
ipcMain.handle('setView', (_e, v, slot) => {
  const nv = (v === 'game') ? 'game' : (v === 'detail' ? 'detail' : 'accounts');
  const ns = slot != null ? slot : selectedSlot;
  if (nv === view && ns === selectedSlot) return view;
  view = nv; selectedSlot = ns; layout(); return view;
});
ipcMain.handle('setAccountName', (_e, slot, name) => {
  const s = store.getSettings(); const names = Object.assign({}, s.accountNames || {});
  if (name && name.trim()) names[String(slot)] = name.trim().slice(0, 20); else delete names[String(slot)];
  store.setSettings({ accountNames: names });
  games.forEach((g) => pushState(g)); send(dashView, 'accounts', activeSlots());
  return names;
});
ipcMain.handle('reloadGame', (_e, slot) => { const g = games.find((x) => x.slot === slot); if (g) g.view.webContents.reload(); });
ipcMain.handle('viewsInfo', () => games.map((g) => ({ slot: g.slot, name: getName(g.slot), url: g.view.webContents.getURL() })));
ipcMain.handle('snapshotAll', () => { games.forEach((g) => pushState(g)); return activeSlots(); });
// pull REST autoritativo SOB DEMANDA (clique do usuário no "Atualizar") — nunca em timer
ipcMain.handle('refreshServer', async (_e, slot) => {
  const list = slot != null ? games.filter((g) => g.slot === slot) : games;
  await Promise.all(list.map((g) => pollServer(g).catch(() => {})));
  return true;
});
ipcMain.handle('getEvents', () => store.readEvents(5000).map((e) => e.accountName ? e : Object.assign({ accountName: getName(Number((e.account || '').replace('acc', ''))) }, e)));
ipcMain.handle('getCreatures', () => creatures);
ipcMain.handle('toggleOverlay', () => toggleOverlay());
ipcMain.handle('winMinimize', () => { if (win) win.minimize(); });
ipcMain.handle('winClose', () => { if (win) win.close(); });
ipcMain.handle('getSettings', () => store.getSettings());
ipcMain.handle('setSettings', (_e, patch) => {
  const s = store.setSettings(patch);
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'gameClean')) games.forEach((g) => injectGameUX(g));   // re-aplica o declutter na hora
  return s;
});
ipcMain.handle('readShot', (_e, p) => store.readShotDataURL(p));
ipcMain.handle('setDiag', (_e, on) => {
  diagOn = !!on; store.setSettings({ diagDump: diagOn });
  if (diagOn && dumpPath) {
    try { fs.writeFileSync(dumpPath, ''); } catch {}
    Object.keys(diagSeen).forEach((k) => delete diagSeen[k]);
    games.forEach((g) => { try { g.view.webContents.reload(); } catch {} });   // recarrega (re-loga pelo cookie) pra capturar o estado inicial: time/líder/pokédex/bolas
  }
  return diagOn;
});
ipcMain.handle('openDumpFolder', () => { try { if (dumpPath && fs.existsSync(dumpPath)) shell.showItemInFolder(dumpPath); else shell.openPath(app.getPath('userData')); } catch {} });
ipcMain.handle('openLanding', () => shell.openExternal(LANDING_URL));

// ---------------- ciclo de vida ----------------
app.whenReady().then(() => {
  // EMPACOTADO (.exe): dados vão pra userData (a pasta do app é read-only no asar). DEV: no projeto (eu inspeciono).
  const dataDir = app.isPackaged ? app.getPath('userData') : __dirname;
  store.init(dataDir);
  dumpPath = path.join(dataDir, 'ws-dump.jsonl');
  diagOn = !!store.getSettings().diagDump;
  tokenDir = path.join(app.getPath('userData'), 'tokens');   // login criptografado fica AQUI (não compartilhado)
  try { fs.mkdirSync(tokenDir, { recursive: true }); } catch {}
  tokenVault = createTokenVault({ tokenDir, safeStorage, serverMode: SERVER_MODE });
  loadItemCatalog();   // catálogo de itens pra Bag (assíncrono, não bloqueia)
  loadCreatures();     // catálogo de espécies pra Pokédex
  win = new BaseWindow({ width: 1320, height: 880, frame: false, show: true, backgroundColor: '#0b0e14', title: 'Poke Idle Launcher' });
  dashView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  dashView.webContents.loadFile(path.join(__dirname, 'app.html'));
  win.contentView.addChildView(dashView);

  const saved = (store.getSettings().activeSlots || [1]).filter((s) => s >= 1 && s <= MAXV);
  (saved.length ? saved : [1]).forEach((slot) => createGame(slot));
  selectedSlot = games[0] ? games[0].slot : null;
  layout();
  dashView.webContents.on('did-finish-load', () => { send(dashView, 'accounts', activeSlots()); games.forEach((g) => pushState(g)); });
  win.on('resize', layout);
  win.on('close', () => games.forEach((g) => { persistCookies(g); saveToken(g); try { g.view.webContents.debugger.detach(); } catch {} }));
  setInterval(() => games.forEach((g) => { persistCookies(g); saveToken(g); }), 10000);   // salva login (cookies + token) a cada 10s
  // heartbeat: se uma conta estava recebendo frames e ficou 60s calada → provavelmente desconectou
  setInterval(() => {
    const now = Date.now();
    games.forEach((g) => {
      if (!g._lastFrameTs) return;   // ainda não logou/coletou → não é desconexão
      g._al = g._al || {};
      if (now - g._lastFrameTs > 60000 && !g._al.disc) { g._al.disc = true; fireAlert(g, 'disconnected', { reason: 'silêncio' }); pushState(g); }
    });
  }, 15000);

  if (SERVER_MODE) {
    const healthFile = path.join(app.getPath('userData'), 'server-health.json');
    const writeHealth = () => {
      const body = {
        ok: true, pid: process.pid, timestamp: new Date().toISOString(), platform: process.platform,
        arch: process.arch, display: process.env.DISPLAY || null, tokenVault: tokenVault.describe(),
        accounts: games.map((g) => ({ slot: g.slot, online: !!g._lastFrameTs, lastFrameAt: g._lastFrameTs || null })),
      };
      try { fs.writeFileSync(healthFile, JSON.stringify(body, null, 2), { mode: 0o600 }); } catch {}
    };
    writeHealth();
    setInterval(writeHealth, 30000);
  }

});
app.on('window-all-closed', () => app.quit());
