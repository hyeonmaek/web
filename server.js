// TOC(전술작전지휘소) 서버 — 방산 해커톤 T4-1, C2 소프트웨어(무기 제어 아님). 포트 8090.
//
// 역할: NU-87(기지국)이 올린 교전/긴급구호/정정/메시지 보고를 PostgreSQL에 기록하고,
//       명령은 바로 나가지 않고 대기한다. 분대 중 누구든 송신(보고)하면 대기 명령을 전부 내려보낸다:
//       전체 명령은 분대 전체에게(통신 중인 병사 모두 전달로 기록), 개별 명령은 대상 병사에게.
//       NU-87의 /data를 주기적으로 물어 기지국 생존 여부와 연결된 병사(BLUE FORCE) 목록을 만든다.
//
// API
//   POST /report   NU-87 업로드 1건 기록 → 그 병사 앞 대기 명령을 NU-87로 push
//   POST /hello    NU-87이 부팅 후 한 번 보내는 인사(기지국 주소 학습)
//   POST /command  명령 추가(대기) {to, text}  (to: FF=전체 또는 보드 ID)
//   GET  /state    기록판 폴링 {reports, commands, enemies, gateway, units}
//   GET  /         TOC 화면
//
// 설정(환경변수): DATABASE_URL, PORT, GATEWAY_IP(없으면 마지막 보고를 보낸 주소를 기억해 사용)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const Geo = require('./geo');

const PORT = Number(process.env.PORT || 8090);
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://toc:toc@127.0.0.1:5433/toc' });
const VALID_TYPES = ['engagement', 'sos', 'message', 'correction'];
const PEER_ONLINE_MS = 6000;      // 기지국이 이 시간 안에 들은 병사 = 연결됨
const GATEWAY_POLL_MS = 3000;

// ---------------- DB ----------------
async function initDb() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  // 병사별 전달 기록이 생기기 전에 이미 '전달됨'이던 명령은 모든 병사에게 전달된 것으로 본다(옛 명령 재전송 방지)
  if (!(await getSetting('deliveries_migrated'))) {
    await pool.query(`INSERT INTO command_deliveries (command_id, board_id, ts)
                      SELECT c.id, u.board_id, COALESCE(c.delivered_ts, c.ts) FROM commands c, units u
                      WHERE c.delivered ON CONFLICT DO NOTHING`);
    await setSetting('deliveries_migrated', '1');
  }
  await importLegacyJsonOnce();
  const ip = await getSetting('gateway_ip');
  if (process.env.GATEWAY_IP) gateway.ip = process.env.GATEWAY_IP;
  else if (ip) gateway.ip = ip;
}

// 예전 파일 저장(data/*.json)을 한 번만 DB로 옮긴다(옮긴 뒤 파일 이름을 바꿔 재수입 방지).
async function importLegacyJsonOnce() {
  const dir = path.join(__dirname, 'data');
  const rf = path.join(dir, 'reports.json'), cf = path.join(dir, 'commands.json');
  if (fs.existsSync(rf)) {
    for (const r of JSON.parse(fs.readFileSync(rf, 'utf8'))) {
      await pool.query(
        `INSERT INTO reports (type, from_id, lat, lon, bearing, fire, text, msg_id, ts, rx_ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [r.type, r.from, r.lat, r.lon, r.bearing, r.fire, r.text || '', r.msgId, r.ts, r.rxTs || r.ts]);
    }
    fs.renameSync(rf, rf + '.imported');
  }
  if (fs.existsSync(cf)) {
    for (const c of JSON.parse(fs.readFileSync(cf, 'utf8'))) {
      await pool.query(`INSERT INTO commands (to_id, text, ts, delivered, delivered_ts) VALUES ($1,$2,$3,$4,$5)`,
        [c.to, c.text, c.ts, !!c.delivered, c.deliveredTs]);
    }
    fs.renameSync(cf, cf + '.imported');
  }
}

async function getSetting(key) {
  const r = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
}
async function setSetting(key, value) {
  await pool.query(`INSERT INTO settings (key, value) VALUES ($1,$2)
                    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, value]);
}

const rowToReport = (r) => ({
  id: r.id, type: r.type, from: r.from_id, lat: r.lat, lon: r.lon, bearing: r.bearing,
  fire: r.fire, text: r.text, msgId: r.msg_id, ts: Number(r.ts), rxTs: Number(r.rx_ts),
  address: r.address || null, locFrom: r.loc_from || null,
});
const rowToCommand = (c) => ({
  id: c.id, to: c.to_id, text: c.text, ts: Number(c.ts), delivered: c.delivered,
  deliveredTs: c.delivered_ts == null ? null : Number(c.delivered_ts),
});

// UTF-16LE 16진수(NU-87이 대원 메시지를 이렇게 올림) → 문자열
function fromUtf16Hex(h) {
  if (typeof h !== 'string' || !/^([0-9a-fA-F]{4})+$/.test(h)) return '';
  let s = '';
  for (let i = 0; i < h.length; i += 4) s += String.fromCharCode(parseInt(h.substr(i, 2), 16) | (parseInt(h.substr(i + 2, 2), 16) << 8));
  return s;
}

// 폰이 없는 병사의 보고: 블루투스로 서로 들리는 거리(수십 m)에 있는 분대원이 최근 10분 안에 올린 폰 GPS로 근사
async function nearbyFix(fromId) {
  const r = await pool.query(
    `SELECT from_id, lat, lon FROM reports WHERE lat IS NOT NULL AND loc_from IS NULL AND from_id<>$1 AND ts>$2
     ORDER BY ts DESC LIMIT 1`, [fromId, Date.now() - 10 * 60 * 1000]);
  return r.rows[0] || null;
}

async function addReport(obj) {
  const now = Date.now();
  if (typeof obj.lat !== 'number' && typeof obj.from === 'string') {
    const f = await nearbyFix(obj.from.slice(0, 8).toUpperCase());
    if (f) { obj.lat = f.lat; obj.lon = f.lon; obj.locFrom = f.from_id; }
  }
  if (typeof obj.t === 'string' && typeof obj.text !== 'string') obj.text = fromUtf16Hex(obj.t);
  const r = await pool.query(
    `INSERT INTO reports (type, from_id, lat, lon, bearing, fire, text, msg_id, ts, rx_ts, loc_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [VALID_TYPES.includes(obj.type) ? obj.type : 'message',
     typeof obj.from === 'string' ? obj.from.slice(0, 8).toUpperCase() : '??',
     typeof obj.lat === 'number' ? obj.lat : null,
     typeof obj.lon === 'number' ? obj.lon : null,
     typeof obj.bearing === 'number' ? Math.round(((obj.bearing % 360) + 360) % 360) : null,
     obj.fire === 'open' || obj.fire === 'hold' ? obj.fire : null,
     typeof obj.text === 'string' ? obj.text.slice(0, 400) : '',
     typeof obj.msgId === 'number' ? obj.msgId : null,
     typeof obj.ts === 'number' ? obj.ts : now, now, obj.locFrom || null]);
  return rowToReport(r.rows[0]);
}

async function addCommand(obj) {
  const to = typeof obj.to === 'string' && obj.to.trim() ? obj.to.trim().slice(0, 2).toUpperCase() : 'FF';
  const r = await pool.query(`INSERT INTO commands (to_id, text, ts) VALUES ($1,$2,$3) RETURNING *`,
    [to, typeof obj.text === 'string' ? obj.text.slice(0, 200) : '', Date.now()]);
  return rowToCommand(r.rows[0]);
}

// 병사(boardId)가 송신했을 때 내려보낼 명령: 아직 안 나간 명령 전부(전체 + 모든 병사 앞 개별).
// 전체 명령은 분대 전체에 방송하므로 지금 통신 중인 병사 모두(+보고자)를 전달로 기록한다.
async function takeCommandsFor(boardId) {
  const now = Date.now();
  const r = await pool.query(`SELECT * FROM commands WHERE delivered=FALSE ORDER BY id`);
  const live = gateway.peers.filter((p) => p.online).map((p) => p.id);
  for (const c of r.rows) {
    const who = c.to_id === 'FF' ? [...new Set([boardId, ...live])] : [c.to_id];
    for (const b of who)
      await pool.query('INSERT INTO command_deliveries (command_id, board_id, ts) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [c.id, b, now]);
    await pool.query('UPDATE commands SET delivered=TRUE, delivered_ts=$1 WHERE id=$2', [now, c.id]);
  }
  const cmds = r.rows.map(rowToCommand);
  // 받는 쪽별로 묶는다: { FF: [...], AD: [...], FA: [...] }
  const groups = {};
  for (const c of cmds) (groups[c.to] ||= []).push(c);
  return groups;
}


// ---------------- 좌표 → 주소 ----------------
// 행정구역은 OpenStreetMap Nominatim, 도로명은 Overpass로 가장 가까운 이름 있는 도로를 찾는다(둘 다 키 불필요).
// 공개 서버 예의상 1초에 1건씩만, 결과는 DB(geocache)에 저장해 같은 칸은 다시 묻지 않는다.
const UA = 'squad-c2-demo/1.0';
function httpsJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: body ? 'POST' : 'GET',
      headers: { 'User-Agent': UA, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('응답 해석 실패')); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('시간 초과')));
    if (body) req.write(body);
    req.end();
  });
}

async function lookupAddress(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const hit = await pool.query('SELECT address FROM geocache WHERE key=$1', [key]);
  if (hit.rows[0]) return hit.rows[0].address;

  const nom = await httpsJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=ko&zoom=18`);
  const a = nom.address || {};
  const area = [a.city || a.province || a.state, a.borough || a.city_district || a.county, a.quarter || a.suburb || a.town || a.village]
    .filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(' ');
  let road = a.road ? (a.road + (a.house_number ? ' ' + a.house_number : '')) : null;
  if (!road) {
    const q = `[out:json][timeout:10];way(around:200,${lat},${lon})[highway][name];out tags geom 30;`;
    const ov = await httpsJson('https://overpass-api.de/api/interpreter', 'data=' + encodeURIComponent(q));
    let best = null;
    for (const e of ov.elements || []) {
      for (const g of e.geometry || []) {
        const d = Math.hypot((g.lat - lat) * 111000, (g.lon - lon) * 111000 * Math.cos(lat * Math.PI / 180));
        if (!best || d < best.d) best = { d, name: e.tags.name };
      }
    }
    if (best) road = `${best.name} 인근`;
  }
  const address = [area, road].filter(Boolean).join(' · ') || nom.display_name || '주소 없음';
  await pool.query('INSERT INTO geocache (key, address) VALUES ($1,$2) ON CONFLICT DO NOTHING', [key, address]);
  return address;
}

// 주소 찾기 대기열(1초 간격). 실패하면 다음 기회에 다시.
const geoQueue = [];
let geoBusy = false;
function queueAddress(id, lat, lon) { geoQueue.push({ id, lat, lon }); runGeoQueue(); }
async function runGeoQueue() {
  if (geoBusy) return;
  geoBusy = true;
  while (geoQueue.length) {
    const j = geoQueue.shift();
    try {
      const addr = await lookupAddress(j.lat, j.lon);
      await pool.query('UPDATE reports SET address=$1 WHERE id=$2', [addr, j.id]);
    } catch (e) { console.log('  주소 찾기 실패:', e.message); }
    await new Promise((r) => setTimeout(r, 1100));
  }
  geoBusy = false;
}

// ---------------- 기지국(NU-87) ----------------
// online: 마지막 /data 응답 성공 여부. peers: 기지국이 듣고 있는 병사들.
const gateway = { ip: null, online: false, lastOk: null, peers: [] };

function toUtf16Hex(text) {
  let h = '';
  for (const ch of String(text || '')) {
    let code = ch.codePointAt(0);
    if (code > 0xFFFF) code = 0x3F;
    h += (code & 0xFF).toString(16).padStart(2, '0');
    h += ((code >> 8) & 0xFF).toString(16).padStart(2, '0');
  }
  return h;
}

// 명령을 NU-87 /msg?to=&t=<UTF-16LE hex>로 밀어 그 병사에게 방송.
// 기지국은 메시지를 한 번에 하나만 방송하므로 여러 건이면 ' / '로 이어 한 통으로(최대 66글자).
function pushCommandsToGateway(boardId, cmds) {
  if (!gateway.ip || !cmds.length) return;
  console.log(`  → ${boardId === 'FF' ? '전체' : boardId} 방송: ${cmds.map((c) => c.text).join(' / ')}`);
  const text = [...cmds.map((c) => c.text).join(' / ')].slice(0, 66).join('');
  const url = `http://${gateway.ip}/msg?to=${boardId}&t=${toUtf16Hex(text)}`;
  const r = http.get(url, (resp) => resp.resume());
  r.on('error', (e) => console.log('  FRAGO push 실패:', e.message));
  r.setTimeout(3000, () => r.destroy());
}

function pollGateway() {
  if (!gateway.ip) return;
  const r = http.get(`http://${gateway.ip}/data`, (resp) => {
    let buf = '';
    resp.on('data', (c) => (buf += c));
    resp.on('end', () => {
      try {
        const d = JSON.parse(buf);
        gateway.online = true;
        gateway.lastOk = Date.now();
        gateway.peers = (d.peers || []).map((p) => ({
          id: String(p.id).toUpperCase(), rssi: p.rssi, battery: p.battery, event: p.event,
          age: p.age, online: p.age < PEER_ONLINE_MS,
        }));
      } catch (e) { gateway.online = false; }
    });
  });
  r.on('error', () => { gateway.online = false; });
  r.setTimeout(1500, () => { gateway.online = false; r.destroy(); });
}

// ---------------- HTTP ----------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),   // NU-87의 단순 HTTP 클라이언트용
    'Connection': 'close',
  });
  res.end(body);
}

function buildPage() {
  const html = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
  const geo = fs.readFileSync(path.join(__dirname, 'geo.js'), 'utf8');
  return html.replace('/*__GEO__*/', geo);
}

const server = http.createServer(async (req, res) => {
  const pathName = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'POST' && pathName === '/report') {
      let obj;
      try { obj = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { ok: false }); }
      const r = await addReport(obj);
      if (r.lat != null && r.lon != null) queueAddress(r.id, r.lat, r.lon);
      const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
      const loopback = ip === '::1' || ip.startsWith('127.');   // 이 맥에서 보낸 시험 요청은 기지국 주소로 배우지 않음
      if (!process.env.GATEWAY_IP && ip && !loopback && ip !== gateway.ip) {
        gateway.ip = ip;
        await setSetting('gateway_ip', ip);
        pollGateway();
      }
      const groups = /^[0-9A-F]{2}$/.test(r.from) ? await takeCommandsFor(r.from) : {};
      const n = Object.values(groups).reduce((a, g) => a + g.length, 0);
      console.log(`[REPORT #${r.id}] ${r.type} from ${r.from}${r.text ? ` "${r.text}"` : ''} → 대기 명령 ${n}건 하달 (${gateway.ip})`);
      // 기지국은 한 번에 한 통만 방송하므로 받는 쪽별로 4초 간격(단말이 한 통을 다 받는 시간). 전체 먼저.
      const order = Object.keys(groups).sort((a, b) => (a === 'FF' ? -1 : b === 'FF' ? 1 : 0));
      order.forEach((to, i) => setTimeout(() => pushCommandsToGateway(to, groups[to]), i * 4000));
      return sendJson(res, 200, { ok: true, id: r.id });
    }

    // NU-87이 켜져 와이파이에 붙으면 한 번 보내는 인사 → 기지국 주소를 배워 상태 확인 시작
    if (req.method === 'POST' && pathName === '/hello') {
      await readBody(req);
      const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
      if (!process.env.GATEWAY_IP && ip && ip !== '::1' && !ip.startsWith('127.')) {
        gateway.ip = ip;
        await setSetting('gateway_ip', ip);
        pollGateway();
      }
      console.log(`[HELLO] 기지국 ${ip}`);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathName === '/command') {
      let obj;
      try { obj = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { ok: false }); }
      const c = await addCommand(obj);
      // 바로 보내지 않는다. 대상 병사가 다음에 송신(보고)할 때 그 병사에게 전달된다.
      console.log(`[명령 #${c.id}] to=${c.to} "${c.text}" → 대기(병사 송신 때 전달)`);
      return sendJson(res, 200, { ok: true, command: c });
    }

    if (req.method === 'GET' && pathName === '/state') {
      const [rep, cmd, units, dels] = await Promise.all([
        pool.query('SELECT * FROM reports ORDER BY id'),
        pool.query('SELECT * FROM commands ORDER BY id'),
        pool.query('SELECT * FROM units ORDER BY callsign'),
        pool.query('SELECT command_id, board_id FROM command_deliveries ORDER BY ts'),
      ]);
      const deliveredTo = {};
      for (const d of dels.rows) (deliveredTo[d.command_id] ||= []).push(d.board_id);
      const reports = rep.rows.map(rowToReport);
      const enemies = Geo.enemyEstimates(reports.filter((r) => r.type === 'engagement' || r.type === 'correction'));
      return sendJson(res, 200, {
        reports, commands: cmd.rows.map((c) => ({ ...rowToCommand(c), deliveredTo: deliveredTo[c.id] || [] })), enemies,
        units: units.rows.map((u) => ({ id: u.board_id, callsign: u.callsign })),
        gateway: {
          known: !!gateway.ip, online: gateway.online, lastOk: gateway.lastOk,
          peers: gateway.online ? gateway.peers : [],
        },
        now: Date.now(),
      });
    }

    if (req.method === 'GET' && (pathName === '/' || pathName === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(buildPage());
    }
    sendJson(res, 404, { ok: false });
  } catch (e) {
    console.error('처리 오류:', e.message);
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

initDb().then(async () => {
  // 주소가 아직 없는 예전 보고도 채운다
  const old = await pool.query('SELECT id, lat, lon FROM reports WHERE lat IS NOT NULL AND address IS NULL ORDER BY id');
  for (const r of old.rows) queueAddress(r.id, r.lat, r.lon);
  setInterval(pollGateway, GATEWAY_POLL_MS);
  pollGateway();
  server.listen(PORT, () => console.log(`TOC 서버: http://localhost:${PORT}  (DB 연결됨, 기지국 ${gateway.ip || '미확인'})`));
}).catch((e) => {
  console.error('DB 연결 실패 — server 폴더에서 `docker compose up -d` 먼저 실행:', e.message);
  process.exit(1);
});
