import { GOOGLE_CLIENT_ID, DRIVE_SCOPE, SQLJS_BASE, PROXY_BASE } from "./config.js";

// ── DOM ─────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const authView = $("authView"), statusView = $("statusView"), dataView = $("dataView");
const statusMsg = $("statusMsg"), toast = $("toast");

// ── 인증 (Google Identity Services 토큰 플로) ────────────────
let accessToken = null, tokenClient = null, tokenResolve = null, tokenReject = null;

// 단기(≈1시간) 액세스 토큰을 localStorage에 캐시 → 새로고침/재실행 시 재로그인 회피.
// 리프레시 토큰은 저장하지 않음(브라우저 토큰 플로엔 존재하지 않음).
const TOKEN_KEY = "pf_token";
const TOKEN_SKEW_MS = 60 * 1000;   // 만료 1분 전엔 무효로 간주

function saveToken(resp) {
  if (!resp || !resp.access_token) return;
  accessToken = resp.access_token;
  const ttl = (parseInt(resp.expires_in, 10) || 3600) * 1000;
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ t: accessToken, exp: Date.now() + ttl }));
  } catch { /* 저장 실패는 무시 (세션 토큰으로 동작) */ }
}

function loadCachedToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const { t, exp } = JSON.parse(raw);
    if (t && exp && Date.now() < exp - TOKEN_SKEW_MS) return t;
  } catch { /* 손상된 캐시 무시 */ }
  return null;
}

function clearToken() {
  accessToken = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

function waitForGoogle(timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (window.google && google.accounts) return resolve();
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (window.google && google.accounts) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error("구글 로그인 모듈 로드 실패")); }
    }, 100);
  });
}

function ensureTokenClient() {
  if (tokenClient) return;
  if (!window.google || !google.accounts) throw new Error("구글 로그인 모듈 로딩 중입니다.");
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (resp) => {
      if (resp && resp.access_token) saveToken(resp);
      const r = tokenResolve; tokenResolve = tokenReject = null;
      if (r) r(resp);
    },
    error_callback: (err) => {     // 세션 없음/미동의/팝업 차단 등 → 조용히 실패
      const rj = tokenReject; tokenResolve = tokenReject = null;
      if (rj) rj(err || new Error("로그인 실패"));
    },
  });
}

function requestToken(interactive) {
  return new Promise((resolve, reject) => {
    try {
      ensureTokenClient();
      tokenResolve = resolve; tokenReject = reject;
      // 비대화식('')은 세션이 살아있고 이미 동의했으면 UI 없이 토큰 반환
      tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
    } catch (e) { reject(e); }
  });
}

// ── Drive REST (fetch + Bearer, 401 시 토큰 재요청 1회) ──────
async function driveFetch(url, opts = {}) {
  if (!accessToken) await requestToken(false);
  const headers = Object.assign({}, opts.headers, { Authorization: "Bearer " + accessToken });
  let r = await fetch(url, Object.assign({}, opts, { headers }));
  if (r.status === 401) {
    await requestToken(false);
    headers.Authorization = "Bearer " + accessToken;
    r = await fetch(url, Object.assign({}, opts, { headers }));
  }
  if (!r.ok && r.status !== 404) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Drive ${r.status}: ${txt.slice(0, 200)}`);
  }
  return r;
}

async function findFile(name) {
  const q = encodeURIComponent(`name='${name}'`);
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`;
  const j = await (await driveFetch(url)).json();
  return (j.files && j.files[0]) || null;
}

async function downloadBytes(id) {
  const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  return new Uint8Array(await r.arrayBuffer());
}

async function readInbox() {
  const f = await findFile("inbox.json");
  if (!f) return { fileId: null, items: [] };
  try {
    const j = await (await driveFetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`)).json();
    return { fileId: f.id, items: (j && j.items) || [] };
  } catch { return { fileId: f.id, items: [] }; }
}

async function writeInbox(fileId, items) {
  const body = JSON.stringify({ items });
  if (fileId) {
    await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
  } else {
    const boundary = "pf" + Math.random().toString(16).slice(2);
    const meta = { name: "inbox.json", parents: ["appDataFolder"] };
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart });
  }
}

// ── prices.json (폰 갱신 시세를 Drive에 반영 — inbox와 같은 폰-소유 파일) ──
// portfolio.db 는 데스크톱 단독 작성 유지. 시세는 이 별도 파일로 오버레이/흡수. (ADR-0002)
async function readPrices() {
  const f = await findFile("prices.json");
  if (!f) return null;
  try { return await (await driveFetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`)).json(); }
  catch { return null; }
}

async function writePrices(obj) {
  const f = await findFile("prices.json");
  const body = JSON.stringify(obj);
  if (f) {
    await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${f.id}?uploadType=media`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
  } else {
    const boundary = "pf" + Math.random().toString(16).slice(2);
    const meta = { name: "prices.json", parents: ["appDataFolder"] };
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart });
  }
}

// ── SQLite (sql.js) ─────────────────────────────────────────
let SQL = null;
async function openDb() {
  if (!SQL) SQL = await initSqlJs({ locateFile: (f) => SQLJS_BASE + f });
  const f = await findFile("portfolio.db");
  if (!f) throw new Error("드라이브에 백업(portfolio.db)이 없습니다.\n데스크톱 앱에서 먼저 '구글 드라이브 백업'을 실행하세요.");
  return new SQL.Database(await downloadBytes(f.id));
}

function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

// ── 손익 계산 (calculator.py 이식: 평균단가법) ───────────────
const EPS = 1e-9;
function position(txs) {
  let holdings = 0, avg = 0, realized = 0, dividend = 0;
  for (const tx of txs) {
    const price = +tx.price, qty = +tx.quantity, fee = +tx.fee, t = tx.trade_type;
    if (t === "BUY") {
      const total = holdings * avg + qty * price + fee;
      holdings += qty;
      avg = holdings ? total / holdings : 0;
    } else if (t === "SELL") {
      realized += (price - avg) * qty - fee;
      holdings -= qty;
      if (holdings < EPS) { holdings = 0; avg = 0; }
    } else if (t === "DIVIDEND") {
      const d = price - fee;      // 배당 = 단가(총액) − 수수료
      dividend += d; realized += d;
    }
  }
  return { holdings, avg, purchase: avg * holdings, realized, dividend };
}

// ── 렌더 ────────────────────────────────────────────────────
const won = (v) => "₩" + Math.round(v).toLocaleString("ko-KR");
const pct = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%";
const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
// ISO(UTC) timestamp → "MM/DD HH:mm" KST 표시
const fmtKst = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
};

let dbMeta = { stocks: [], accounts: [] };   // 거래 추가 폼용 캐시
let pendingItems = [];                        // 현재 입력함(inbox) 항목
// DB 로드 결과 캐시(재계산용) + 라이브 시세 오버레이. 시세 갱신 시 DB 재다운로드 없이 재렌더.
let lastData = null;        // { positions:[{id,name,code,currency,holdings,avg,purchase,realized,dividend}], dbPrices, dbFx }
let livePrices = {};        // { stock_id: 실시간가 } — 프록시로 갱신, 없으면 DB값 사용
let liveFx = null;          // 실시간 USD/KRW, 없으면 DB값 사용
const genId = () => (crypto.randomUUID ? crypto.randomUUID() : "id" + Date.now() + Math.random());

function renderSummary(s) {
  $("summaryCards").innerHTML = `
    <div class="card full">
      <div class="label">총 평가액</div>
      <div class="value">${won(s.totEval)}</div>
    </div>
    <div class="card">
      <div class="label">평가손익</div>
      <div class="value ${cls(s.pnl)}">${won(s.pnl)}<br><span style="font-size:14px">${pct(s.rate)}</span></div>
    </div>
    <div class="card">
      <div class="label">총 매입액</div>
      <div class="value">${won(s.totBuy)}</div>
    </div>
    <div class="card">
      <div class="label">실현손익(누적)</div>
      <div class="value ${cls(s.realized)}">${won(s.realized)}</div>
    </div>
    <div class="card">
      <div class="label">배당 합계</div>
      <div class="value">${won(s.div)}</div>
    </div>`;
}

function renderHoldings(rows) {
  const tb = $("holdingsTable").querySelector("tbody");
  if (!rows.length) { tb.innerHTML = `<tr><td colspan="6" class="muted">보유 종목이 없습니다.</td></tr>`; return; }
  const fmt = (v, cur) => (cur === "USD" ? "$" + v.toFixed(2) : Math.round(v).toLocaleString("ko-KR"));
  tb.innerHTML = rows.map((r) => `
    <tr>
      <td>${r.name}</td>
      <td class="num">${(+r.qty).toLocaleString("ko-KR")}</td>
      <td class="num">${fmt(r.avg, r.cur)}</td>
      <td class="num">${fmt(r.cp, r.cur)}</td>
      <td class="num">${won(r.evalKrw)}</td>
      <td class="num ${cls(r.pnl)}">${won(r.pnl)}<br><span class="small">${pct(r.rate)}</span></td>
    </tr>`).join("");
}

function renderPending(items) {
  const box = $("pendingBox");
  if (!items.length) { box.hidden = true; return; }
  box.hidden = false;
  $("pendingCount").textContent = items.length;
  const tk = { BUY: "매수", SELL: "매도", DIVIDEND: "배당" };
  const txName = (it) => {
    if (it.stock_id) { const s = dbMeta.stocks.find((x) => x.id === it.stock_id); if (s) return s.name; }
    return it.code || `#${it.stock_id || "?"}`;
  };
  $("pendingList").innerHTML = items.map((it) => {
    if (it.kind === "stock")
      return `<li>📌 종목 추가 · ${it.name} (${it.code}) · ${it.tab}</li>`;
    return `<li>${it.trade_date} · ${txName(it)} · <b>${tk[it.trade_type] || it.trade_type}</b>
      ${it.quantity ? ` ${it.quantity}주` : ""} @ ${(+it.price).toLocaleString("ko-KR")}</li>`;
  }).join("");
}

// ── 메인 로드 ───────────────────────────────────────────────
async function loadAll() {
  showStatus("불러오는 중…");
  const db = await openDb();
  try {
    const fxRow = query(db, "SELECT value FROM settings WHERE key='usd_krw'")[0];
    const dbFx = fxRow ? parseFloat(fxRow.value) : 1380;
    const stocks = query(db, "SELECT * FROM stocks ORDER BY name");
    const accounts = query(db, "SELECT id, name FROM accounts ORDER BY sort_order, name");
    dbMeta = { stocks, accounts };

    const dbPrices = {};
    for (const p of query(db, "SELECT stock_id, current_price FROM prices")) dbPrices[p.stock_id] = +p.current_price;

    // 종목별 포지션을 캐시 → 시세 갱신 시 DB 재다운로드 없이 재계산
    const positions = [];
    for (const s of stocks) {
      const txs = query(db, "SELECT trade_type, price, quantity, fee FROM transactions WHERE stock_id=? ORDER BY trade_date, id", [s.id]);
      const pos = position(txs);
      positions.push({ id: s.id, name: s.name, code: s.code, currency: s.currency || "KRW",
        crawlUrl: s.crawl_url || "",
        holdings: pos.holdings, avg: pos.avg, purchase: pos.purchase, realized: pos.realized, dividend: pos.dividend });
    }
    lastData = { positions, dbPrices, dbFx };
    livePrices = {}; liveFx = null;   // 새 DB 로드 시 라이브 오버레이 초기화
    renderPortfolio();
  } finally {
    db.close();
  }
  const { items } = await readInbox();
  pendingItems = items;
  renderPending(items);
  populateAddForm();     // dbMeta + 대기 종목 반영
  showData();

  // 저장된 폰 갱신 시세(prices.json) 오버레이 — 재실행/데스크톱 없이도 값 유지 (ADR-0002)
  const info = $("syncInfo"); if (info) info.textContent = "";
  try {
    const saved = await readPrices();
    if (saved && saved.prices) {
      if (saved.usdkrw > 0) liveFx = saved.usdkrw;
      for (const [id, p] of Object.entries(saved.prices)) if (p > 0) livePrices[id] = +p;
      renderPortfolio();
      if (info && saved.updated_at)
        info.textContent = `저장된 시세 · ${fmtKst(saved.updated_at)}`;
    }
  } catch { /* prices.json 없으면 DB값 그대로 */ }
}

// 캐시된 포지션 + (있으면)라이브 시세/환율로 요약·보유표 재렌더. DB 재접근 없음.
function renderPortfolio() {
  if (!lastData) return;
  const { positions, dbPrices, dbFx } = lastData;
  const fx = liveFx ?? dbFx;
  let totEval = 0, totBuy = 0, totRealized = 0, totDiv = 0;
  const rows = [];
  for (const p of positions) {
    const k = (p.currency === "USD") ? fx : 1.0;
    totRealized += p.realized * k;
    totDiv += p.dividend * k;
    if (p.holdings > EPS) {
      const cp = livePrices[p.id] ?? dbPrices[p.id] ?? 0;   // 라이브 우선, 없으면 DB값
      const evalKrw = cp * p.holdings * k;
      const buyKrw = p.purchase * k;
      totEval += evalKrw; totBuy += buyKrw;
      rows.push({ name: p.name, qty: p.holdings, avg: p.avg, cp,
        evalKrw, pnl: evalKrw - buyKrw, rate: buyKrw ? (evalKrw - buyKrw) / buyKrw : 0, cur: p.currency });
    }
  }
  rows.sort((a, b) => b.evalKrw - a.evalKrw);
  renderSummary({ totEval, totBuy, pnl: totEval - totBuy, rate: totBuy ? (totEval - totBuy) / totBuy : 0, realized: totRealized, div: totDiv });
  renderHoldings(rows);
}

// ── 실시간 시세 갱신 (프록시 경유, 표시 전용 — DB/Drive 미기록) ──
// 동시성 제한 풀: items 를 limit 개씩만 병렬로 fn 실행
async function pool(items, limit, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

let syncing = false;
async function refreshPrices() {
  if (!lastData || syncing) return;
  syncing = true;
  const btn = $("syncPriceBtn"), info = $("syncInfo");
  if (btn) btn.disabled = true;
  if (info) info.textContent = "시세 갱신 중…";

  // 환율 먼저 (해외주식 환산 반영)
  try {
    const j = await (await fetch(`${PROXY_BASE}/fx`)).json();
    if (j && j.usdkrw > 0) liveFx = j.usdkrw;
  } catch { /* 실패 시 DB 환율 유지 */ }

  // 보유 종목만 시세 조회 (실현손익은 가격 불필요)
  const held = lastData.positions.filter((p) => p.holdings > EPS);
  const fresh = {};
  let ok = 0, fail = 0;
  await pool(held, 5, async (p) => {
    try {
      // 네이버 금속(금 등) 커스텀 종목: crawl_url 의 /metals/<M코드> 로 판별
      const metal = (p.crawlUrl || "").match(/\/metals\/(M\d+)/);
      const url = metal
        ? `${PROXY_BASE}/price?market=METAL&code=${metal[1]}`
        : `${PROXY_BASE}/price?market=${p.currency === "USD" ? "USD" : "KRW"}`
          + `&code=${encodeURIComponent(p.code || "")}&name=${encodeURIComponent(p.name || "")}`;
      const j = await (await fetch(url)).json();
      if (j && j.price > 0) { fresh[p.id] = j.price; ok++; } else fail++;
    } catch { fail++; }
  });

  livePrices = fresh;        // 실패 종목은 자동으로 DB값으로 폴백(renderPortfolio)
  renderPortfolio();

  // Drive(prices.json)에 반영 — 폰 재실행 시 유지 + 데스크톱이 흡수해 portfolio.db 반영 (ADR-0002)
  try {
    await writePrices({ updated_at: new Date().toISOString(), usdkrw: liveFx || null, prices: fresh });
  } catch { /* 기록 실패해도 화면 표시엔 지장 없음 */ }

  const fxTxt = liveFx ? ` · 환율 ${Math.round(liveFx).toLocaleString("ko-KR")}` : "";
  if (info) info.textContent = `${ok}종목 갱신${fail ? ` · ${fail} 실패` : ""}${fxTxt}`;
  if (btn) btn.disabled = false;
  syncing = false;
}

// ── 거래 / 종목 추가 ────────────────────────────────────────
function populateAddForm() {
  const ssel = document.querySelector('#addForm [name=stock_id]');
  const asel = document.querySelector('#addForm [name=account_id]');
  // 기존 종목(id로 참조) + 입력함 대기 종목(code|tab으로 참조)
  const existing = dbMeta.stocks.map((s) => `<option value="id:${s.id}">${s.name} (${s.code})</option>`);
  const pend = pendingItems.filter((it) => it.kind === "stock").map((it) =>
    `<option value="ct:${encodeURIComponent(it.code)}|${encodeURIComponent(it.tab || "국내주식")}">${it.name} (${it.code}) · 대기</option>`);
  ssel.innerHTML = existing.concat(pend).join("") || `<option value="">(종목 없음 — 먼저 종목 추가)</option>`;
  asel.innerHTML = dbMeta.accounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
  const dEl = document.querySelector('#addForm [name=trade_date]');
  if (!dEl.value) dEl.value = new Date().toISOString().slice(0, 10);
}

async function pushInbox(item) {
  const { fileId, items } = await readInbox();
  items.push(item);
  await writeInbox(fileId, items);
  pendingItems = items;
  renderPending(items);
  populateAddForm();   // 새 대기 종목을 거래 폼에 즉시 반영
}

async function submitAdd(e) {
  e.preventDefault();
  const f = e.target;
  const sel = f.stock_id.value;   // "id:<id>" 또는 "ct:<code>|<tab>"
  if (!sel) { showToast("먼저 종목을 추가하세요."); return; }
  const item = {
    id: genId(), ts: new Date().toISOString(), kind: "tx",
    account_id: +f.account_id.value,
    trade_date: f.trade_date.value,
    trade_type: f.trade_type.value,
    price: +f.price.value || 0,
    quantity: f.trade_type.value === "DIVIDEND" ? 0 : (+f.quantity.value || 0),
    fee: +f.fee.value || 0,
    memo: f.memo.value || "phone",
  };
  if (sel.startsWith("id:")) {
    item.stock_id = +sel.slice(3);
    const s = dbMeta.stocks.find((x) => x.id === item.stock_id);
    if (s) { item.code = s.code; item.tab = s.tab; }   // 참고용
  } else if (sel.startsWith("ct:")) {
    const [c, t] = sel.slice(3).split("|").map(decodeURIComponent);
    item.code = c; item.tab = t;
  }
  try {
    showToast("입력함에 저장 중…");
    await pushInbox(item);
    closeModal();
    showToast("입력함에 추가했습니다. 데스크톱에서 반영됩니다.");
    f.reset();
  } catch (err) { showToast("추가 실패: " + err.message); }
}

async function submitStock(e) {
  e.preventDefault();
  const f = e.target;
  const item = {
    id: genId(), ts: new Date().toISOString(), kind: "stock",
    code: f.code.value.trim(),
    name: f.name.value.trim(),
    tab: f.tab.value,
    category: f.category.value,
  };
  if (!item.code || !item.name) { showToast("코드와 종목명을 입력하세요."); return; }
  try {
    showToast("입력함에 저장 중…");
    await pushInbox(item);
    closeStockModal();
    showToast("종목을 입력함에 추가했습니다.");
    f.reset();
  } catch (err) { showToast("추가 실패: " + err.message); }
}

// ── 화면 전환 / 토스트 ──────────────────────────────────────
function showStatus(msg) { authView.hidden = true; dataView.hidden = true; statusView.hidden = false; statusMsg.textContent = msg; }
function showData() { authView.hidden = true; statusView.hidden = true; dataView.hidden = false; $("refreshBtn").hidden = false; $("signoutBtn").hidden = false; }
function showAuth() { statusView.hidden = true; dataView.hidden = true; authView.hidden = false; $("refreshBtn").hidden = true; $("signoutBtn").hidden = true; }
let toastTimer = null;
function showToast(msg) { toast.textContent = msg; toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toast.hidden = true), 2600); }
function openModal() { $("addModal").hidden = false; }
function closeModal() { $("addModal").hidden = true; }
function openStockModal() { $("stockModal").hidden = false; }
function closeStockModal() { $("stockModal").hidden = true; }

async function signIn() {
  try {
    showStatus("구글 로그인 중…");
    await requestToken(true);
    if (!accessToken) { showAuth(); showToast("로그인이 취소되었습니다."); return; }
    await loadAll();
  } catch (e) {
    showAuth();
    showToast("오류: " + e.message);
  }
}

// 앱 시작 시: 캐시된 토큰이 유효하면 즉시 진입, 아니면 silent 재인증 시도
async function init() {
  const cached = loadCachedToken();
  if (cached) {
    accessToken = cached;
    try {
      await loadAll();   // 유효 토큰으로 바로 진입 (구글 호출 없음)
      return;
    } catch {
      clearToken();      // 만료/무효였으면 캐시 비우고 silent 재시도로 폴백
    }
  }
  try {
    await waitForGoogle();
    showStatus("로그인 확인 중…");
    await requestToken(false);
    if (accessToken) { await loadAll(); return; }
    showAuth();
  } catch (e) {
    showAuth();   // 세션 없음/미동의 → 로그인 버튼 표시
  }
}

// ── 이벤트 ──────────────────────────────────────────────────
$("signinBtn").addEventListener("click", signIn);
$("refreshBtn").addEventListener("click", () => loadAll().catch((e) => showToast("새로고침 실패: " + e.message)));
$("signoutBtn").addEventListener("click", () => { clearToken(); showAuth(); showToast("로그아웃되었습니다."); });
$("syncPriceBtn").addEventListener("click", () => refreshPrices().catch((e) => showToast("시세 갱신 실패: " + e.message)));
$("openAddBtn").addEventListener("click", openModal);
$("cancelAddBtn").addEventListener("click", closeModal);
$("addForm").addEventListener("submit", submitAdd);
$("openStockBtn").addEventListener("click", openStockModal);
$("cancelStockBtn").addEventListener("click", closeStockModal);
$("stockForm").addEventListener("submit", submitStock);
document.querySelector('#addForm [name=trade_type]').addEventListener("change", (e) => {
  const isDiv = e.target.value === "DIVIDEND";
  $("qtyLabel").style.opacity = isDiv ? 0.4 : 1;
  document.querySelector('#addForm [name=quantity]').disabled = isDiv;
  $("priceLabel").firstChild.textContent = isDiv ? "배당총액 " : "단가 ";
});
document.querySelector('#stockForm [name=tab]').addEventListener("change", (e) => {
  $("ccyHint").textContent = e.target.value === "해외주식" ? "통화: USD (해외주식)" : "통화: KRW";
});

// 서비스워커 등록 (홈 화면 추가 / 오프라인 셸)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

init();   // 자동 로그인 시도
