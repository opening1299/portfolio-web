import { GOOGLE_CLIENT_ID, DRIVE_SCOPE, PROXY_BASE } from "./config.js";

const sessionKey = "pf_drive_session";
const pendingKey = "pf_google_login";
const redirectUri = new URL("index.html", location.href).href.split(/[?#]/)[0];
let activeSession;
let token = "", expires = 0, pendingRefresh;
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export async function beginLogin() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = crypto.randomUUID();
  sessionStorage.setItem(pendingKey, JSON.stringify({state, verifier}));
  const params = new URLSearchParams({client_id: GOOGLE_CLIENT_ID, redirect_uri: redirectUri,
    response_type: "code", scope: DRIVE_SCOPE, access_type: "offline", prompt: "consent",
    state, code_challenge: challenge, code_challenge_method: "S256"});
  location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + params);
}

async function post(path, session, body) {
  const headers = {"Content-Type": "application/json"};
  if (session) headers.Authorization = "Bearer " + session;
  const response = await fetch(PROXY_BASE + "/auth/" + path, {method: "POST", headers,
    body: JSON.stringify(body || {}), cache: "no-store", signal: AbortSignal.timeout(20000)});
  if (!response.ok) {
    if (response.status === 401 && session === localStorage.getItem(sessionKey)) {
      localStorage.removeItem(sessionKey);
      token = "";
    }
    throw Object.assign(new Error(response.status === 401 ? "다시 로그인해 주세요." : "인증 서버 연결에 실패했습니다."), {status: response.status});
  }
  return response.json();
}

function rememberAccess(data) {
  token = data.access_token;
  expires = Date.now() + (data.expires_in - 60) * 1000;
  return token;
}

export async function restoreSession() {
  localStorage.removeItem("pf_token");
  const params = new URLSearchParams(location.search);
  if (params.has("code") || params.has("error")) {
    history.replaceState(null, "", location.pathname);
    const pending = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
    sessionStorage.removeItem(pendingKey);
    if (!pending || pending.state !== params.get("state") || !params.get("code")) throw new Error("Google 로그인을 다시 시작해 주세요.");
    const data = await post("exchange", null, {code: params.get("code"), verifier: pending.verifier});
    localStorage.setItem(sessionKey, data.session);
    rememberAccess(data);
  }
  activeSession = localStorage.getItem(sessionKey);
  return !!activeSession;
}

export async function driveToken(force = false) {
  const session = localStorage.getItem(sessionKey);
  if (!session || session !== activeSession) throw Object.assign(new Error("다시 로그인해 주세요."), {status: 401});
  if (!force && token && Date.now() < expires) return token;
  if (!pendingRefresh) pendingRefresh = post("token", session).then(data => {
    if (session !== localStorage.getItem(sessionKey)) throw new Error("로그인 상태가 변경되었습니다.");
    return rememberAccess(data);
  }).finally(() => { pendingRefresh = null; });
  return pendingRefresh;
}

export async function logout() {
  const session = localStorage.getItem(sessionKey);
  if (session) await post("logout", session);
  localStorage.removeItem(sessionKey);
  token = "";
}
