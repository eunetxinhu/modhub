'use strict';
// Twitch Mod Hub — servidor local leve, sem dependências (Node 18+).
// Faz login na Twitch, conecta no chat (IRC), executa ações de moderação (Helix)
// e abre as lives em um player externo leve (streamlink + VLC/mpv).

const http = require('http');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 17563;
const APP_URL = `http://${HOST}:${PORT}/`;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const SCOPES = [
  'user:read:moderated_channels',
  'user:read:follows',
  'chat:read',
  'chat:edit',
  'moderator:manage:banned_users',
  'moderator:manage:chat_messages',
].join(' ');
const SESSION = crypto.randomBytes(24).toString('hex');
const NO_WINDOW = process.argv.includes('--sem-janela');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Configuração ----------
let config = loadConfig();
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
const loggedIn = () => !!(config.token && config.userId);
function publicState() {
  return {
    configured: !!config.clientId,
    loggedIn: loggedIn(),
    user: loggedIn() ? { id: config.userId, login: config.login, name: config.displayName || config.login } : null,
    irc: irc.ready,
    wanted: [...irc.wanted],
    joined: [...irc.joined],
    watching: [...players.keys()],
    streamlink: !!findStreamlink(),
    // O botão do miner só aparece para quem tem a pasta miner/ (não vai no repositório público).
    miner: fs.existsSync(path.join(__dirname, 'miner')),
  };
}

// ---------- Eventos para a interface (SSE) ----------
const clients = new Set();
function emit(type, data) {
  const s = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(s);
}

// ---------- Autenticação (Device Code Flow, cliente público) ----------
async function postForm(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

let deviceFlow = null;
async function startLogin() {
  if (!config.clientId) throw new Error('Configure o Client ID primeiro.');
  const r = await postForm('https://id.twitch.tv/oauth2/device', { client_id: config.clientId, scopes: SCOPES });
  if (!r.ok) throw new Error(r.data.message || 'Não foi possível iniciar o login (confira o Client ID e se o app é "Público").');
  const { device_code, user_code, verification_uri, interval = 5, expires_in = 1800 } = r.data;
  const flow = {};
  deviceFlow = flow;
  const deadline = Date.now() + expires_in * 1000;
  (async () => {
    let wait = interval * 1000;
    while (deviceFlow === flow && Date.now() < deadline) {
      await sleep(wait);
      if (deviceFlow !== flow) return;
      const t = await postForm(TOKEN_URL, {
        client_id: config.clientId, scopes: SCOPES, device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (t.ok) {
        deviceFlow = null;
        try {
          setTokens(t.data);
          await loadIdentity();
          emit('auth', { ok: true, state: publicState() });
          ircConnect();
        } catch (e) {
          emit('auth', { ok: false, error: e.message });
        }
        return;
      }
      const msg = String(t.data.message || '');
      if (msg.includes('slow_down')) wait += 5000;
      else if (!msg.includes('authorization_pending')) {
        deviceFlow = null;
        emit('auth', { ok: false, error: msg || 'Login recusado.' });
        return;
      }
    }
    if (deviceFlow === flow) { deviceFlow = null; emit('auth', { ok: false, error: 'O código expirou. Tente de novo.' }); }
  })();
  openExternal(verification_uri);
  return { user_code, verification_uri };
}

function setTokens(d) {
  config.token = { access: d.access_token, refresh: d.refresh_token };
  config.tokenScopes = SCOPES;
  saveConfig();
}

async function loadIdentity() {
  const r = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + config.token.access } });
  if (r.status === 401) { await refreshToken(); return loadIdentity(); }
  if (!r.ok) throw new Error('Falha ao validar o login.');
  const v = await r.json();
  config.userId = v.user_id;
  config.login = v.login;
  const u = await helix('GET', '/users?id=' + v.user_id);
  config.displayName = u.data[0]?.display_name || v.login;
  saveConfig();
}

let refreshing = null;
function refreshToken() {
  if (!refreshing) {
    refreshing = (async () => {
      if (!config.token?.refresh) throw new Error('Sessão expirada.');
      const r = await postForm(TOKEN_URL, {
        client_id: config.clientId, grant_type: 'refresh_token', refresh_token: config.token.refresh,
      });
      if (!r.ok) {
        logout(false);
        throw new Error('Sessão expirada. Faça login de novo.');
      }
      setTokens(r.data);
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

function logout(revoke = true) {
  if (revoke && config.token?.access) {
    postForm('https://id.twitch.tv/oauth2/revoke', { client_id: config.clientId, token: config.token.access }).catch(() => {});
  }
  delete config.token; delete config.userId; delete config.login; delete config.displayName;
  saveConfig();
  irc.wanted.clear();
  ircClose();
  emit('auth', { ok: false, loggedOut: true, state: publicState() });
}

// A Twitch pede que apps validem o token a cada hora.
setInterval(() => { if (loggedIn()) loadIdentity().catch(() => {}); }, 55 * 60 * 1000);

// ---------- API Helix ----------
async function helix(method, p, body, retry = true) {
  if (!config.token) throw new Error('Não logado.');
  const headers = { 'Client-Id': config.clientId, Authorization: 'Bearer ' + config.token.access };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch('https://api.twitch.tv/helix' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && retry) { await refreshToken(); return helix(method, p, body, false); }
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok) throw new Error(data.message || `Erro da Twitch (${r.status})`);
  return data;
}

async function helixAll(p) {
  const out = [];
  let after = '';
  do {
    const d = await helix('GET', p + (after ? '&after=' + encodeURIComponent(after) : ''));
    out.push(...d.data);
    after = d.pagination?.cursor || '';
  } while (after);
  return out;
}

// Papéis: own (seu canal), mod, vip (descoberto pelo selo no chat), extra (adicionado na mão).
async function getChannels() {
  const byLogin = new Map();
  const add = (login, id, name, role) => { if (!byLogin.has(login)) byLogin.set(login, { id, login, name, role }); };
  add(config.login, config.userId, config.displayName, 'own');
  for (const c of await helixAll(`/moderation/channels?user_id=${config.userId}&first=100`)) {
    add(c.broadcaster_login, c.broadcaster_id, c.broadcaster_name, 'mod');
  }
  for (const [login, v] of Object.entries(config.vipChannels || {})) add(login, v.id, v.name, 'vip');
  for (const [login, v] of Object.entries(config.extraChannels || {})) add(login, v.id, v.name, 'extra');

  // Completa IDs/nomes que faltam (canais VIP/extras guardados só pelo login).
  const missing = [...byLogin.values()].filter(c => !c.id);
  for (let i = 0; i < missing.length; i += 100) {
    const d = await helix('GET', '/users?' + missing.slice(i, i + 100).map(c => 'login=' + c.login).join('&'));
    for (const u of d.data) {
      const c = byLogin.get(u.login);
      c.id = u.id; c.name = u.display_name;
      const store = c.role === 'vip' ? config.vipChannels : config.extraChannels;
      if (store?.[u.login]) store[u.login] = { id: u.id, name: u.display_name };
    }
  }
  if (missing.length) saveConfig();
  const list = [...byLogin.values()].filter(c => c.id);

  const live = new Map();
  for (let i = 0; i < list.length; i += 100) {
    const q = list.slice(i, i + 100).map(c => 'user_id=' + c.id).join('&');
    const d = await helix('GET', '/streams?first=100&' + q);
    for (const s of d.data) live.set(s.user_id, s);
  }

  // Procura VIP nos canais que você segue e estão ao vivo (entra, olha o selo e sai).
  try {
    for (const s of await helixAll(`/streams/followed?user_id=${config.userId}&first=100`)) {
      if (!byLogin.has(s.user_login)) probeChannel(s.user_login);
    }
  } catch (e) { console.error('Seguidos:', e.message); }

  return list.map(c => {
    const s = live.get(c.id);
    return {
      id: c.id, login: c.login, name: c.name, role: c.role, own: c.role === 'own',
      live: !!s, title: s?.title || '', game: s?.game_name || '', viewers: s?.viewer_count || 0, startedAt: s?.started_at || null,
    };
  });
}

// Gera a lista de canais para o miner (pasta miner/, app separado).
// Ordem = prioridade: ao vivo primeiro, depois mod, VIP e extras. Seu próprio canal não rende pontos.
async function exportToMiner() {
  const dir = path.join(__dirname, 'miner');
  if (!fs.existsSync(dir)) throw new Error('Pasta "miner" não encontrada ao lado do Mod Hub.');
  const rank = { mod: 0, vip: 1, extra: 2 };
  const list = (await getChannels())
    .filter(c => c.role !== 'own')
    .sort((a, b) => (b.live - a.live) || (rank[a.role] - rank[b.role]) || (b.viewers - a.viewers) || a.login.localeCompare(b.login));
  const lines = [
    `# Gerado pelo Twitch Mod Hub em ${new Date().toLocaleString('pt-BR')}. A ordem é a prioridade.`,
    ...list.map(c => c.login),
  ];
  fs.writeFileSync(path.join(dir, 'canais.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ username: config.login }, null, 2));
  return { count: list.length, dir };
}

function addExtraChannel(login) {
  login = String(login).replace(/^@|^https?:\/\/(www\.)?twitch\.tv\//, '').toLowerCase().trim();
  if (!/^[a-z0-9_]{1,25}$/.test(login)) throw new Error('Canal inválido.');
  config.extraChannels = { ...config.extraChannels, [login]: { id: '', name: login } };
  saveConfig();
  return login;
}
function removeExtraChannel(login) {
  if (config.extraChannels) delete config.extraChannels[login];
  saveConfig();
}

const idCache = new Map();
async function userIdByLogin(login) {
  login = String(login).replace(/^@/, '').toLowerCase();
  if (idCache.has(login)) return idCache.get(login);
  const d = await helix('GET', '/users?login=' + encodeURIComponent(login));
  if (!d.data[0]) throw new Error(`Usuário "${login}" não encontrado.`);
  idCache.set(login, d.data[0].id);
  return d.data[0].id;
}

async function moderate(a) {
  const b = encodeURIComponent(a.broadcasterId);
  const m = config.userId;
  const base = `broadcaster_id=${b}&moderator_id=${m}`;
  if (a.action === 'delete') {
    return helix('DELETE', `/moderation/chat?${base}&message_id=${encodeURIComponent(a.messageId)}`);
  }
  const uid = a.userId || await userIdByLogin(a.login);
  const reason = String(a.reason || '').slice(0, 500);
  switch (a.action) {
    case 'timeout': {
      const duration = Math.max(1, Math.min(1209600, Math.round(Number(a.duration) || 600)));
      return helix('POST', `/moderation/bans?${base}`, { data: { user_id: uid, duration, reason } });
    }
    case 'ban':
      return helix('POST', `/moderation/bans?${base}`, { data: { user_id: uid, reason } });
    case 'unban':
      return helix('DELETE', `/moderation/bans?${base}&user_id=${uid}`);
    default:
      throw new Error('Ação desconhecida.');
  }
}

// ---------- Chat (IRC) ----------
const irc = {
  sock: null, buf: '', ready: false, backoff: 1000, wanted: new Set(), joined: new Set(), queue: [], userstate: new Map(),
  probing: new Set(), checked: new Set(), // checagem de VIP: canais em teste agora / já testados nesta sessão
};

function raw(line) { if (irc.sock) irc.sock.write(line + '\r\n'); }

function ircConnect() {
  if (!loggedIn()) return;
  ircClose();
  const sock = tls.connect(6697, 'irc.chat.twitch.tv', { servername: 'irc.chat.twitch.tv' });
  irc.sock = sock;
  irc.buf = '';
  irc.ready = false;
  irc.joined.clear();
  irc.probing.clear();
  irc.checked.clear();
  sock.setEncoding('utf8');
  sock.on('secureConnect', () => {
    raw('CAP REQ :twitch.tv/tags twitch.tv/commands');
    raw('PASS oauth:' + config.token.access);
    raw('NICK ' + config.login);
  });
  sock.on('data', d => {
    irc.buf += d;
    let i;
    while ((i = irc.buf.indexOf('\r\n')) >= 0) {
      const line = irc.buf.slice(0, i);
      irc.buf = irc.buf.slice(i + 2);
      if (line) { try { onLine(line); } catch (e) { console.error('Linha IRC inválida:', e.message); } }
    }
  });
  sock.on('error', e => console.error('IRC:', e.message));
  sock.on('close', () => {
    if (irc.sock !== sock) return;
    irc.sock = null;
    irc.ready = false;
    irc.joined.clear();
    emit('irc', { connected: false });
    setTimeout(() => { if (!irc.sock) ircConnect(); }, irc.backoff);
    irc.backoff = Math.min(irc.backoff * 2, 30000);
  });
}

function ircClose() {
  const s = irc.sock;
  irc.sock = null;
  irc.ready = false;
  irc.joined.clear();
  irc.queue = [];
  if (s) s.destroy();
}

// A Twitch limita entradas em canais (20 a cada 10 s); entramos aos poucos.
setInterval(() => {
  if (irc.ready && irc.queue.length) raw(irc.queue.shift());
}, 600);

function joinChannel(login) {
  login = String(login).toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(login)) throw new Error('Canal inválido.');
  irc.wanted.add(login);
  if (irc.ready && !irc.joined.has(login) && !irc.queue.includes('JOIN #' + login)) irc.queue.push('JOIN #' + login);
  emitChats();
}
function partChannel(login) {
  login = String(login).toLowerCase();
  irc.wanted.delete(login);
  irc.queue = irc.queue.filter(j => j !== 'JOIN #' + login);
  if (irc.joined.has(login)) raw('PART #' + login);
  irc.joined.delete(login);
  emitChats();
}
function emitChats() { emit('chats', { wanted: [...irc.wanted], joined: [...irc.joined] }); }

// Entra só para ler o USERSTATE (que traz o selo de VIP) e sai em seguida.
function probeChannel(login) {
  if (!irc.ready || irc.checked.has(login) || irc.wanted.has(login) || irc.joined.has(login)) return;
  irc.checked.add(login);
  irc.probing.add(login);
  irc.queue.push('JOIN #' + login);
  // Se não vier resposta, sai mesmo assim.
  setTimeout(() => {
    if (irc.probing.delete(login) && !irc.wanted.has(login) && irc.joined.has(login)) raw('PART #' + login);
  }, 60000);
}

function updateVip(channel, badges) {
  const isVip = /(^|,)vip\//.test(badges || '');
  const known = !!config.vipChannels?.[channel];
  if (isVip && !known) {
    config.vipChannels = { ...config.vipChannels, [channel]: { id: '', name: channel } };
    saveConfig();
    emit('vip', { channel, added: true });
  } else if (!isVip && known) {
    delete config.vipChannels[channel];
    saveConfig();
    emit('vip', { channel, added: false });
  }
}

function unescapeTag(v) {
  return v.replace(/\\(.)/g, (_, c) => ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' }[c] ?? c));
}

function parse(line) {
  const tags = {};
  if (line[0] === '@') {
    const sp = line.indexOf(' ');
    for (const kv of line.slice(1, sp).split(';')) {
      const e = kv.indexOf('=');
      if (e < 0) tags[kv] = ''; else tags[kv.slice(0, e)] = unescapeTag(kv.slice(e + 1));
    }
    line = line.slice(sp + 1);
  }
  let prefix = '';
  if (line[0] === ':') {
    const sp = line.indexOf(' ');
    prefix = line.slice(1, sp);
    line = line.slice(sp + 1);
  }
  let trailing = null;
  const t = line.indexOf(' :');
  if (t >= 0) { trailing = line.slice(t + 2); line = line.slice(0, t); }
  const params = line.split(' ').filter(Boolean);
  const command = params.shift();
  if (trailing !== null) params.push(trailing);
  return { tags, prefix, command, params };
}

function chatMessage(t, channel, login, text) {
  let action = false;
  if (text.startsWith('\x01ACTION ') && text.endsWith('\x01')) { action = true; text = text.slice(8, -1); }
  return {
    channel, id: t.id || null, roomId: t['room-id'] || '', userId: t['user-id'] || '', login,
    name: t['display-name'] || login, color: t.color || '', badges: t.badges || '', emotes: t.emotes || '',
    text, action, first: t['first-msg'] === '1', bits: Number(t.bits) || 0, ts: Number(t['tmi-sent-ts']) || Date.now(),
    replyTo: t['reply-parent-display-name'] || '', replyText: t['reply-parent-msg-body'] || '',
  };
}

function onLine(line) {
  const { tags, prefix, command, params } = parse(line);
  const channel = (params[0] || '').replace(/^#/, '');
  const nick = prefix.split('!')[0];
  // Canais em teste de VIP não aparecem na interface.
  const shown = irc.wanted.has(channel);

  switch (command) {
    case 'PING': raw('PONG :' + (params[0] || 'tmi.twitch.tv')); break;
    case '001':
      irc.ready = true;
      irc.backoff = 1000;
      irc.queue = [...irc.wanted].map(c => 'JOIN #' + c);
      emit('irc', { connected: true });
      break;
    case 'RECONNECT': ircConnect(); break;
    case 'JOIN':
      if (nick === config.login) { irc.joined.add(channel); emitChats(); }
      break;
    case 'PART':
      if (nick === config.login) { irc.joined.delete(channel); emitChats(); }
      break;
    case 'PRIVMSG':
      if (shown) emit('msg', chatMessage(tags, channel, nick, params[1] || ''));
      break;
    case 'USERNOTICE':
      if (shown) emit('sys', { channel, kind: tags['msg-id'] || 'notice', text: tags['system-msg'] || '', msg: params[1] || '', ts: Number(tags['tmi-sent-ts']) || Date.now() });
      break;
    case 'CLEARCHAT':
      if (shown) emit('clear', {
        channel, login: params[1] || null, userId: tags['target-user-id'] || null,
        duration: tags['ban-duration'] ? Number(tags['ban-duration']) : null, ts: Number(tags['tmi-sent-ts']) || Date.now(),
      });
      break;
    case 'CLEARMSG':
      if (shown) emit('delmsg', { channel, id: tags['target-msg-id'], login: tags.login || '' });
      break;
    case 'USERSTATE':
      irc.userstate.set(channel, tags);
      updateVip(channel, tags.badges);
      if (irc.probing.delete(channel) && !shown) raw('PART #' + channel);
      break;
    case 'ROOMSTATE':
      emit('room', {
        channel, roomId: tags['room-id'],
        ...('slow' in tags && { slow: Number(tags.slow) }),
        ...('emote-only' in tags && { emoteOnly: tags['emote-only'] === '1' }),
        ...('followers-only' in tags && { followers: Number(tags['followers-only']) }),
        ...('subs-only' in tags && { subs: tags['subs-only'] === '1' }),
      });
      break;
    case 'NOTICE': {
      const text = params[1] || '';
      if (params[0] === '*' && /authentication failed|improperly formatted auth/i.test(text)) {
        refreshToken().then(ircConnect).catch(e => emit('toast', { kind: 'err', text: e.message }));
        return;
      }
      if (shown) emit('sys', { channel, kind: tags['msg-id'] || 'notice', text, ts: Date.now() });
      break;
    }
  }
}

function sendChat(channel, text) {
  channel = String(channel).toLowerCase();
  text = String(text).replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  if (!text) return;
  if (!irc.ready || !irc.joined.has(channel)) throw new Error('Ainda não conectado nesse chat.');
  let out = text;
  if (/^\/me\s/i.test(text)) { out = '\x01ACTION ' + text.slice(4) + '\x01'; }
  raw(`PRIVMSG #${channel} :${out}`);
  // A Twitch não devolve suas próprias mensagens; mostramos localmente.
  const us = irc.userstate.get(channel) || {};
  emit('msg', chatMessage({ ...us, id: '' }, channel, config.login, out));
}

// ---------- Player externo leve (streamlink) ----------
const players = new Map();
let streamlinkPath;
function findStreamlink() {
  if (streamlinkPath !== undefined && streamlinkPath) return streamlinkPath;
  const cands = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Streamlink', 'bin', 'streamlink.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Streamlink', 'bin', 'streamlink.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Streamlink', 'bin', 'streamlink.exe'),
  ];
  streamlinkPath = cands.find(f => fs.existsSync(f)) || whereExe('streamlink') || null;
  return streamlinkPath;
}
function findPlayer() {
  const mpv = whereExe('mpv');
  if (mpv) return mpv;
  const cands = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'VideoLAN', 'VLC', 'vlc.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'VideoLAN', 'VLC', 'vlc.exe'),
  ];
  return cands.find(f => fs.existsSync(f)) || null;
}
function whereExe(name) {
  try {
    return execFileSync('where', [name], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim() || null;
  } catch { return null; }
}

const QUALITY = {
  audio: 'audio_only,worst',
  '160p': '160p,worst',
  '360p': '360p,360p30,worst',
  '480p': '480p,480p30,360p,worst',
  '720p': '720p,720p60,480p,best',
  best: 'best',
};

function watch(channel, quality) {
  channel = String(channel).toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(channel)) throw new Error('Canal inválido.');
  const sl = findStreamlink();
  if (!sl) throw new Error('STREAMLINK_MISSING');
  stopWatch(channel);
  const args = ['--twitch-low-latency', '--title', channel];
  const player = findPlayer();
  if (player) args.push('--player', player);
  args.push('https://www.twitch.tv/' + channel, QUALITY[quality] || QUALITY['360p']);
  const p = spawn(sl, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const keep = d => { log = (log + d).slice(-2000); };
  p.stdout.on('data', keep);
  p.stderr.on('data', keep);
  players.set(channel, p);
  p.on('error', e => emit('toast', { kind: 'err', text: 'Falha ao abrir o player: ' + e.message }));
  p.on('exit', code => {
    if (players.get(channel) !== p) return;
    players.delete(channel);
    emit('watch', { channel, playing: false });
    if (code && !p.killedByUs) {
      const err = (log.match(/error: .*/gi) || []).pop() || `streamlink saiu com código ${code}`;
      emit('toast', { kind: 'err', text: `${channel}: ${err}` });
    }
  });
  emit('watch', { channel, playing: true, quality });
}
function stopWatch(channel) {
  const p = players.get(channel);
  if (!p) return;
  p.killedByUs = true;
  players.delete(channel);
  killTree(p.pid);
  emit('watch', { channel, playing: false });
}
function killTree(pid) {
  try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}

// ---------- Abrir coisas fora do app ----------
function openExternal(url) {
  if (!/^https:\/\/(www\.|dev\.)?twitch\.tv\//.test(url)) return;
  spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
}

function openWindow() {
  if (NO_WINDOW) return;
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const cands = [];
  for (const r of roots) cands.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const r of roots) cands.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  const exe = cands.find(f => fs.existsSync(f));
  if (!exe) {
    spawn('rundll32', ['url.dll,FileProtocolHandler', APP_URL], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  // Janela própria (modo app), com perfil separado e enxuto: sem abas, sem extensões.
  spawn(exe, [
    `--app=${APP_URL}`,
    `--user-data-dir=${path.join(DATA_DIR, 'janela')}`,
    '--window-size=1280,820',
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-component-update',
    '--disable-background-networking', '--renderer-process-limit=1',
  ], { detached: true, stdio: 'ignore' }).unref();
}

// ---------- Servidor HTTP local ----------
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', d => { s += d; if (s.length > 65536) { reject(new Error('Corpo muito grande')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}

let exitTimer = null;
const server = http.createServer(async (req, res) => {
  // Só aceita a própria máquina (protege contra DNS rebinding).
  if (req.headers.host !== `${HOST}:${PORT}` && req.headers.host !== `localhost:${PORT}`) {
    res.writeHead(403); return res.end();
  }
  const url = new URL(req.url, APP_URL);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('__SESSION__', SESSION);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    const asset = /^\/assets\/([a-z0-9-]+\.(png|webp|ico))$/.exec(url.pathname);
    if (req.method === 'GET' && asset) {
      const type = { png: 'image/png', webp: 'image/webp', ico: 'image/x-icon' }[asset[2]];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
      return res.end(fs.readFileSync(path.join(__dirname, 'assets', asset[1])));
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      if (url.searchParams.get('t') !== SESSION) { res.writeHead(403); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify(publicState())}\n\n`);
      clients.add(res);
      clearTimeout(exitTimer);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
        // Fechou a janela? Encerra tudo depois de alguns segundos.
        if (clients.size === 0 && !NO_WINDOW) exitTimer = setTimeout(shutdown, 15000);
      });
      return;
    }
    if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    if (req.headers['x-session'] !== SESSION) return json(res, 403, { error: 'Sessão inválida' });

    const body = req.method === 'POST' ? await readBody(req) : {};
    const needLogin = () => { if (!loggedIn()) throw new Error('Faça login primeiro.'); };

    switch (url.pathname) {
      case '/api/state': return json(res, 200, publicState());
      case '/api/config': {
        const id = String(body.clientId || '').trim();
        if (!/^[a-z0-9]{20,40}$/i.test(id)) throw new Error('Client ID inválido.');
        if (config.clientId !== id) { logout(false); config.clientId = id; saveConfig(); }
        return json(res, 200, publicState());
      }
      case '/api/login': return json(res, 200, await startLogin());
      case '/api/cancel-login': deviceFlow = null; return json(res, 200, {});
      case '/api/logout': logout(true); return json(res, 200, publicState());
      case '/api/channels': needLogin(); return json(res, 200, await getChannels());
      case '/api/join': needLogin(); joinChannel(body.channel); return json(res, 200, {});
      case '/api/part': needLogin(); partChannel(body.channel); return json(res, 200, {});
      case '/api/export-miner': needLogin(); return json(res, 200, await exportToMiner());
      case '/api/add-channel': needLogin(); return json(res, 200, { channel: addExtraChannel(body.channel) });
      case '/api/remove-channel': needLogin(); partChannel(body.channel); removeExtraChannel(String(body.channel)); return json(res, 200, {});
      case '/api/send': needLogin(); sendChat(body.channel, body.text); return json(res, 200, {});
      case '/api/mod': needLogin(); await moderate(body); return json(res, 200, {});
      case '/api/watch': needLogin(); watch(body.channel, body.quality); return json(res, 200, {});
      case '/api/unwatch': stopWatch(String(body.channel || '').toLowerCase()); return json(res, 200, {});
      case '/api/open': openExternal(String(body.url || '')); return json(res, 200, {});
      default: return json(res, 404, { error: 'Rota não encontrada' });
    }
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

function shutdown() {
  for (const ch of [...players.keys()]) stopWatch(ch);
  ircClose();
  process.exit(0);
}
process.on('SIGINT', shutdown);

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    // Já está aberto: só abre a janela de novo.
    openWindow();
    setTimeout(() => process.exit(0), 500);
  } else {
    console.error(e);
    process.exit(1);
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`Twitch Mod Hub rodando em ${APP_URL}`);
  if (config.token && config.tokenScopes !== SCOPES) {
    // Permissões mudaram desde o último login: pede login novo.
    logout(false);
  } else if (loggedIn()) {
    try { await loadIdentity(); ircConnect(); }
    catch (e) { console.error('Login salvo inválido:', e.message); }
  }
  openWindow();
});
