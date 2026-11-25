import { beginLogin, restoreSession, driveToken, logout } from "./auth.js";
import { SQLJS_BASE, PROXY_BASE } from "./config.js";
import { EPS, position, isoDate, initCharts, renderCharts } from "./charts.js";

// ── DOM ─────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
// DB/입력함의 문자열은 HTML 문법으로 해석하지 않는다.
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g,
  (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const authView = $("authView"), statusView = $("statusView"), dataView = $("dataView");
const statusMsg = $("statusMsg"), toast = $("toast");

async function driveFetch(url, opts = {}) {
  const headers = Object.assign({}, opts.headers, { Authorization: "Bearer " + await driveToken() });
  let r = await fetch(url, Object.assign({}, opts, { headers }));
  if (r.status === 401) {
    headers.Authorization = "Bearer " + await driveToken(true);
    r = await fetch(url, Object.assign({}, opts, { headers }));
  }
  if (!r.ok && r.status !== 404) {
    const txt = await r.text().catch(() => "");
    const err = new Error(`Drive ${r.status}: ${txt.slice(0, 200)}`);
    err.status = r.status;   // 호출부가 인증 오류(401/403)와 그 외를 구분할 수 있게
    throw err;
  }
  return r;
}

async function listFiles(name) {
  const params = new URLSearchParams({ spaces: "appDataFolder", q: "name='" + name + "' and trashed=false",
    fields: "nextPageToken,files(id,modifiedTime,appProperties)", orderBy: "modifiedTime desc", pageSize: "100" });
  const files = [];
  do {
    const data = await (await driveFetch("https://www.googleapis.com/drive/v3/files?" + params)).json();
    files.push(...data.files);
    if (!data.nextPageToken) break;
    params.set("pageToken", data.nextPageToken);
  } while (true);
  return files;
}

async function findFile(name) {
  return (await listFiles(name))[0] || null;
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

async function createJson(name, record, id) {
  const boundary = "pf" + crypto.randomUUID();
  const meta = { name, parents: ["appDataFolder"], ...(id && {id}) };
  const body = "--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + JSON.stringify(meta)
    + "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + JSON.stringify(record)
    + "\r\n--" + boundary + "--";
  return driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body });
}

let backupRoot = null;
let appliedIds = new Set();
let rejectedIds = new Set();
async function readJson(id) {
  const r = await driveFetch("https://www.googleapis.com/drive/v3/files/" + id + "?alt=media");
  return r.status === 404 ? null : r.json();
}

// ── prices.json (폰 갱신 시세를 Drive에 반영 — inbox와 같은 폰-소유 파일) ──
// portfolio.db 는 데스크톱 단독 작성 유지. 시세는 이 별도 파일로 오버레이/흡수. (ADR-0002)
async function readPrices(name = "portfolio-v2-prices.json") {
  const file = await findFile(name);
  return file && readJson(file.id);
}

async function writePrices(obj) {
  const name = "portfolio-v2-prices.json";
  const file = await findFile(name);
  if (!file) return createJson(name, obj);
  const r = await driveFetch("https://www.googleapis.com/upload/drive/v3/files/" + file.id + "?uploadType=media",
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (!r.ok) throw new Error("시세 파일을 저장할 수 없습니다.");
}

// 연결 기록은 앞 기록이 정해 둔 ID로만 한 번 생성되고 수정되지 않는다(drive_versions.publish).
// 따라서 가장 최근에 생성된 기록이 최신 기록이다. 목록 반영이 늦으면 호출부가 next를 따라 보정한다.
async function newestCommitId() {
  const params = new URLSearchParams({ spaces: "appDataFolder",
    q: "name='portfolio-v2-commit.json' and trashed=false",
    fields: "files(id)", orderBy: "createdTime desc", pageSize: "1" });
  const data = await (await driveFetch("https://www.googleapis.com/drive/v3/files?" + params)).json();
  return data.files?.[0]?.id || null;
}

// ── SQLite (sql.js) ─────────────────────────────────────────
let SQL = null;
async function openDb() {
  if (!SQL) SQL = await initSqlJs({ locateFile: (f) => SQLJS_BASE + f });
  const roots = await listFiles("portfolio-v2-root.json");
  backupRoot = roots[0]?.id || null;
  if (roots.length > 1) {
    const anchor = roots.reduce((a, b) => a.id < b.id ? a : b);
    const slot = (await readJson(anchor.id))?.choice;
    const decision = slot && await readJson(slot);
    backupRoot = decision?.portfolioRoot || anchor.appProperties?.portfolioRoot;
    if (!roots.some(root => root.id === backupRoot)) throw new Error("PC에서 기준 백업을 선택하세요.");
  }
  if (backupRoot) {
    // 시작 기록이 하나면 최신 연결 기록부터 시작 — 처음부터 따라 읽으면 백업 수만큼 순차 호출이 쌓인다.
    // 시작 기록이 여럿이면 연결 기록의 소속을 구분할 수 없어 시작 기록부터 따라 읽는다.
    let fid = (roots.length === 1 && await newestCommitId()) || backupRoot;
    let record = await readJson(fid);
    const seen = new Set();
    while (record) {
      if (seen.has(fid)) throw new Error("백업 연결 기록이 손상되었습니다.");
      seen.add(fid);
      const child = await readJson(record.next);
      if (!child) break;
      if (child.parent !== fid) throw new Error("백업 버전이 일치하지 않습니다.");
      fid = record.next;
      record = child;
    }
    if (record?.db) {
      const bytes = await downloadBytes(record.db);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const hash = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
      if (hash !== record.sha256) throw new Error("백업 파일 검증에 실패했습니다.");
      return new SQL.Database(bytes);
    }
  }
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

// ── 손익 계산 — calculator.py 이식(평균단가법)은 charts.js의 position() 단일 소스 사용 ──

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
let quoteRecords = {};
let fxRecord = null;
let liveFx = null;          // 실시간 USD/KRW, 없으면 DB값 사용
const genId = () => (crypto.randomUUID ? crypto.randomUUID() : "id" + Date.now() + Math.random());

function renderSummary(s) {
  $("summaryCards").innerHTML = `
    <div class="card full">
      <div class="label">총 평가금액</div>
      <div class="value ${cls(s.pnl)}">${won(s.totEval)}</div>
    </div>
    <div class="card">
      <div class="label">평가 수익</div>
      <div class="value ${cls(s.pnl)}">${won(s.pnl)}<br><span style="font-size:14px">${pct(s.rate)}</span></div>
    </div>
    <div class="card">
      <div class="label">총 매입금액</div>
      <div class="value">${won(s.totBuy)}</div>
    </div>
    <div class="card">
      <div class="label">실현수익(누적)</div>
      <div class="value ${cls(s.realized)}">${won(s.realized)}</div>
    </div>
    <div class="card">
      <div class="label">배당금</div>
      <div class="value">${won(s.div)}</div>
    </div>`;
}

function renderHoldings(rows) {
  const tb = $("holdingsTable").querySelector("tbody");
  if (!rows.length) { tb.innerHTML = `<tr><td colspan="6" class="muted">보유 종목이 없습니다.</td></tr>`; return; }
  const fmt = (v, cur) => (cur === "USD" ? "$" + v.toFixed(2) : Math.round(v).toLocaleString("ko-KR"));
  tb.innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td class="num">${(+r.qty).toLocaleString("ko-KR")}</td>
      <td class="num">${fmt(r.avg, r.cur)}</td>
      <td class="num">${fmt(r.cp, r.cur)}</td>
      <td class="num ${cls(r.pnl)}">${won(r.evalKrw)}</td>
      <td class="num ${cls(r.pnl)}">${won(r.pnl)}<br><span class="small">${pct(r.rate)}</span></td>
    </tr>`).join("");
}

function renderPending(items) {
  const box = $("pendingBox");
  if (!items.length) { box.hidden = true; return; }
  box.hidden = false;
  $("pendingCount").textContent = items.length;
  const tk = { BUY: "매수", SELL: "매도", DIVIDEND: "배당", REINVEST: "재투자" };
  const txName = (it) => {
    if (it.stock_id) { const s = dbMeta.stocks.find((x) => x.id === it.stock_id); if (s) return s.name; }
    return it.code || `#${it.stock_id || "?"}`;
  };
  $("pendingList").innerHTML = items.map((it) => {
    if (it.kind === "stock")
      return `<li>📌 종목 추가 · ${escapeHtml(it.name)} (${escapeHtml(it.code)}) · ${escapeHtml(it.tab)}</li>`;
    return `<li>${rejectedIds.has(it.id) ? "입력 오류 · " : ""}${escapeHtml(it.trade_date)} · ${escapeHtml(txName(it))} · <b>${escapeHtml(tk[it.trade_type] || it.trade_type)}</b>
      ${it.quantity ? ` ${escapeHtml(it.quantity)}주` : ""} @ ${(+it.price).toLocaleString("ko-KR")}</li>`;
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

    appliedIds = new Set(JSON.parse(query(db, "SELECT value FROM settings WHERE key=\x27gdrive_inbox_applied\x27")[0]?.value || "[]"));
    const dbStamps = {};
    const dbFxStamp = query(db, "SELECT value FROM settings WHERE key=\x27usd_krw_updated_at\x27")[0]?.value;
    const dbPrices = {};
    for (const p of query(db, "SELECT stock_id, current_price, updated_at FROM prices")) {
      dbPrices[p.stock_id] = +p.current_price;
      dbStamps[p.stock_id] = p.updated_at;
    }

    // 종목별 포지션을 캐시 → 시세 갱신 시 DB 재다운로드 없이 재계산
    const positions = [];
    const txsMap = Object.fromEntries(stocks.map((s) => [s.id, []]));
    for (const tx of query(db, "SELECT stock_id, account_id, trade_date, trade_type, price, quantity, fee FROM transactions ORDER BY trade_date, id"))
      txsMap[tx.stock_id]?.push(tx);
    for (const s of stocks) {
      const txs = txsMap[s.id];
      const pos = position(txs);
      positions.push({ id: s.id, name: s.name, code: s.code, currency: s.currency || "KRW",
        tab: s.tab, crawlUrl: s.crawl_url || "",
        holdings: pos.holdings, avg: pos.avg, purchase: pos.purchase, realized: pos.realized, dividend: pos.dividend });
    }

    // 차트 데이터 — 시세/환율 캐시 + 자산 스냅샷 (구버전 백업엔 테이블이 없을 수 있어 가드)
    const hasTable = (name) =>
      query(db, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]).length > 0;
    rejectedIds = new Set(hasTable("phone_inputs") ? query(db, "SELECT id FROM phone_inputs WHERE outcome=\x27invalid\x27").map(x => x.id) : []);
    const histM = {}, histD = {};
    for (const s of stocks) { histM[s.id] = []; histD[s.id] = []; }
    if (hasTable("price_history"))
      for (const r of query(db, "SELECT stock_id, ym, close FROM price_history ORDER BY ym"))
        (histM[r.stock_id] || []).push([r.ym, +r.close]);
    if (hasTable("price_history_daily"))
      for (const r of query(db, "SELECT stock_id, date, close FROM price_history_daily ORDER BY date"))
        (histD[r.stock_id] || []).push([r.date, +r.close]);
    const fxM = hasTable("fx_history")
      ? query(db, "SELECT ym, rate FROM fx_history ORDER BY ym").map((r) => [r.ym, +r.rate]) : [];
    const fxD = hasTable("fx_history_daily")
      ? query(db, "SELECT date, rate FROM fx_history_daily ORDER BY date").map((r) => [r.date, +r.rate]) : [];
    const snapshots = hasTable("daily_snapshot")
      ? query(db, "SELECT date, total_purchase, total_eval, total_realized FROM daily_snapshot ORDER BY date") : [];
    const chart = {
      stocks: stocks.map((s) => ({ id: s.id, currency: s.currency || "KRW" })),
      txsMap, histM, histD, fxM, fxD, snapshots,
    };

    lastData = { positions, dbPrices, dbStamps, dbFxStamp, dbFx, chart };
    quoteRecords = {}; fxRecord = null;
    livePrices = {}; liveFx = null;   // 새 DB 로드 시 라이브 오버레이 초기화
    renderPortfolio();
  } finally {
    db.close();
  }
  const { items } = await readInbox();
  const files = await listFiles("portfolio-v2-input.json");
  for (const file of files) {
    if (!appliedIds.has(file.id) || rejectedIds.has(file.id)) {
      const item = await readJson(file.id);
      if (item) items.push({ ...item, id: file.id });
    }
  }
  pendingItems = items.filter(it => !appliedIds.has(it.id) || rejectedIds.has(it.id));
  renderPending(pendingItems);
  populateAddForm();     // dbMeta + 대기 종목 반영
  showData();

  // 저장된 폰 갱신 시세(prices.json) 오버레이 — 재실행/데스크톱 없이도 값 유지 (ADR-0002)
  const info = $("syncInfo"); if (info) info.textContent = "";
  try {
    const saved = await readPrices() || await readPrices("prices.json");
    if (saved && saved.prices) {
      if (saved.fx?.value > 0 && Date.parse(saved.fx.at) > (Date.parse(lastData.dbFxStamp) || 0)) {
        fxRecord = saved.fx; liveFx = fxRecord.value;
      }
      for (const [id, p] of Object.entries(saved.prices)) {
        const stock = dbMeta.stocks.find(s => String(s.id) === id);
        if (p?.value > 0 && stock?.code === p.code && stock.tab === p.tab
            && Date.parse(p.at) > (Date.parse(lastData.dbStamps[id]) || 0)) {
          quoteRecords[id] = p; livePrices[id] = p.value;
        } else if (Number.isFinite(p) && p > 0 && !lastData.dbPrices[id]) livePrices[id] = p;
      }
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
  // 차트 — 현재 시점은 라이브 시세/환율 오버레이 반영 (없으면 DB값)
  if (lastData.chart)
    renderCharts(lastData.chart, Object.assign({}, dbPrices, livePrices), fx);
}

// ── 실시간 시세 갱신 (프록시 조회 + Drive 오버레이 저장) ──
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
  try {
    await runPriceRefresh(info);
  } finally {
    // 중간에 예외가 나도 플래그/버튼을 반드시 되돌린다 (안 그러면 영구 잠김)
    if (btn) btn.disabled = false;
    syncing = false;
  }
}

async function runPriceRefresh(info) {
  // 환율 먼저 (해외주식 환산 반영)
  try {
    const j = await (await fetch(`${PROXY_BASE}/fx`, { signal: AbortSignal.timeout(25000) })).json();
    if (j && j.usdkrw > 0) { liveFx = j.usdkrw; fxRecord = { value: liveFx, at: new Date().toISOString() }; }
  } catch { /* 실패 시 DB 환율 유지 */ }

  // 보유 종목만 시세 조회 (실현수익은 가격 불필요)
  const held = lastData.positions.filter((p) => p.holdings > EPS);
  const fresh = {};
  let ok = 0, fail = 0;
  await pool(held, 5, async (p) => {
    try {
      // 네이버 금속(금 등) 커스텀 종목: crawl_url 의 /metals/<M코드> 로 판별
      const metal = (p.crawlUrl || "").match(/\/metals\/(M\d+)/);
      const url = metal
        ? `${PROXY_BASE}/price?market=METAL&code=${metal[1]}`
        : `${PROXY_BASE}/price?market=${p.tab === "펀드" ? "FUND" : (p.currency === "USD" ? "USD" : "KRW")}`
          + `&code=${encodeURIComponent(p.code || "")}&name=${encodeURIComponent(p.name || "")}`;
      const j = await (await fetch(url, { signal: AbortSignal.timeout(60000) })).json();
      if (j && j.price > 0) { fresh[p.id] = j.price; quoteRecords[p.id] = { code: p.code, tab: p.tab, value: j.price, at: new Date().toISOString() }; ok++; } else fail++;
    } catch { fail++; }
  });

  // 이번에 실패한 종목은 직전에 받아 둔 값을 유지한다. 통째로 교체하면 prices.json에
  // 저장돼 있던 성공분까지 지워져, 부분 실패마다 폰의 시세 영속(ADR-0002)이 깎인다.
  livePrices = Object.assign({}, livePrices, fresh);
  renderPortfolio();

  // Drive(prices.json)에 반영 — 폰 재실행 시 유지 + 데스크톱이 흡수해 portfolio.db 반영 (ADR-0002)
  try {
    await writePrices({ updated_at: new Date().toISOString(), fx: fxRecord, prices: quoteRecords });
  } catch { /* 기록 실패해도 화면 표시엔 지장 없음 */ }

  const fxTxt = liveFx ? ` · 환율 ${Math.round(liveFx).toLocaleString("ko-KR")}` : "";
  if (info) info.textContent = `${ok}종목 갱신${fail ? ` · ${fail} 실패` : ""}${fxTxt}`;
}

// ── 거래 / 종목 추가 ────────────────────────────────────────
function populateAddForm() {
  const ssel = document.querySelector('#addForm [name=stock_id]');
  const asel = document.querySelector('#addForm [name=account_id]');
  // 기존 종목(id로 참조) + 입력함 대기 종목(code|tab으로 참조)
  const existing = dbMeta.stocks.map((s) => `<option value="id:${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.code)})</option>`);
  const pend = pendingItems.filter((it) => it.kind === "stock").map((it) =>
    `<option value="ct:${encodeURIComponent(it.code)}|${encodeURIComponent(it.tab || "국내주식")}">${escapeHtml(it.name)} (${escapeHtml(it.code)}) · 대기</option>`);
  ssel.innerHTML = existing.concat(pend).join("") || `<option value="">(종목 없음 — 먼저 종목 추가)</option>`;
  asel.innerHTML = dbMeta.accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");
  const dEl = document.querySelector('#addForm [name=trade_date]');
  if (!dEl.value) dEl.value = isoDate(new Date());
}

let inboxWriting = false;
async function pushInbox(item) {
  if (inboxWriting) throw new Error("이전 입력을 저장 중입니다. 잠시 후 다시 시도하세요.");
  inboxWriting = true;
  try {
    if (!backupRoot) throw new Error("먼저 기준 PC에서 새 형식으로 Drive 백업을 실행하세요.");
    const key = "pending-upload-" + backupRoot;
    const {id: unusedId, ts: unusedTime, ...fields} = item;
    let retry = JSON.parse(sessionStorage.getItem(key) || "null");
    if (!retry || JSON.stringify(retry.fields) !== JSON.stringify(fields)) {
      const result = await (await driveFetch("https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=appDataFolder")).json();
      retry = { fields, item: { ...item, id: result.ids[0] } };
      sessionStorage.setItem(key, JSON.stringify(retry));
    }
    try { await createJson("portfolio-v2-input.json", retry.item, retry.item.id); }
    catch (err) { if (err.status !== 409 || !(await readJson(retry.item.id))) throw err; }
    sessionStorage.removeItem(key);
    pendingItems.push(retry.item);
    renderPending(pendingItems);
    populateAddForm();   // 새 대기 종목을 거래 폼에 즉시 반영
  } finally { inboxWriting = false; }
}

async function submitAdd(e) {
  e.preventDefault();
  const f = e.target;
  const sel = f.stock_id.value;   // "id:<id>" 또는 "ct:<code>|<tab>"
  if (!sel) { showToast("먼저 종목을 추가하세요."); return; }
  const item = {
    id: genId(), ts: new Date().toISOString(), kind: "tx",
    account_id: +f.account_id.value,
    account_name: f.account_id.selectedOptions[0]?.textContent,
    fx_rate: f.fx_rate.value ? +f.fx_rate.value : null,
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
    if (item.tab !== "해외주식") item.fx_rate = null;
    if (item.trade_type === "SELL") {
      const transactions = (lastData.chart.txsMap[item.stock_id] || []).concat(
        pendingItems.filter(p => p.kind === "tx" && p.code === item.code && p.tab === item.tab), item);
      let qty = 0;
      for (const tx of transactions.filter(t => t.account_id === item.account_id)
           .sort((a,b) => a.trade_date.localeCompare(b.trade_date))) {
        if (tx.trade_type !== "DIVIDEND") qty += tx.quantity * (tx.trade_type === "SELL" ? -1 : 1);
        if (qty < -1e-8) throw new Error(tx.trade_date + " 계좌 보유수량을 초과합니다.");
      }
    }
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

async function init() {
  try {
    showStatus("로그인 확인 중…");
    if (!await restoreSession()) { showAuth(); return; }
    await loadAll();
  } catch (e) {
    showAuth();
    showToast(e.message);
  }
}

$("signinBtn").addEventListener("click", () => beginLogin().catch(e => showToast(e.message)));
$("refreshBtn").addEventListener("click", () => loadAll().catch((e) => showToast("새로고침 실패: " + e.message)));
$("signoutBtn").addEventListener("click", async () => {
  try { await logout(); showAuth(); showToast("로그아웃되었습니다."); }
  catch (e) { showToast(e.message); }
});
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

window.addEventListener("storage", e => {
  if (e.key === "pf_drive_session" || e.key === null) location.reload();
});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || dataView.hidden) return;
  try { await driveToken(); }
  catch (e) { if (e.status === 401) showAuth(); showToast(e.message); }
});

// 서비스워커 등록 (홈 화면 추가 / 오프라인 셸)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

initCharts();   // 차트 토글 배선
init();         // 자동 로그인 시도
