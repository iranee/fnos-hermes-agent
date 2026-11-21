import * as http from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable, pipeline } from "node:stream";
import { WebSocket } from "./vendor/ws/wrapper.mjs";

const CONNECT_TIMEOUT = 5_000;
// 单帧上限与下行 WebSocketServer 默认值一致：pet.info 的精灵图、长会话恢复都是数 MB 的单帧，
// 原先 1 MB 会让上游连接直接断开，客户端重连后再拉一次又断，表现为 Gateway 持续掉线。
const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
// 积压上限只计算新消息到达前已排队/未发出的字节，单条大帧本身不触发。
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_MESSAGES = 64;
// 面板注入的界面补丁文件：由面板同源提供，上游 CSP 的 script-src/style-src 'self' 允许加载，
// 页面 HTML 超过此大小时放弃注入，原样转发。
const PATCH_ROUTE = "/__fnos/";
const PATCH_FILES = {
  "patch.js": "text/javascript; charset=utf-8",
  "patch.css": "text/css; charset=utf-8",
};
const MAX_PATCHED_HTML_BYTES = 2 * 1024 * 1024;
const SLASH_ASSET_ROUTE = "/__fnos/slash-v1/assets/";
const SLASH_BUNDLE = "/assets/main-D3KmuCvf.js";
const SLASH_BUNDLE_BYTES = 3402236;
const SLASH_BUNDLE_SHA256 = "84d66985d0d66d579e8a69c363b1120022603ee0ea2e6bce74ffa55cb45f9969";

const CONNECTIONS_BUNDLE = "/assets/connections-DtSejob0.js";
const CONNECTIONS_BUNDLE_BYTES = 162533;
const CONNECTIONS_BUNDLE_SHA256 = "a3d110d969dba14a22c810c49a2a709484f8e80cbd8c886ae8fd5da528df20e9";

// scope 是官方 draftKey（fresh 为 __new__:<uuid>，不是 target 的 tile:<id>）。
// fresh 与官方 create 的捕获点同源；已有 session 只信 owner resolver。
// registry 端点不依赖前台连接；legacy 才绑定当前端点。永不持久化 token。
function draftOwnerHelpers(owner, connection, profile, fresh, newRoute, newProfile, normalize, registry) {
  return `
function fnosDraftOwner(scope) {
  const conn=${connection}.get(), isFresh=${fresh}(scope);
  const route=isFresh?${newRoute}():${owner}(scope);
  if(route && typeof route==='object' && route.connectionId && route.profile) {
    const entry=${registry}.get()?.connections?.find(entry=>entry.id===route.connectionId);
    // Never journal an unknown endpoint fingerprint: it cannot safely match after load.
    if(!entry?.kind)return null;
    const endpoint=Object.fromEntries(['kind','url','host','user','port','remoteHermesPath','remoteProfile','authMode']
      .map(key=>[key,entry[key]??null]));
    return {connectionId:route.connectionId,profile:route.profile,targetProfile:route.targetProfile??route.profile,endpoint};
  }
  // A named profile on the local source deliberately has no object route.
  // Only its explicit captured profile is an owner; ambient profile is not evidence.
  const p=isFresh?${newProfile}.get():route;
  if(typeof p!=='string' || !p.trim() || !conn?.baseUrl) return null;
  return {connectionId:null,profile:p,targetProfile:p,baseUrl:conn.baseUrl,mode:conn.mode??null};
}
function fnosSameOwner(a,b) { return !!a && !!b && JSON.stringify(a)===JSON.stringify(b); }
function fnosOwnsRetry(scope,retry) {
  return retry?.fnosProtected!==1 || fnosSameOwner(retry.fnosOwner,fnosDraftOwner(scope));
}
`;
}

const DRAFT_MAIN_HELPERS = draftOwnerHelpers("m_", "Kt", "oy", "Mn", "qv", "iy", "Uv", "ud") + `
function fnosDraftReady(scope,locale) {
  if(Foe.fnosProtectedNamespace===1 && fnosDraftOwner(scope))return true;
  Hs({id:'fnos-draft-not-ready',kind:'warning',persistent:true,message:String(locale).startsWith('zh')?
    '尚未发送，正文和附件仍在输入框。请等待会话归属及安全草稿存储就绪后再次发送。':
    'Not sent. Text and attachments remain in the composer. Wait for session ownership and safe draft storage, then send again.'});
  return false;
}
function fnosDraftPersisted(scope,retry,locale) {
  let ok=false;
  try {
    const key=scope??er(),draft=le(key);
    const disk=JSON.parse(window.localStorage.getItem('hermes:composer-drafts:v4')??'null');
    const saved=JSON.parse(window.localStorage.getItem('hermes:composer-draft-retry:v1:'+key)??'null');
    ok=draft.text===retry.text && JSON.stringify(draft.attachments)===JSON.stringify(retry.attachments) &&
      disk?.drafts?.[key]?.text===retry.text && JSON.stringify(saved)===JSON.stringify(retry);
  } catch {}
  if(!ok)fnosDraftNotice(locale,false);
  return ok;
}
function fnosDraftEmpty(scope) {
  try {
    const key=scope??er(),draft=le(key),disk=JSON.parse(window.localStorage.getItem('hermes:composer-drafts:v4')??'null');
    return !draft.text.length && !draft.attachments.length && !disk?.drafts?.[key]?.text?.length;
  } catch {return false;}
}
function fnosDraftComplete(attempt,stash,locale) {
  const {scope,retry,stable,journal,baseline}=attempt;
  try {
    if(stable() && fnosSameOwner(retry.fnosOwner,fnosDraftOwner(scope))) {
      if(!iht(scope,retry.text,retry.attachments))return true;
      if(fnosDraftOccupied(scope,null,baseline)) {
        // New intent already replaced the stash: do not clear it. An unchanged old stash
        // behind an unflushed live editor still needs landed verification after reload.
        if(!fnosDraftUnchanged(scope,baseline))return true;
      } else {stash(scope,'',[]);if(fnosDraftEmpty(scope))return true;}
    }
  } catch {}
  journal.defer();fnosDraftNotice(locale,journal.durable());return false;
}
function fnosDraftAck(attempt,stash,locale,queue=false) {
  const diskText=()=>JSON.parse(window.localStorage.getItem('hermes:composer-drafts:v4')??'null')?.drafts?.[attempt.scope]?.text??'';
  const stable=attempt.stable() && fnosSameOwner(attempt.retry.fnosOwner,fnosDraftOwner(attempt.scope));
  // A synchronously cleared queue with no remaining copy needs only the original
  // pre-clear journal write. Never take this shortcut for a remounted old body.
  try {if(queue && stable && !Kc(attempt.retry,diskText()) && !Kc(attempt.retry,le(attempt.scope).text) &&
    ![...fnosLiveDrafts].some(live=>live.scope()===attempt.scope && Kc(attempt.retry,live.text()))) {
    if(attempt.journal.retire()===false)fnosDraftNotice(locale,false);return;
  }}catch{}
  let superseded=false,clean=false;
  try {superseded=fnosDraftSuperseded(attempt.scope,attempt.retry,diskText());}catch{}
  const durable=attempt.journal.accept(superseded);
  // An ACK belongs to the intent, not to the component that originally queued it.
  // Reconcile a copied, unedited composer before considering the stash complete.
  if(stable && !superseded)for(const live of fnosLiveDrafts) {
    try {if(live.scope()===attempt.scope)live.accepted?.(attempt.retry);}catch{fnosDraftNotice(locale,durable);}
  }
  const complete=superseded?stable:fnosDraftComplete(attempt,stash,locale);
  // 内存新稿不代表落盘成功，旧磁盘正文仍需保留 ACK 凭据直到安全清理。
  try {clean=superseded||!Kc(attempt.retry,diskText());}catch{}
  if(complete&&clean) {
    if(attempt.journal.retire()===false)fnosDraftNotice(locale,false);
  } else {attempt.journal.defer();if(complete||!durable)fnosDraftNotice(locale,durable);}
}
function fnosQueueBusy(scope) {
  return [...fnosQueueFlights].some(attempt=>attempt.scope===scope && fnosSameOwner(attempt.retry.fnosOwner,fnosDraftOwner(scope)));
}
function fnosDraftStart(scope,text,files,id,locale) {
  if(!fnosDraftReady(scope,locale))return null;
  const owner=fnosDraftOwner(scope),conn={...Kt.get()},profile=oy.get();
  const retry={...ll(id??kc(),text,files),attachments:structuredClone(files),fnosProtected:1,fnosOwner:owner,
    fnosIntent:fnosDraftIdentity(scope,owner,true).id};
  let journal;
  try {journal=Foe(scope,retry);if(journal?.durable?.()!==true)throw Error('Draft not durable');}
  catch {journal?.defer?.();fnosDraftNotice(locale,false);return null;}
  return {scope,retry,journal,baseline:iht(scope,text,files)?{at:Gn(scope),draft:le(scope),version:fnosDraftVersions.get(scope)??0}:null,
    stable:()=>['baseUrl','token','connectionId','mode','authMode'].every(key=>conn[key]===Kt.get()?.[key]) && profile===oy.get()};
}
var fnosLiveDrafts=new Set,fnosDraftVersions=new Map,fnosQueueFlights=new Set,fnosDraftIntents=new Map,fnosDraftInternalDepth=0;
function fnosDraftInternal(change) {
  fnosDraftInternalDepth++;
  try {return change();}finally{fnosDraftInternalDepth--;}
}
function fnosDraftIdentity(scope,owner,create=false) {
  const key=JSON.stringify([scope??er(),owner]);
  if(create&&!fnosDraftIntents.has(key))fnosDraftIntents.set(key,{id:kc()});
  return fnosDraftIntents.get(key);
}
function fnosDraftEdited(scope,text) {
  const owner=fnosDraftOwner(scope);if(!owner)return;
  // Kept outside the hook: hydration/unmount and same-text saves cannot erase intent.
  fnosDraftIntents.set(JSON.stringify([scope??er(),owner]),{id:kc(),text});
}
function fnosDraftSuperseded(scope,retry,diskText) {
  const intent=fnosDraftIdentity(scope,retry.fnosOwner);
  // Disk equality alone is not evidence: an unflushed delete/retype can equal the
  // old save baseline. Conversely, a different unflushed body cannot bless old disk text.
  return !!(retry.fnosIntent && intent && intent.id!==retry.fnosIntent &&
    intent.text===diskText && le(scope).text===diskText);
}
function fnosDraftUnchanged(scope,baseline) {
  return !!baseline && baseline.version===(fnosDraftVersions.get(scope)??0) &&
    baseline.at===Gn(scope) && JSON.stringify(le(scope))===JSON.stringify(baseline.draft);
}
function fnosLiveText(ref,editor) {
  if(ref.current.length)return true;
  if(!editor)return false;
  const text=Qy(editor);
  return text.length>0 && !(text==='\\n' && editor.textContent==='');
}
function fnosDraftOccupied(scope,except,baseline) {
  const saved=le(scope);
  const unchanged=fnosDraftUnchanged(scope,baseline);
  return !!((!unchanged && (saved.text.length || saved.attachments.length)) ||
    [...fnosLiveDrafts].some(live=>live!==except && live.scope()===scope && live.busy()));
}
function fnosDraftNotice(locale,durable=true,preview=false) {
  const zh=String(locale).startsWith('zh');
  Hs({id:preview?'fnos-draft-preview':'fnos-draft-preserved',kind:'warning',persistent:true,
    message:preview?(zh?'附件信息已保留；页面刷新后临时预览可能失效，请发送前检查附件。':
      'Attachment metadata is retained. Temporary previews may expire after reload; check attachments before sending.'):
    durable?(zh?'未覆盖当前草稿。先前发送的内容已保留，回到原会话的空白输入框时可恢复；不会自动发送。':
      'Your current draft was not replaced. The earlier send is retained for a later empty draft in its original chat; it will not be sent automatically.'):
    (zh?'未覆盖当前草稿，但本地备份未能确认。请勿关闭或刷新此页面。':
      'Your current draft was not replaced, but its local backup could not be confirmed. Do not close or reload this page.')});
}
function fnosRetryFiles(retry,locale) {
  if(!Array.isArray(retry?.attachments)) return null;
  const files=structuredClone(retry.attachments);
  if(files.some(file=>Object.values(file).some(value=>typeof value==='string' && value.startsWith('blob:'))))
    fnosDraftNotice(locale,true,true);
  return files;
}
`;

function draftMainReplacements() {
  return [
    ["function aht(", DRAFT_MAIN_HELPERS + "function aht("],
    ["k=_i(),{t:A}=K(),j=A.desktop,M=", "k=_i(),{t:A,locale:fnosLocale}=K(),j=A.desktop,M="],
    [
      "let a=r?.storedSessionId??(Mn(s.current)?null:s.current),o=a,c=t??[],l,u=a===null?{onComposerScopeAssigned:e=>{o=e,l?.move(e)}}:{},d=r?.submission_id??kc();l=n?void 0:Foe(a,ll(d,e,c));let f=i?()=>i(o,d):n?()=>{}:()=>{w(o,e,c),T?.(o,ll(d,e,c)),(Mn(s.current)?null:s.current)===o&&m(e,c)};new Promise(i=>i(v(e,{...r,submission_id:d,...t?{attachments:t}:{},composerScope:a,...u,...n?{displayKind:n}:{}}))).then(t=>{t===!1?f():iht(a,e,c)&&w(a,``,[])}).catch(f).finally(()=>l?.retire())",
      `const a=r?.storedSessionId??(Mn(s.current)?null:s.current);
      const attempt=fnosAttempt??fnosTake()??fnosDraftStart(r?.storedSessionId??sRef(),e,t??[],r?.submission_id,fnosLocale);
      if(!attempt)return false;
      let o=attempt.scope,c=attempt.retry.attachments,l=attempt.journal,keep=false,assigned=false;
      const {retry,stable}=attempt,owner=retry.fnosOwner,d=retry.id;
      let baseline=attempt.baseline;
      const u=a===null?{onComposerScopeAssigned:next=>{
        if(!assigned && stable() && fnosSameOwner(owner,fnosDraftOwner(next))) {
          assigned=true;if(l?.move(next)!==false){o=next;baseline=null;}
        }
      }}:{};
      const f=i?()=>{keep=true;l.defer();i(o,d)}:n?()=>{}:()=>{
        // A failed restore must never reach finally's retire, even if a store/UI call throws.
        keep=true;
        const live=(s.current??er())===o;
        if(!stable() || !fnosSameOwner(owner,fnosDraftOwner(o,O)) ||
          fnosDraftOccupied(o,null,baseline) || (live && (cRef() || O.attachments.$attachments.get().length))) {
          l?.defer?.();fnosDraftNotice(fnosLocale,l?.durable?.()??false);return;
        }
        try {w(o,retry.text,c);if(live)fnosDraftInternal(()=>m(retry.text,c));T?.(o,retry);
          keep=!fnosDraftPersisted(o,retry,fnosLocale);
        } catch {fnosDraftNotice(fnosLocale,false);}
        finally {if(keep)l?.defer?.();}
      };
      const cRef=()=>fnosReadLive();
      new Promise(resolve=>resolve(v(e,{...r,submission_id:d,...t?{attachments:t}:{},composerScope:a,...u,...n?{displayKind:n}:{}})))
        .then(accepted=>{if(accepted===false)f();else keep=!fnosDraftComplete({...attempt,scope:o,baseline},w,fnosLocale);})
        .catch(f).finally(()=>{if(!keep)l?.retire();})`,
    ],
    // Every destructive entry prepares BEFORE clearing; dispatch takes that exact lease/id.
    ["queueCurrentDraft:y,queueEdit:b", "queueCurrentDraft:fnosQueue,queueEdit:b"],
    ["clearDraft:a,disabled:o", "clearDraft:fnosClear,disabled:o"],
    ["O.attachments.clear({retainPreviewUrls:!0}),M(i,e", "fnosDraftInternal(()=>O.attachments.clear({retainPreviewUrls:!0})),M(i,e"],
    ["j=A.desktop,M=(e,t,n,r,i)=>{", `j=A.desktop,a=()=>fnosDraftInternal(fnosClear),fnosPending=null,sRef=()=>s.current??er(),
      fnosTake=()=>{const attempt=fnosPending;fnosPending=null;return attempt},
      fnosBegin=(text,files,id)=>fnosQueueBusy(sRef())?null:fnosPending??(fnosPending=fnosDraftStart(sRef(),text,files,id??E?.(text,files,true)?.id,fnosLocale)),
      fnosEnd=()=>fnosTake()?.journal.retire(),
      fnosReadLive=()=>fnosLiveText(c,u.current),
      fnosRecover=attempt=>{
        const {scope,retry,journal,stable,baseline}=attempt;
        journal.defer();
        if(!stable() || !fnosSameOwner(retry.fnosOwner,fnosDraftOwner(scope)) ||
          fnosDraftOccupied(scope,null,baseline) || (sRef()===scope && (fnosReadLive() || O.attachments.$attachments.get().length))) {
          fnosDraftNotice(fnosLocale,journal.durable());return;
        }
        try {w(scope,retry.text,retry.attachments);if(sRef()===scope)fnosDraftInternal(()=>m(retry.text,retry.attachments));T?.(scope,retry);
          if(fnosDraftPersisted(scope,retry,fnosLocale))journal.retire();
        } catch {fnosDraftNotice(fnosLocale,false);}
      },
      y=id=>{if(fnosQueueBusy(sRef()))return false;
        const attempt=fnosTake()??fnosDraftStart(sRef(),c.current,jQ(n),id,fnosLocale);if(!attempt)return false;
        fnosQueueFlights.add(attempt);
        const live=[...fnosLiveDrafts].find(live=>live.ref===c),revision=live?.revision(),unchanged=()=>attempt.stable() &&
          fnosSameOwner(attempt.retry.fnosOwner,fnosDraftOwner(attempt.scope)) && revision===live?.revision();
        const failed=()=>{attempt.journal.defer();if(unchanged() && sRef()===attempt.scope &&
          c.current===attempt.retry.text && (!u.current || Qy(u.current)===c.current))T?.(attempt.scope,attempt.retry);
          fnosDraftNotice(fnosLocale,attempt.journal.durable());return false;};
        return new Promise(resolve=>resolve(fnosQueue(attempt.retry.id,unchanged))).then(accepted=>{
          if(accepted!==true)return failed();
          fnosDraftAck(attempt,w,fnosLocale,true);return true;
        }).catch(failed).finally(()=>fnosQueueFlights.delete(attempt))},
      M=(e,t,n,r,i,fnosAttempt)=>{`],
    ["if(z(i))return;let f=R(i,s)", "if(z(i))return;if(s&&!fnosBegin(i,jQ(n)))return;try{let f=R(i,s)"],
    ["M(i,e,void 0,t&&{submission_id:t.id})}F(e)},V=", "M(i,e,void 0,t&&{submission_id:t.id})}F(e)}finally{fnosEnd()}},V="],
    ["I=e=>{let t=s.current;Promise.resolve(y(e.id)).then(n=>{n||T?.(t,e)})}", "I=e=>y(e.id)"],
    ["L=(0,Z.useCallback)(n=>{let a=i.current;", "L=(0,Z.useCallback)((n,fnosUnchanged=()=>true)=>{let a=i.current;"],
    ["O.current===e&&i.current===a&&(r(),h.attachments.removeOccurrences(t))", "O.current===e&&i.current===a&&fnosUnchanged()&&fnosDraftInternal(()=>{r();h.attachments.removeOccurrences(t)})"],
    ["o=!n.length&&qt.test(e.trim()),c=s.current;if(i", "o=!n.length&&qt.test(e.trim()),c=s.current,fnosAnswer=fnosPending;if(i"],
    ["ooe(S??``,e.trim(),()=>{w(c,e,[]),s.current===c&&m(e,[])})", "ooe(S??``,e.trim(),()=>fnosRecover(fnosAnswer),()=>fnosDraftAck(fnosAnswer,w,fnosLocale))"],
    ["GQ(S),a(),`answered`", "GQ(S),(fnosAnswer.journal.awaitAck()||fnosDraftNotice(fnosLocale,false)),a(),fnosTake(),`answered`"],
    ["V=(r=`interrupt`)=>{let i=c.current.trim()", `V=(r=\`interrupt\`)=>{
      if(u.current){const text=Qy(u.current);if(text!==c.current){c.current=text;C(text)}}
      if(!fnosBegin(c.current,jQ(n)))return;try{let i=c.current.trim()`],
    ["H(`submit`),a();let l=t.current", "const fnosSteer=fnosTake();H(`submit`),a();let l=t.current"],
    ["storedSessionId:e}):Vc(e,{text:s.displayText,attachments:[]", "storedSessionId:e,submission_id:fnosSteer.retry.id},void 0,fnosSteer):Vc(e,{id:fnosSteer.retry.id,text:s.displayText,attachments:[]"],
    ["(m(s.displayText,[]),w(l,s.displayText,[]))", "fnosRecover(fnosSteer)"],
    ["Promise.resolve().then(()=>g(s.transportText,r)).then(e=>{e||f()}).catch(f)};return", `Promise.resolve().then(()=>g(s.transportText,r)).then(accepted=>{
      if(accepted===true)fnosDraftAck(fnosSteer,w,fnosLocale);else {fnosSteer.journal.defer();f()}
    },()=>{fnosSteer.journal.defer();f()})}finally{fnosEnd()}};return`],
    ["let e=P(),t=E?.(c.current,jQ(n));t?I(t):y(),F(e)", `if(u.current){const text=Qy(u.current);if(text!==c.current){c.current=text;C(text)}}
      if(!fnosBegin(c.current,jQ(n)))return;try{let e=P(),t=E?.(c.current,jQ(n));t?I(t):y(),F(e)}finally{fnosEnd()}`],
    ["let a=li(),o=oAe(),s=imt()", `const fnosLocale=K().locale,fnosIntent=(0,Z.useRef)(0),fnosRetryRevision=(0,Z.useRef)(undefined),fnosLive=(0,Z.useRef)({mounted:false}),fnosObserved=(0,Z.useRef)(null);
      const fnosBump=(text=b.current)=>{
        fnosIntent.current++;fnosObserved.current=null;
        if(fnosLive.current.mounted && !fnosDraftInternalDepth)fnosDraftEdited(T.current??er(),text);
      };let a=li(),o=oAe(),s=imt()`],
    ["(e,t=!0,n=!1)=>{b.current=e,v(e)", "(e,t=!0,n=!1)=>{fnosBump(e);b.current=e,v(e)"],
    ["()=>{v(``),b.current=``", "()=>{fnosBump('');v(``),b.current=``"],
    ["if(!t)return b.current;zye(t);let n=yl(Qy(t));", "if(!t)return b.current;zye(t);let n=yl(Qy(t));if(n!==b.current)fnosBump(n);"],
    ["return r!==null&&(b.current=r,v(r),n&&P(),!0)", "return r!==null&&(fnosBump(r),b.current=r,v(r),n&&P(),!0)"],
    ["_.observed(e),b.current=e;let t=y.current", "_.observed(e),e!==b.current&&fnosBump(e),b.current=e;let t=y.current"],
    ["{attachments:u,target:d}=Hi(),f=si", "fnosPane=Hi(),{attachments:u,target:d}=fnosPane,f=si"],
    ["R(e,T.current)&&(x.current=t)", "R(e,T.current)&&(x.current=t,fnosRetryRevision.current=fnosIntent.current)"],
    ["H=(e,t)=>{let n=Moe(x.current,e,t);return x.current=void 0", "H=(e,t,peek=false)=>{let n=fnosRetryRevision.current===fnosIntent.current&&fnosOwnsRetry(T.current??er(),x.current)?Moe(x.current,e,t):void 0;if(peek)return n;return x.current=void 0"],
    ["x.current=woe(r,o,a),U(o,a,!0),", "x.current=woe(r,o,a),fnosDraftInternal(()=>U(o,a,!0)),fnosRetryRevision.current=fnosIntent.current,"],
    ["U(t.text,t.attachments)},oe=", "fnosDraftInternal(()=>U(t.text,t.attachments)),fnosRetryRevision.current=fnosIntent.current},oe="],
    // A successful recovery supersedes any already scheduled save of the cleared draft.
    ["R(e,T.current)&&(O.current=e$(t,n)),Ge(e,t,n)",
      "R(e,T.current)&&(window.clearTimeout(C.current),S.current=null,O.current=e$(t,n)),fnosDraftVersions.set(e??er(),(fnosDraftVersions.get(e??er())??0)+1),Ge(e,t,n)"],
    ["let R=(e,t)=>(Mn(e)||!e?null:e)===(Mn(t)||!t?null:t)",
      `fnosLive.current.scope=()=>T.current??er();
      fnosLive.current.ref=b;fnosLive.current.revision=()=>fnosIntent.current;
      fnosLive.current.text=()=>y.current?Qy(y.current):b.current;
      fnosLive.current.busy=()=>fnosLiveText(b,y.current)||u.$attachments.get().length;
      (0,Z.useLayoutEffect)(()=>{
        const live=fnosLive.current,editor=y.current,events=['beforeinput','input','paste','cut','drop'];
        live.mounted=true;fnosLiveDrafts.add(live);
        let files=JSON.stringify(u.$attachments.get());
        const off=u.$attachments.listen(next=>{const value=JSON.stringify(next);if(value!==files){files=value;fnosBump(live.text())}});
        const observe=()=>{if(!live.mounted||!editor)return;const text=Qy(editor);
          if(text!==(fnosObserved.current??b.current))fnosBump(text);fnosObserved.current=text;};
        // 原生 input 同步记录中间删写，粘贴回调后的微任务只记录实际 DOM 变化。
        const changed=()=>{observe();queueMicrotask(observe)};
        for(const event of events)editor?.addEventListener?.(event,changed,true);
        return()=>{live.mounted=false;fnosBump();off();for(const event of events)editor?.removeEventListener?.(event,changed,true);fnosLiveDrafts.delete(live)};
      },[u]);
      let R=(e,t)=>(e??er())===(t??er())`],
    ["T.current=e;let r=fl(e),{attachments:a,text:o}=le(e);O.current=e$(o,a)",
      `T.current=e;let r=fl(e),{attachments:a,text:o}=le(e);
      if(r?.fnosProtected===1 && !fnosOwnsRetry(e??er(),r)) {
        // Keep the disk copies untouched; a same-named foreign session is not a recovery destination.
        if(Kc(r,o)){o='';a=[];fnosDraftNotice(fnosLocale);}r=undefined;
      }
      if(r?.fnosProtected===1 && Kc(r,o) && !a.length) {
        const full=fnosRetryFiles(r,fnosLocale);if(full){a=full;Ge(e,o,a);}
      }
      const fnosLoadedAt=Gn(e);
      O.current=e$(o,a)`],
    ["(Lc(e,x.current),t$(r));let s=t=>", "(Lc(e,x.current),t$(r));const fnosLoadedRevision=fnosIntent.current;let s=t=>"],
    ["T.current===e&&n?.id===t.id&&Moe(n,te(),u.$attachments.get())&&(z(e,``,[]),Lc(e,void 0),x.current=void 0,U(``,[]))",
      `if(T.current!==e || !fnosOwnsRetry(e??er(),t) || fnosRetryRevision.current!==fnosIntent.current || n?.id!==t.id || !Moe(n,te(),u.$attachments.get()))return false;
      z(e,'',[]);Lc(e,void 0);x.current=void 0;fnosDraftInternal(()=>U('',[]));return fnosDraftEmpty(e)`],
    ["c={offer:t=>T.current!==e||te().trim()||u.$attachments.get().length>0?!1:(z(e,t.text,[]),V(e,{...t,attachmentIds:[]}),U(t.text,[]),t$(t),!0),landed:s,withdraw:s}",
      `c={fnosFullRetry:1,accepted:t=>{
        if(T.current!==e || !fnosOwnsRetry(e??er(),t))return false;
        const saved=le(e);
        try {if(fnosDraftSuperseded(e??er(),t,JSON.parse(window.localStorage.getItem('hermes:composer-drafts:v4')??'null')?.drafts?.[e??er()]?.text??''))return true;}catch{return false;}
        if(!Kc(t,saved.text) || (saved.attachments.length && !Moe(t,saved.text,saved.attachments))) {
          try {return !Kc(t,JSON.parse(window.localStorage.getItem('hermes:composer-drafts:v4')??'null')?.drafts?.[e??er()]?.text??'');}catch{return false;}
        }
        if(!fnosLive.current.mounted || fnosIntent.current!==fnosLoadedRevision || Gn(e)!==fnosLoadedAt ||
          !Kc(t,te()) || (u.$attachments.get().length && !Moe(t,te(),u.$attachments.get())) || [...fnosLiveDrafts].some(live=>live!==fnosLive.current && live.scope()===(e??er()) && live.busy()))return false;
        z(e,'',[]);if(x.current?.id===t.id){Lc(e,void 0);x.current=void 0;}fnosDraftInternal(()=>U('',[]));return fnosDraftEmpty(e);
      },offer:t=>{
        if(!fnosLive.current.mounted || fnosIntent.current!==fnosLoadedRevision ||
          T.current!==e || fnosLiveText(b,y.current) || u.$attachments.get().length ||
          !fnosOwnsRetry(e??er(),t) || fnosDraftOccupied(e??er(),fnosLive.current))return false;
        const files=fnosRetryFiles(t,fnosLocale);
        try {z(e,t.text,files??[]);fnosDraftInternal(()=>U(t.text,files??[]));V(e,files?t:{...t,attachmentIds:[]});
          if(!files)t$(t);
          return t.fnosProtected!==1 || fnosDraftPersisted(e,t,fnosLocale);
        } catch {fnosDraftNotice(fnosLocale,false);return false;}
      },landed:s,withdraw:s}`],
    ["adopt:t=>T.current!==e||!Kc(t,te())||Gu(u.$attachments.get()).join()!==Gu(a).join()?!1:(Kc(x.current,o)||V(e,{...t,attachmentIds:Gu(a)}),a.length||t$(t),!0)",
      `adopt:(t,checkOnly=false)=>{
        if(T.current!==e || !fnosOwnsRetry(e??er(),t) || !Kc(t,te()) ||
          Gu(u.$attachments.get()).join()!==Gu(a).join())return false;
        if(t.fnosProtected===1){
          if(!fnosLive.current.mounted || fnosIntent.current!==fnosLoadedRevision ||
            Gn(e)!==fnosLoadedAt || (a.length && !Moe(t,te(),a)) ||
            [...fnosLiveDrafts].some(live=>live!==fnosLive.current && live.scope()===(e??er()) && live.busy()))return false;
          if(checkOnly)return true;
          const files=fnosRetryFiles(t,fnosLocale);if(!files)return false;
          try {z(e,t.text,files);fnosDraftInternal(()=>U(t.text,files));V(e,t);return fnosDraftPersisted(e,t,fnosLocale);}
          catch {fnosDraftNotice(fnosLocale,false);return false;}
        }
        if(!Kc(x.current,o))V(e,{...t,attachmentIds:Gu(a)});if(!a.length)t$(t);return true;
      }`],
    // A full payload may only pass the recovery/landed pipeline with the matching store patch.
    ["return _ce(e,o,Gn(e),{...c,adopt:", "fnosLive.current.accepted=c.accepted;return (Foe.fnosProtectedNamespace===1)&&_ce(e,o,Gn(e),{...c,adopt:"],
    ["!o.trim()&&a.length===0&&Boe(e,c)", "Foe.fnosProtectedNamespace===1&&!o.length&&a.length===0&&Boe(e,c)"],
  ];
}

function pasteMainReplacements() {
  return [
    [
      'v as C,w,z as T}from"./storage-DCUWjpQr.js"',
      'v as C,w,w as __fnosPasteBrowserHost,z as T}from"./storage-DCUWjpQr.js"',
    ],
    // Capture the existing locale hook during render, never call a hook inside paste.
    ["Ae=pdt(),{t:je}=K(),Me=q(xr)", "Ae=pdt(),{t:je,locale:fnosPasteLocale}=K(),Me=q(xr)"],
    [
      "cn=e=>{let t=Uye(e.clipboardData);if(t.length>0&&m){H(`selection`);for(let e of t)m(e)}let n=yl(e.clipboardData.getData(`text`).trim());if(!n){if(e.preventDefault(),t.length>0)return;g&&(H(`selection`),g({silent:!0}));return}if(bs.test(n)){e.preventDefault();return}e.preventDefault();let r=Hye(n);if(r){let t=Wye(e.currentTarget);if(t){et(),Yy(e.currentTarget,Gye(t,r)),rn(e.currentTarget);return}}if(h&&bie(n)){let t=e.currentTarget;Promise.resolve(h(n)).then(e=>{e?H(`selection`):(et(),Yy(t,LQ(ib(n)),$y(t)),rn(t))});return}let i=$y(e.currentTarget);et(),Yy(e.currentTarget,LQ(ib(n)),i),rn(e.currentTarget)}",
      `cn=e=>{let t=Uye(e.clipboardData);if(t.length>0&&m){H(\`selection\`);for(let e of t)m(e)}let n=yl(e.clipboardData.getData(\`text\`).trim());
        let __fnosPasteFlush=()=>{
          if(__fnosPasteBrowserHost()&&bie(n)){
            nn(e.currentTarget);
            if(!Ce.current&&!KQ(l)){
              // Official stash swallows quota errors and persists text only. Verify disk, not its return value.
              let saved=false;
              try {
                Ze(Le.current,Re.current,P.attachments.$attachments.get());
                const key=Le.current?.trim()||er();
                const disk=JSON.parse(window.localStorage.getItem('hermes:composer-drafts:v4')??'null');
                saved=disk?.drafts?.[key]?.text===Re.current;
              } catch {}
              if(!saved)fnosDraftNotice(fnosPasteLocale,false);
            }
          }else rn(e.currentTarget);
        };
        if(!n){if(e.preventDefault(),t.length>0)return;g&&(H(\`selection\`),g({silent:!0}));return}
        if(__fnosPasteBrowserHost()&&new TextEncoder().encode(n).length>67108864){
          e.preventDefault();Hs({id:'fnos-paste-text-too-large',kind:'warning',message:String(fnosPasteLocale).startsWith('zh')?
            '粘贴的文字超过 64 MiB，未插入。':'Pasted text exceeds 64 MiB and was not inserted.'});return;
        }
        if(bs.test(n)){e.preventDefault();return}e.preventDefault();let r=Hye(n);if(r){let t=Wye(e.currentTarget);if(t){et(),Yy(e.currentTarget,Gye(t,r)),__fnosPasteFlush();return}}if(h&&!__fnosPasteBrowserHost()&&bie(n)){let t=e.currentTarget;Promise.resolve(h(n)).then(e=>{e?H(\`selection\`):(et(),Yy(t,LQ(ib(n)),$y(t)),rn(t))});return}let i=$y(e.currentTarget);et(),Yy(e.currentTarget,LQ(ib(n)),i),__fnosPasteFlush()}`,
    ],
  ];
}

function patchConnectionsBundle(body) {
  const replacements = [
    ["import{A as br,C as xr", "import{V as fnosNewRoute,A as br,C as xr"],
    ["px=(e,t)=>`${ux}${JSON.stringify([e,t])}`", "px=(e,t,p=false)=>`${p?'hermes:composer-protected:v1:':ux}${JSON.stringify([e,t])}`"],
    ["function yx(e,t){", draftOwnerHelpers("vn", "C", "F", "ke", "fnosNewRoute", "Lr", "P", "$t") + "function yx(e,t){"],
    ["let n=Date.now(),r=px(Je(e),t.id);_x(r,{at:n,scope:Je(e),retry:t}),vx(r);",
      `if(t.fnosProtected===1&&!t.fnosOwner)return {durable:()=>false,move:()=>false,retire:()=>{},defer:()=>{}};
      let n=Date.now(),r=px(Je(e),t.id,t.fnosProtected===1),accepted=false,ackOnly=false,superseded=false;
      const entry=()=>({at:n,scope:Je(e),retry:t,...accepted?{accepted:true}:{},...ackOnly?{ackOnly:true}:{},...superseded?{superseded:true}:{}});
      const durable=()=>{try{return window.localStorage.getItem(r)===JSON.stringify(entry())}catch{return false}};
      _x(r,entry());if(durable())vx(r);`],
    ["move:e=>{fx.has(r)&&px(Je(e),t.id)!==r&&(i(),r=px(Je(e),t.id),_x(r,{at:n,scope:Je(e),retry:t}),vx(r))}",
      `move:next=>{const key=px(Je(next),t.id,t.fnosProtected===1);if(!fx.has(r))return false;if(key===r)return durable();
        const entry={at:n,scope:Je(next),retry:t,...accepted?{accepted:true}:{},...ackOnly?{ackOnly:true}:{},...superseded?{superseded:true}:{}};_x(key,entry);
        try{if(window.localStorage.getItem(key)!==JSON.stringify(entry))return false}catch{return false}
        vx(key);i();r=key;e=next;return true}`],
    ["retire:i}}var bx=",  `retire:()=>{
        if(accepted&&!durable()){
          _x(r,entry());if(!durable()){_x(r,void 0);try{if(window.localStorage.getItem(r)!==null)return false}catch{return false}}
        }
        i();return true;
      },accept:replaced=>{accepted=true;superseded=replaced===true;_x(r,entry());return durable()},
      awaitAck:()=>{ackOnly=true;_x(r,entry());return durable()},
      defer:()=>{if((accepted||ackOnly)&&!durable())return;let e=fx.get(r);fx.delete(r);e?.()},durable}}
      yx.fnosFullRetry=1;yx.fnosProtectedNamespace=1;var bx=`],
    ["function pg(e,t,n=()=>{}){for(let r of lg(e)){let i=r.answer(e,t);if(i)return i.then(e=>{e||n()}).catch(n),!0}return!1}",
      "function pg(e,t,n=()=>{},success=()=>{}){for(let r of lg(e)){let i=r.answer(e,t);if(i)return i.then(delivered=>{if(delivered===true)success();else n()},n),!0}return!1}"],
    ["if(!i?.startsWith(ux)||fx.has(i))continue;", "if(!(i?.startsWith(ux)||i?.startsWith('hermes:composer-protected:v1:'))||fx.has(i))continue;"],
    ["Date.now()-t.at<dx?t:void 0", "(t.retry.fnosProtected===1||Date.now()-t.at<dx)?t:void 0"],
    ["function wx(e){Sx(e).forEach(e=>_x(e,void 0))}",
      "function wx(e){Sx(e).forEach(e=>{if(gx(e)?.retry.fnosProtected!==1)_x(e,void 0)})}"],
    ["e&&n<=e.at&&Qb(e.retry,t)", "e&&fnosOwnsRetry(e.scope,e.retry)&&(e.retry.fnosProtected!==1||r.fnosFullRetry===1)&&n<=e.at&&Qb(e.retry,t)"],
    ["a=e=>{let t=gx(e);return!fx.has(e)&&i(t)&&r.adopt(t.retry)?(_x(e,void 0),Tx(t,r),!0):!1}",
      `a=async e=>{const t=gx(e);if(fx.has(e)||!i(t))return false;
        if(t.retry.fnosProtected!==1)return r.adopt(t.retry)?(_x(e,void 0),Tx(t,r),true):false;
        if(t.accepted===true){if(!t.superseded&&r.accepted?.(t.retry)!==true)return false;_x(e,void 0);return true;}
        if(!r.adopt(t.retry,true))return false;
        const conn={...C.get()},profile=F.get(),landed=!t.ackOnly&&await lx(t.scope,t.retry.id,t.at);
        if(fx.has(e)||JSON.stringify(gx(e))!==JSON.stringify(t)||!i(t)||profile!==F.get()||
          ['baseUrl','token','connectionId','mode','authMode'].some(key=>conn[key]!==C.get()?.[key])||!r.adopt(t.retry,true))return false;
        if(!r.adopt(t.retry) || (landed && r.landed(t.retry)!==true))return false;
        _x(e,void 0);if(!landed&&!t.ackOnly)xx(t,r.withdraw);return true;}`],
    ["e=>!!(e&&a(t))):a(t)", "async e=>!!e&&await a(t)):await a(t)"],
    ["n&&!fx.has(e)&&(await lx(n.scope,n.retry.id,n.at)?_x(e,void 0):gx(e)&&t.offer(n.retry)&&(_x(e,void 0),xx(n,t.withdraw)))", 
      `if(!n||fx.has(e)||!fnosOwnsRetry(n.scope,n.retry)||(n.retry.fnosProtected===1&&t.fnosFullRetry!==1))return;
      if(n.accepted===true){if(n.superseded||t.accepted?.(n.retry)===true)_x(e,void 0);return;}
      const conn={...C.get()},profile=F.get(),landed=!n.ackOnly&&await lx(n.scope,n.retry.id,n.at);
      if(!gx(e)||fx.has(e)||!fnosOwnsRetry(n.scope,n.retry)||profile!==F.get()||
        ['baseUrl','token','connectionId','mode','authMode'].some(key=>conn[key]!==C.get()?.[key]))return;
      if(landed)_x(e,void 0);else if(t.offer(n.retry)){_x(e,void 0);if(!n.ackOnly)xx(n,t.withdraw)}`],
    ["await lx(e.scope,e.retry.id,e.at)?t(e.retry):xx(e,n)",
      "await lx(e.scope,e.retry.id,e.at)?fnosOwnsRetry(e.scope,e.retry)&&t(e.retry):fnosOwnsRetry(e.scope,e.retry)&&xx(e,n)"],
    ["i.has(e.retry.id)&&(clearTimeout(r),n(),t(e.retry))",
      "i.has(e.retry.id)&&fnosOwnsRetry(e.scope,e.retry)&&(clearTimeout(r),n(),t(e.retry))"],
  ];
  return replacePinnedBundle(body, CONNECTIONS_BUNDLE_SHA256, replacements);
}

function replacePinnedBundle(body, sha, replacements) {
  if (createHash("sha256").update(body).digest("hex") !== sha) return body;
  let source = body.toString("utf8");
  for (const [before, after] of replacements) {
    if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) return body;
    source = source.replace(before, () => after);
  }
  return Buffer.from(source);
}

// 仅修补已核验的 v0.23.2 产物响应，官方源码、归档和未知版本保持原样。
function patchSlashBundle(body) {
  if (createHash("sha256").update(body).digest("hex") !== SLASH_BUNDLE_SHA256) return body;
  const replacements = [
    [
      "createSession:()=>o(t),explicitRuntimeId:e",
      "createSession:async()=>{const before=Kt.get(),profile=oy.get();" +
      "const id=await o(t,{onComposerScopeAssigned:b?.onComposerScopeAssigned});if(id){" +
      "const after=Kt.get();if(profile!==oy.get()||" +
      "['baseUrl','token','connectionId','mode','authMode'].some(key=>before?.[key]!==after?.[key])||" +
      "(before?.profile&&(before.profile!==after?.profile||before.wsUrl!==after?.wsUrl)))" +
      "throw Error('Submission destination changed; retry from the original session');" +
      "D=E5e(D,V_.get()[id]?.storedSessionId??id,p);O=D.requestGateway;}return id},explicitRuntimeId:e",
    ],
    [
      "let A=b?.submission_id??kc(),j=async(e,t)=>q8e(",
      "const fnosSlashFailure=()=>{w=!1;Hs({kind:`error`,title:a.promptFailed," +
      "message:`命令未完成，输入已保留，请重试。`})};let A=b?.submission_id??kc(),j=async(e,t)=>q8e(",
    ],
    [
      "if(!r)return Hs({kind:`error`,title:a.sessionUnavailable,message:a.createSessionFailed}),null;",
      "if(!r)return w=!1,Hs({kind:`error`,title:a.sessionUnavailable,message:a.createSessionFailed}),null;",
    ],
    [
      "render:t=>n(r,`system`,e.recordInput?gu(`/${e.name}`,t):t,i),sessionId:r,storedSessionId:i",
      "render:t=>{const prefix=TY().error('');" +
      "if(/^error:/i.test(t)||(prefix&&t.startsWith(prefix))||t===OY().queueFailed)fnosSlashFailure();" +
      "return n(r,`system`,e.recordInput?gu(`/${e.name}`,t):t,i)},sessionId:r,storedSessionId:i",
    ],
    [
      "o(`/${r}: ${e.type===`skill`?`skill payload missing message`:`empty message`}`)",
      "o(`error: /${r}: ${e.type===`skill`?`skill payload missing message`:`empty message`}`)",
    ],
    [
      "destination:D,requestGateway:O,runExec:F,submitPromptText:_,updateSessionState:v,withSlashOutput:M",
      "destination:D,requestGateway:(...args)=>O(...args),runExec:F," +
      "submitPromptText:async(text,options)=>{const accepted=await _(text,{...options,destination:D});" +
      "if(accepted===!1)w=!1;return accepted},updateSessionState:v,withSlashOutput:M",
    ],
    [
      "m5e({requestGateway:O,updateSessionState:v,withSlashOutput:M})",
      "m5e({requestGateway:(...args)=>O(...args),updateSessionState:v,withSlashOutput:M})",
    ],
    [
      "return await z(e,b?.sessionId??void 0,b?.recordInput??!0),w",
      "try{await z(e,b?.sessionId??void 0,b?.recordInput??!0)}catch{fnosSlashFailure()}return w",
    ],
  ];
  return replacePinnedBundle(body, SLASH_BUNDLE_SHA256, [...replacements, ...pasteMainReplacements(), ...draftMainReplacements()]);
}

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
const failure = (status) => new Response(http.STATUS_CODES[status], { status });

function hopHeaders(headers) {
  return new Set([...HOP_HEADERS, ...(headers.get("connection") || "")
    .split(",").map((name) => name.trim().toLowerCase()).filter(Boolean)]);
}

function upstreamHeaders(rawHeaders, embeddable = false) {
  const headers = new Headers();
  for (let i = 0; i < rawHeaders.length; i += 2) headers.append(rawHeaders[i], rawHeaders[i + 1]);
  for (const name of hopHeaders(headers)) headers.delete(name);
  if (embeddable) allowSameOriginFraming(headers);
  return headers;
}

// 上游在 WebApp 及其启动交接页上发送 frame-ancestors 'none'，面板用同源 iframe 嵌入这两者，
// 所以只把这一条指令放宽为 'self'。
function allowSameOriginFraming(headers) {
  const policy = headers.get("content-security-policy");
  if (policy) headers.set("content-security-policy", policy.replace(/frame-ancestors\s+'none'/gi, "frame-ancestors 'self'"));
  headers.delete("x-frame-options");
}

function asResponse(incoming, method, embeddable = false) {
  const noBody = method === "HEAD" || [204, 205, 304].includes(incoming.statusCode);
  if (noBody) incoming.resume();
  return new Response(noBody ? null : Readable.toWeb(incoming, {
    strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.length },
  }), {
    status: incoming.statusCode,
    statusText: incoming.statusMessage,
    headers: upstreamHeaders(incoming.rawHeaders, embeddable),
  });
}

// 只对 WebApp 自身的页面注入：上游给它的 CSP 含 script-src 'self'，交接页（nonce 策略）
// 和非 HTML 响应不动。压缩过的响应体也不动，上游目前不压缩 HTML。
function patchableHtml(incoming, method) {
  if (method !== "GET" || incoming.statusCode !== 200) return false;
  const type = String(incoming.headers["content-type"] || "").toLowerCase();
  if (!type.startsWith("text/html")) return false;
  const encoding = String(incoming.headers["content-encoding"] || "identity").toLowerCase();
  if (encoding !== "identity") return false;
  if (Number(incoming.headers["content-length"] || 0) > MAX_PATCHED_HTML_BYTES) return false;
  const policy = String(incoming.headers["content-security-policy"] || "");
  return /script-src[^;]*'self'/i.test(policy);
}

// 补丁脚本插在页面首个 module 脚本之前：defer 脚本与 module 脚本按文档顺序在解析完成后执行，
// 这样补丁能在上游读取 localStorage 布局状态之前先行写入。
function injectPatchTags(html, prefix) {
  const css = `<link rel="stylesheet" href="${prefix}${PATCH_ROUTE}patch.css">`;
  const js = `<script src="${prefix}${PATCH_ROUTE}patch.js" defer></script>`;
  let out = html;
  if (out.includes('/assets/index-BFs_r4rL.js"')) {
    for (const attribute of ["src", "href"]) {
      for (const assets of [`${prefix}/assets/`, "./assets/"]) {
        out = out.replaceAll(`${attribute}="${assets}`, `${attribute}="${prefix}${SLASH_ASSET_ROUTE}`);
      }
    }
  }
  const head = out.search(/<\/head\s*>/i);
  out = head >= 0 ? out.slice(0, head) + css + out.slice(head) : css + out;
  const module = out.search(/<script\b[^>]*\btype\s*=\s*["']?module\b/i);
  if (module >= 0) return out.slice(0, module) + js + out.slice(module);
  const body = out.search(/<\/body\s*>/i);
  return body >= 0 ? out.slice(0, body) + js + out.slice(body) : out + js;
}

async function patchedResponse(incoming, prefix, embeddable) {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > MAX_PATCHED_HTML_BYTES) throw new Error("WebApp page too large to patch");
    chunks.push(chunk);
  }
  const html = injectPatchTags(Buffer.concat(chunks).toString("utf8"), prefix);
  const headers = upstreamHeaders(incoming.rawHeaders, embeddable);
  headers.delete("content-length");
  return new Response(html, { status: 200, statusText: incoming.statusMessage, headers });
}

async function slashBundleResponse(incoming, method, embeddable, bundle) {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > bundle.bytes) throw new Error("Invalid WebApp bundle length");
    chunks.push(chunk);
  }
  const original = Buffer.concat(chunks);
  const body = bundle.patch(original);
  const headers = upstreamHeaders(incoming.rawHeaders, embeddable);
  if (body !== original) {
    for (const name of ["etag", "last-modified", "content-md5", "digest", "content-digest", "repr-digest", "accept-ranges"]) {
      headers.delete(name);
    }
    headers.set("content-length", String(body.length));
    headers.set("cache-control", "no-store");
    headers.set("x-fnos-webapp-fix", "slash-v1");
  }
  return new Response(method === "HEAD" ? null : body, {
    status: incoming.statusCode, statusText: incoming.statusMessage, headers,
  });
}

async function servePatchFile(dir, name) {
  const type = PATCH_FILES[name];
  if (!type) return failure(404);
  try {
    const body = await readFile(`${dir}/${name}`);
    return new Response(body, {
      status: 200,
      headers: { "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff" },
    });
  } catch {
    return failure(404);
  }
}

function closePeer(ws, code, reason) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CONNECTING) { ws.terminate(); return; }
  if (ws.readyState !== WebSocket.OPEN) return;
  const valid = (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999);
  if (valid || code === 1005) ws.resume?.(); // 即使处于背压状态也要读到对端的关闭回复。
  if (valid) ws.close(code, reason);
  else if (code === 1005) ws.close();
  else ws.terminate(); // 保留码 1006/1015 绝不发到线路上。
}

/**
 * 只做官方 WebApp 的传输层。调用方在每一次 HTTP/WS 握手上都提供可信的 NAS 鉴权。
 * 上游是绑定回环地址、没有公网 URL 的 Hermes 界面，因此 Host/Origin 改写为回环地址，
 * 只额外加 X-Forwarded-Prefix。升级成功返回 undefined。拒绝时返回 Response，与 handleHttp 一致。
 * 不注入凭证、不发业务 RPC、不跟随上游重定向。
 * 传入 patchDir 时，WebApp 页面 HTML 会追加同源的 __fnos/patch.css 与 __fnos/patch.js 外链，
 * 这两个文件直接从 patchDir 提供，不经上游。用于在不改动上游前端的前提下修补界面问题。
 */
export function createWebappProxy({ port, basePath, authorize, surface = "webapp", patchDir = null }) {
  if (!["webapp", "dashboard"].includes(surface)) throw new TypeError("Invalid official web surface");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("Invalid WebApp port");
  if (typeof basePath !== "string" || (basePath && !basePath.startsWith("/")) ||
      /[?#\\%\s]/.test(basePath) || basePath.includes("//") ||
      basePath.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError("Invalid WebApp basePath");
  }
  if (typeof authorize !== "function") {
    throw new TypeError("WebApp authorization callback is required");
  }
  if (patchDir !== null && (typeof patchDir !== "string" || !patchDir)) {
    throw new TypeError("Invalid WebApp patchDir");
  }
  const authority = `127.0.0.1:${port}`;
  const prefix = `${basePath.replace(/\/$/, "")}/${surface}`;
  const embeddable = surface === "webapp";
  const patching = embeddable && patchDir !== null;
  const matches = (pathname) => typeof pathname === "string" &&
    (pathname === prefix || pathname.startsWith(`${prefix}/`));
  const agent = new http.Agent({ keepAlive: true });
  const requests = new Set();
  const sessions = new Set();
  // 正在关闭的连接也要跟踪：close() 不能留下存活的 WS 关闭握手定时器。
  const peers = new Set();
  let closed = false;

  async function prepare(req, websocket = false) {
    const url = new URL(req.url);
    if (!matches(url.pathname)) return failure(404);
    // 默认拒绝（fail-closed）：回调抛异常，或返回的不是布尔值 true（包括其他真值），都按拒绝处理。
    try { if (await authorize(req) !== true) return failure(401); }
    catch { return failure(401); }
    if (closed || req.signal.aborted) return failure(503);
    const headers = {};
    const hop = hopHeaders(req.headers);
    for (const [name, value] of req.headers) {
      if (hop.has(name) || name === "host" || name === "origin" || name === "forwarded" ||
          name.startsWith("x-forwarded-") || name === "x-monitor-token" ||
          name.startsWith("x-trim-") || (websocket && name.startsWith("sec-websocket-"))) continue;
      headers[name] = value;
    }
    headers.host = authority;
    // Hermes 要求票据交换和 WS 的 Origin 等于它自己的回环地址。
    if (req.headers.has("origin")) headers.origin = `http://${authority}`;
    headers["x-forwarded-prefix"] = prefix;
    // Cookie、Authorization 和 Hermes 自身的认证头保持不动。
    return { headers, path: (url.pathname.slice(prefix.length) || "/") + url.search };
  }

  async function handleHttp(req) {
    const prepared = await prepare(req);
    if (prepared instanceof Response) return prepared;
    const slashAssets = patching && prepared.path.startsWith(SLASH_ASSET_ROUTE);
    if (slashAssets) prepared.path = `/assets/${prepared.path.slice(SLASH_ASSET_ROUTE.length)}`;
    const slashBundle = slashAssets && ["GET", "HEAD"].includes(req.method) && ({
      [SLASH_BUNDLE]: { bytes: SLASH_BUNDLE_BYTES, patch: patchSlashBundle },
      [CONNECTIONS_BUNDLE]: { bytes: CONNECTIONS_BUNDLE_BYTES, patch: patchConnectionsBundle },
    })[prepared.path.split("?")[0]];
    if (slashBundle) {
      for (const name of ["if-none-match", "if-modified-since", "if-range", "range"]) delete prepared.headers[name];
      prepared.headers["accept-encoding"] = "identity";
    }
    if (patching && prepared.path.startsWith(PATCH_ROUTE)) {
      if (req.method !== "GET" && req.method !== "HEAD") return failure(405);
      const name = prepared.path.slice(PATCH_ROUTE.length).split("?")[0];
      return servePatchFile(patchDir, name);
    }
    return new Promise((resolve) => {
      let incoming;
      let upload;
      let timer;
      // 注入时整段读完响应体再 resolve。此时上游请求的 close 先于读取完成触发，不能当作失败。
      let buffering = false;
      const upstream = http.request({
        hostname: "127.0.0.1", port, path: prepared.path,
        method: slashBundle ? "GET" : req.method, headers: prepared.headers, agent,
      });
      requests.add(upstream);
      const abort = () => {
        incoming?.destroy();
        upstream.destroy();
        upload?.destroy();
        resolve(failure(502));
      };
      const cleanup = () => {
        clearTimeout(timer);
        requests.delete(upstream);
        req.signal.removeEventListener("abort", abort);
      };
      req.signal.addEventListener("abort", abort, { once: true });
      upstream.once("socket", (socket) => {
        if (!socket.connecting) return;
        // 只对 TCP 建连计时，不限制响应/SSE/文件传输时长。
        timer = setTimeout(() => upstream.destroy(new Error("WebApp connection timeout")), CONNECT_TIMEOUT);
        timer.unref();
        socket.once("connect", () => clearTimeout(timer));
      });
      upstream.once("response", (res) => {
        incoming = res;
        clearTimeout(timer);
        if (slashBundle && res.statusCode === 200 &&
            /^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(res.headers["content-type"] || "") &&
            [undefined, "identity"].includes(res.headers["content-encoding"]) &&
            Number(res.headers["content-length"]) === slashBundle.bytes) {
          buffering = true;
          slashBundleResponse(res, req.method, embeddable, slashBundle).then(resolve, () => { res.destroy(); resolve(failure(502)); });
          return;
        }
        if (patching && patchableHtml(res, req.method)) {
          buffering = true;
          patchedResponse(res, prefix, embeddable).then(resolve, () => { res.destroy(); resolve(failure(502)); });
          return;
        }
        try { resolve(asResponse(res, req.method, embeddable)); }
        catch { res.destroy(); resolve(failure(502)); }
      });
      upstream.once("error", () => {
        upload?.destroy();
        incoming?.destroy(new Error("WebApp upstream stream failed"));
        resolve(failure(502));
      });
      upstream.once("close", () => {
        cleanup();
        // 无错误的 destroy()（proxy.close 或客户端中止）也必须结束尚未收到响应头的调用。
        if (!buffering) resolve(failure(502));
        if (upload && !upload.readableEnded) upload.destroy();
      });
      if (req.signal.aborted || closed) { abort(); return; }
      if (req.body) {
        upload = Readable.fromWeb(req.body);
        pipeline(upload, upstream, () => {});
      } else upstream.end();
    });
  }

  // 每个方向的计数都有上限（含正在发送的数据）。用 pause/resume 和 ws.send 回调施加传输背压，
  // 而不是无限堆积消息数组。
  function channel(state, source, target) {
    const queue = [];
    let bytes = 0;
    let count = 0;
    let sending = false;
    function clear() { queue.length = 0; bytes = 0; count = 0; }
    function pump() {
      if (state.dead || sending) return;
      const peer = target();
      if (!peer || peer.readyState !== WebSocket.OPEN) return;
      const item = queue.shift();
      if (!item) { source()?.resume(); return; }
      sending = true;
      try {
        peer.send(item.data, { binary: item.binary }, (err) => {
          sending = false;
          if (state.dead) return;
          bytes -= item.size;
          count--;
          if (err) state.fail();
          else pump();
        });
      } catch { sending = false; state.fail(); }
    }
    return {
      clear, pump,
      push(data, binary) {
        if (state.dead) return;
        const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        if (++count > MAX_PENDING_MESSAGES || bytes + (target()?.bufferedAmount || 0) > MAX_PENDING_BYTES) {
          state.fail(1013, "WebApp backpressure limit");
          return;
        }
        bytes += size;
        queue.push({ data, binary, size });
        source()?.pause();
        pump();
      },
    };
  }

  async function upgrade(req, server) {
    const prepared = await prepare(req, true);
    if (prepared instanceof Response) return prepared;
    const protocols = (req.headers.get("sec-websocket-protocol") || "")
      .split(",").map((value) => value.trim()).filter(Boolean);
    return new Promise((resolve) => {
      let settled = false;
      const settle = (response) => { if (!settled) { settled = true; resolve(response); } };
      const state = { kind: "webapp", upstream: null, downstream: null, dead: false };
      let acceptTimer;
      let rejection;
      const detachAbort = () => req.signal.removeEventListener("abort", abort);
      const cleanup = () => {
        clearTimeout(acceptTimer);
        detachAbort();
        state.toClient.clear();
        state.toUpstream.clear();
        sessions.delete(state);
      };
      state.fail = (code, reason) => {
        if (state.dead) return;
        state.dead = true;
        cleanup();
        rejection?.destroy();
        closePeer(state.upstream, code, reason);
        closePeer(state.downstream, code, reason);
        settle(failure(502));
      };
      const abort = () => state.fail();
      state.toClient = channel(state, () => state.upstream, () => state.downstream);
      state.toUpstream = channel(state, () => state.downstream, () => state.upstream);
      state.open = (ws) => {
        state.downstream = ws;
        peers.add(ws);
        clearTimeout(acceptTimer);
        detachAbort(); // 接受之后 WS 生命周期由关闭帧管理，不再由请求中止管理。
        if (state.dead || state.upstream.readyState !== WebSocket.OPEN) {
          closePeer(ws, state.closeCode, state.closeReason);
          return;
        }
        state.toClient.pump();
      };
      state.onClose = (code, reason) => {
        peers.delete(state.downstream);
        state.closeCode = code;
        state.closeReason = reason;
        closePeer(state.upstream, code, reason);
        if (state.upstream.readyState === WebSocket.CLOSED) cleanup();
      };
      sessions.add(state);
      req.signal.addEventListener("abort", abort, { once: true });
      try {
        // 在固定的 authority 之后拼接。即使路径以 // 开头也改不了主机。
        state.upstream = new WebSocket(`ws://127.0.0.1:${port}${prepared.path}`, protocols, {
          headers: prepared.headers, followRedirects: false, perMessageDeflate: false,
          handshakeTimeout: CONNECT_TIMEOUT, maxPayload: MAX_MESSAGE_BYTES,
        });
      } catch { state.fail(); return; }
      const upstream = state.upstream;
      peers.add(upstream);
      let handshakeHeaders;
      upstream.on("upgrade", (res) => { handshakeHeaders = upstreamHeaders(res.rawHeaders); });
      upstream.on("unexpected-response", (client, res) => {
        rejection = res;
        client.setTimeout(0); // 拒绝响应的响应体本身也可能是流式的。
        res.once("close", () => state.fail());
        try { settle(asResponse(res, req.method, embeddable)); }
        catch { state.fail(); }
      });
      upstream.on("error", () => state.fail()); // 绝不记录 URL、请求头、令牌或库错误。
      upstream.on("message", (data, binary) => state.toClient.push(data, binary));
      upstream.on("close", (code, reason) => {
        peers.delete(upstream);
        state.closeCode = code;
        state.closeReason = reason;
        closePeer(state.downstream, code, reason);
        if (!state.downstream || state.downstream.readyState === WebSocket.CLOSED) cleanup();
        settle(failure(502));
      });
      upstream.on("open", () => {
        if (closed || req.signal.aborted || state.dead) { state.fail(); return; }
        try {
          if (!server.upgrade(req, { data: state, protocol: upstream.protocol, headers: handshakeHeaders })) {
            state.fail();
            return;
          }
          // 调用方注册了升级却始终不触发 websocket.open 时，限制这段空窗时间。
          acceptTimer = setTimeout(() => state.fail(), CONNECT_TIMEOUT);
          acceptTimer.unref();
          settle(undefined);
        } catch { state.fail(); }
      });
      if (closed || req.signal.aborted) state.fail();
    });
  }

  const websocket = {
    open(ws) { if (ws.data?.kind === "webapp") ws.data.open(ws); },
    message(ws, message) {
      if (ws.data?.kind === "webapp") ws.data.toUpstream.push(message, typeof message !== "string");
    },
    close(ws, code, reason) { if (ws.data?.kind === "webapp") ws.data.onClose(code, reason); },
    error(ws) { if (ws.data?.kind === "webapp") ws.data.fail(); },
  };

  function close() {
    closed = true;
    for (const request of requests) request.destroy();
    for (const state of sessions) state.fail();
    for (const peer of peers) peer.terminate();
    peers.clear();
    agent.destroy();
  }
  return { matches, handleHttp, upgrade, websocket, close };
}
