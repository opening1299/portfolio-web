// 차트 모듈 — 수익 추이(일별/월별/누적) + 자산 곡선(daily_snapshot).
// 계산부는 데스크톱 portfolio/history.py(_totals_at 등)의 JS 이식이며 순수 함수
// (DOM/DB 무관) — test 하니스에서 단독 검증 가능. 렌더부는 Chart.js(CDN) 사용.

export const EPS = 1e-9;

// ── calculator.py 이식: 평균단가법 포지션 (app.js에서도 재사용) ──
export function position(txs) {
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

// ── 순수 계산 (history.py 이식) ─────────────────────────────
// pairs=[[key, value]...] 오름차순에서 key<=k 인 마지막 value (carry-forward)
export function asof(pairs, k) {
  let val = null;
  for (const [pk, v] of pairs) { if (pk <= k) val = v; else break; }
  return val;
}

const pad2 = (n) => String(n).padStart(2, "0");
export const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const monthEndIso = (ym) => isoDate(new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0));

function iterMonths(startYm, endYm) {
  let y = +startYm.slice(0, 4), m = +startYm.slice(5, 7);
  const out = [];
  while (`${y}-${pad2(m)}` <= endYm) {
    out.push(`${y}-${pad2(m)}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// 한 시점의 {profit, pct, purchase, eval} — history._totals_at 이식.
// cd: {stocks:[{id,currency}], txsMap, histM, histD, fxM, fxD}
export function totalsAt(cd, curPrices, curFx, cutoffIso, asofKey, isCur, daily) {
  const hist = daily ? cd.histD : cd.histM;
  const fxHist = daily ? cd.fxD : cd.fxM;
  const fxRate = isCur ? curFx : (asof(fxHist, asofKey) ?? curFx);
  let purchase = 0, profit = 0, evalSum = 0;
  for (const s of cd.stocks) {
    const sub = (cd.txsMap[s.id] || []).filter((t) => (t.trade_date || "").slice(0, 10) <= cutoffIso);
    if (!sub.length) continue;
    const pos = position(sub);
    let px = isCur ? +(curPrices[s.id] || 0) : asof(hist[s.id] || [], asofKey);
    if (!px) px = pos.avg;   // 시세 없음 → 평가손익 0 처리
    const conv = s.currency === "USD" ? fxRate : 1.0;
    const ev = px * pos.holdings;
    purchase += pos.purchase * conv;
    evalSum += ev * conv;
    profit += (pos.realized + (ev - pos.purchase)) * conv;
  }
  return { profit, pct: purchase ? profit / purchase : 0, purchase, eval: evalSum };
}

// 구간 수익(누적 증가분)·구간 수익률 — history._add_period_deltas 이식
export function addPeriodDeltas(result) {
  let prevProfit = 0, prevEval = 0;
  for (const pt of result) {
    pt.period_profit = pt.profit - prevProfit;
    const base = prevEval > EPS ? prevEval : pt.purchase;
    pt.period_pct = base ? pt.period_profit / base : 0;
    prevProfit = pt.profit;
    prevEval = pt.eval;
  }
  return result;
}

function firstTxIso(cd) {
  let min = null;
  for (const txs of Object.values(cd.txsMap))
    for (const t of txs) {
      const d = (t.trade_date || "").slice(0, 10);
      if (d && (!min || d < min)) min = d;
    }
  return min;
}

export function monthlySeries(cd, curPrices, curFx, today = new Date()) {
  const first = firstTxIso(cd);
  if (!first) return [];
  const curYm = monthKey(today);
  const months = iterMonths(first.slice(0, 7), curYm);
  const result = months.map((ym) => {
    const pt = totalsAt(cd, curPrices, curFx, monthEndIso(ym), ym, ym === curYm, false);
    pt.label = ym;
    return pt;
  });
  return addPeriodDeltas(result);
}

export function dailySeries(cd, curPrices, curFx, days = 90, today = new Date()) {
  const first = firstTxIso(cd);
  if (!first) return [];
  const todayIso = isoDate(today);
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1));
  let d = isoDate(start) < first ? new Date(first + "T00:00") : start;
  // 창이 이력 중간에서 시작하면 하루 앞을 기준점으로 계산 후 제거 (첫날 변동폭 왜곡 방지)
  const hasBaseline = isoDate(d) > first;
  if (hasBaseline) d.setDate(d.getDate() - 1);

  const result = [];
  while (isoDate(d) <= todayIso) {
    const iso = isoDate(d);
    const pt = totalsAt(cd, curPrices, curFx, iso, iso, iso === todayIso, true);
    pt.label = iso;
    result.push(pt);
    d.setDate(d.getDate() + 1);
  }
  addPeriodDeltas(result);
  if (hasBaseline) result.shift();
  return result;
}

// 자산 곡선: daily_snapshot rows → [{label, eval, profit}] + 드로다운
export function snapshotSeries(rows) {
  return rows.map((r) => ({
    label: r.date, eval: +r.total_eval,
    profit: +r.total_eval - +r.total_purchase + +r.total_realized,
  }));
}

export function drawdown(values) {
  let peak = 0, cur = 0, max = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) { cur = v / peak - 1; if (cur < max) max = cur; }
  }
  return { cur, max, peak };
}

// ── 렌더 (Chart.js) ─────────────────────────────────────────
const CSS = { up: "#ff5d5d", down: "#4c9bff", accent: "#4c8bf5", muted: "#8b98a5", line: "#2c3744" };
const compact = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });
const wonFull = (v) => "₩" + Math.round(v).toLocaleString("ko-KR");
const pctTxt = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%";

let trendChart = null, assetChart = null;
let trendMode = "day";     // day | month | cum
let assetMode = "eval";    // eval | profit
let lastArgs = null;       // {cd, curPrices, curFx} — 토글 시 재렌더용
const $ = (id) => document.getElementById(id);

function baseOptions(tipLabel) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: tipLabel } } },
    scales: {
      x: { ticks: { color: CSS.muted, maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } },
      y: { ticks: { color: CSS.muted, callback: (v) => compact.format(v) }, grid: { color: CSS.line } },
    },
  };
}

function setHint(hintId, canvasId, msg) {
  const hint = $(hintId), canvas = $(canvasId);
  hint.hidden = !msg;
  canvas.parentElement.classList.toggle("empty", !!msg);
  if (msg) hint.textContent = msg;
  return !!msg;
}

function renderTrend() {
  const { cd, curPrices, curFx } = lastArgs;
  const daily = trendMode === "day";
  const hasHist = Object.values(daily ? cd.histD : cd.histM).some((a) => a.length);
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  if (!hasHist) {
    setHint("trendHint", "trendCanvas", daily
      ? "일별 시세 캐시가 없습니다 — 데스크톱 수익 추이에서 '일별(90일)' 조회 후 구글 드라이브 백업을 실행하세요."
      : "월별 시세 캐시가 없습니다 — 데스크톱 수익 추이(⟳ 시세 새로고침) 후 구글 드라이브 백업을 실행하세요.");
    return;
  }
  setHint("trendHint", "trendCanvas", null);

  const series = daily ? dailySeries(cd, curPrices, curFx)
                       : monthlySeries(cd, curPrices, curFx);
  const isCum = trendMode === "cum";
  const labels = series.map((pt) => daily ? pt.label.slice(5) : pt.label);
  const vals = series.map((pt) => isCum ? pt.profit : pt.period_profit);
  const tip = (c) => {
    const pt = series[c.dataIndex];
    return `${isCum ? "누적" : "구간"} ${wonFull(c.parsed.y)} (${pctTxt(isCum ? pt.pct : pt.period_pct)})`;
  };
  trendChart = new Chart($("trendCanvas"), isCum ? {
    type: "line",
    data: { labels, datasets: [{ data: vals, borderColor: CSS.accent, borderWidth: 2,
      pointRadius: 0, tension: 0.15, fill: false }] },
    options: baseOptions(tip),
  } : {
    type: "bar",
    data: { labels, datasets: [{ data: vals,
      backgroundColor: vals.map((v) => (v >= 0 ? CSS.up : CSS.down)) }] },
    options: baseOptions(tip),
  });
}

function renderAsset() {
  const { cd } = lastArgs;
  if (assetChart) { assetChart.destroy(); assetChart = null; }
  const info = $("assetInfo");
  if (!cd.snapshots.length) {
    info.textContent = "";
    setHint("assetHint", "assetCanvas",
      "자산 스냅샷이 없습니다 — 데스크톱 앱을 켜두면 하루 1회 자동 기록되고, 구글 드라이브 백업 시 여기서도 보입니다.");
    return;
  }
  setHint("assetHint", "assetCanvas", null);

  const series = snapshotSeries(cd.snapshots);
  const key = assetMode;   // eval | profit
  const dd = drawdown(series.map((p) => p.eval));
  info.textContent = `${series[0].label} ~ ${series[series.length - 1].label} · ${series.length}일`
    + ` · 드로다운 현재 ${pctTxt(dd.cur)} / 최대 ${pctTxt(dd.max)}`;

  const tip = (c) => `${assetMode === "eval" ? "평가금액" : "총수익"} ${wonFull(c.parsed.y)}`;
  assetChart = new Chart($("assetCanvas"), {
    type: "line",
    data: { labels: series.map((p) => p.label.slice(5)),
      datasets: [{ data: series.map((p) => p[key]),
        borderColor: assetMode === "eval" ? CSS.accent : "#f59e0b",
        borderWidth: 2, pointRadius: series.length < 45 ? 2.5 : 0, tension: 0.1 }] },
    options: baseOptions(tip),
  });
}

// 세그먼트 토글 배선 — 앱 시작 시 1회 호출
export function initCharts() {
  for (const [segId, setter] of [["trendSeg", (m) => { trendMode = m; renderTrend(); }],
                                 ["assetSeg", (m) => { assetMode = m; renderAsset(); }]]) {
    const seg = $(segId);
    if (!seg) continue;
    seg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn || !lastArgs) return;
      for (const b of seg.querySelectorAll("button")) b.classList.toggle("active", b === btn);
      setter(btn.dataset.mode);
    });
  }
}

// 메인 렌더 — 시세 갱신/DB 재로드 때마다 호출 (현재 시점은 라이브 시세·환율 반영)
export function renderCharts(cd, curPrices, curFx) {
  if (!window.Chart || !cd) return;   // CDN 로드 실패 시 차트만 조용히 생략
  lastArgs = { cd, curPrices, curFx };
  renderTrend();
  renderAsset();
}
