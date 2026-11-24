# 주식 포트폴리오 — 모바일 웹(PWA)

데스크톱 앱이 Google Drive(appDataFolder)에 백업한 `portfolio.db`를 폰 브라우저에서
열람하고, 간단한 거래를 **입력함(inbox.json)** 에 추가하는 정적 웹앱.
브라우저가 Drive API와 sql.js(WASM)로 데이터를 처리하고, Cloudflare Worker가 Google 인증 세션을 관리한다.

## 구조
- `index.html` / `style.css` / `app.js` — 앱 본체
- `charts.js` — 수익 추이(일별 90일/월별/누적)·자산 곡선(드로다운) 차트
  (계산부는 데스크톱 `portfolio/history.py` 로직의 JS 이식, 렌더는 Chart.js CDN)
- `config.js` — 웹 OAuth client_id, 스코프 (secret 없음, 공개 안전)
- `manifest.json` / `sw.js` / `icon.svg` — PWA(홈 화면 추가)

## 동작
1. 구글 로그인(인증 코드 + PKCE) → `drive.appdata` 권한
2. appDataFolder에서 `portfolio.db` 다운로드 → sql.js로 읽어 **보유종목·평가손익 + 수익 요약
   + 수익 추이·자산 곡선 차트** 표시 (차트는 백업 안의 시세 캐시·스냅샷 테이블 사용 —
   비어 있으면 데스크톱에서 조회+백업하라는 안내 표시)
3. "거래 추가" → `inbox.json`에 append (DB는 안 건드림)
4. 데스크톱 앱이 시작/동기화 시 inbox를 흡수해 실제 DB에 반영 (충돌 없음)

## GitHub Pages 배포
1. GitHub에 저장소 생성 (예: `opening1299/portfolio-web`)
2. 이 폴더 내용을 푸시:
   ```
   git init
   git add .
   git commit -m "portfolio PWA"
   git branch -M main
   git remote add origin https://github.com/opening1299/portfolio-web.git
   git push -u origin main
   ```
3. GitHub 저장소 → **Settings → Pages** → Source: `Deploy from a branch`, Branch: `main` / `/(root)` → Save
4. 잠시 후 `https://opening1299.github.io/portfolio-web/` 에서 접속

## OAuth 설정 확인
- Google Cloud(프로젝트 343335437387) → 웹 애플리케이션 OAuth 클라이언트
- 승인된 리디렉션 URI에 `https://opening1299.github.io/portfolio-web/index.html` 등록
- `price-proxy` 디렉터리에서 `npx wrangler secret put GOOGLE_CLIENT_SECRET`으로 해당 웹 클라이언트의 보안 비밀 설정
- `npx wrangler secret put SESSION_ENCRYPTION_KEY`로 안전하게 생성한 32바이트 난수의 Base64 값 설정. 같은 키를 유지해야 기존 세션을 복호화할 수 있다.
- Worker를 먼저 배포해 Durable Object 마이그레이션을 적용한 뒤 웹을 배포한다. 로그인 후 앱 재실행 또는 Drive 토큰 갱신 시 세션 만료일을 6개월 연장한다. 만료일의 월에 해당 날짜가 없으면 그달 말일을 사용한다.

## 주의
- 폰에서의 추가는 **입력함에만** 쌓이고, 실제 반영은 데스크톱 앱이 함 (단일 작성자 = 충돌 방지)
- `portfolio.db`가 Drive에 없으면 먼저 데스크톱에서 "구글 드라이브 백업" 1회 실행
