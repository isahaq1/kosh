/**
 * The chat window of a channel (RFC 0034 §2.6): one self-contained document — no sign-in, no framework, nothing
 * loaded from elsewhere — in which a visitor writes, reads the answers as they come and ends the conversation
 * with a rating. It works with a keyboard and a screen reader, in light and dark, on a phone, in English and
 * Bangla. Everything said is written as text, never as markup. The conversation is the visitor's by a secret kept
 * in this tab only; the server checks every call again.
 */
import type { ChannelInfo } from './module.js';

const WORDS = {
  en: {
    name: 'Your name',
    email: 'Your email',
    emailNeeded: 'Your email (so that we can write back)',
    message: 'Your message',
    start: 'Start the chat',
    send: 'Send',
    end: 'End the chat',
    waiting: 'Waiting for someone to answer…',
    with: 'You are talking with',
    ended: 'This conversation has ended.',
    missed: 'Nobody could answer in time. We have your message and will write back.',
    rate: 'How was it?',
    rated: 'Thank you.',
    again: 'Start a new chat',
    failed: 'It could not be sent. Check your connection and try again.',
    you: 'You',
    unknown: 'This link does not open a chat.',
    stars: 'out of five',
  },
  bn: {
    name: 'আপনার নাম',
    email: 'আপনার ইমেইল',
    emailNeeded: 'আপনার ইমেইল (যাতে আমরা উত্তর দিতে পারি)',
    message: 'আপনার বার্তা',
    start: 'চ্যাট শুরু করুন',
    send: 'পাঠান',
    end: 'চ্যাট শেষ করুন',
    waiting: 'কেউ উত্তর দেওয়ার অপেক্ষায়…',
    with: 'আপনি কথা বলছেন',
    ended: 'এই কথোপকথন শেষ হয়েছে।',
    missed: 'সময়মতো কেউ উত্তর দিতে পারেননি। আপনার বার্তা আমাদের কাছে আছে, আমরা লিখে জানাব।',
    rate: 'কেমন লাগল?',
    rated: 'ধন্যবাদ।',
    again: 'নতুন চ্যাট শুরু করুন',
    failed: 'পাঠানো যায়নি। সংযোগ দেখে আবার চেষ্টা করুন।',
    you: 'আপনি',
    unknown: 'এই লিংকে কোনো চ্যাট নেই।',
    stars: 'পাঁচের মধ্যে',
  },
} as const;

export type PageLanguage = keyof typeof WORDS;

/** English unless the visitor asks for Bangla (`?lang=bn`, or their browser's first language). */
export function pageLanguage(query: unknown, acceptLanguage: unknown): PageLanguage {
  const asked = typeof query === 'string' ? query : '';
  if (asked === 'bn' || asked === 'en') return asked;
  return typeof acceptLanguage === 'string' && /^\s*bn\b/i.test(acceptLanguage) ? 'bn' : 'en';
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** JSON inside a script element: nothing in it can close the element. */
const embed = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
html,body{height:100%}
body{font:16px/1.45 system-ui,sans-serif;margin:0;color:#111;background:#fff;display:flex;flex-direction:column}
header{padding:.75rem 1rem;border-bottom:1px solid #8884}
h1{font-size:1.1rem;margin:0}
.sub{font-size:.85rem;color:#555;margin:.15rem 0 0}
main{flex:1;min-height:0;display:flex;flex-direction:column;padding:0 1rem 1rem}
#log{flex:1;min-height:6rem;overflow-y:auto;padding:.75rem 0;display:flex;flex-direction:column;gap:.5rem}
.m{max-width:85%;padding:.45rem .7rem;border-radius:.8rem;white-space:pre-wrap;overflow-wrap:anywhere}
.m .who{display:block;font-size:.75rem;color:#555}
.visitor{align-self:flex-end;background:#1d4ed8;color:#fff}
.visitor .who{color:#dbeafe}
.operator,.assistant{align-self:flex-start;background:#8882}
.system{align-self:center;font-size:.85rem;color:#555;background:none;padding:0}
label{display:block;font-weight:600;font-size:.9rem;margin:.6rem 0 .25rem}
input,textarea{font:inherit;width:100%;padding:.5rem;border:1px solid #888;border-radius:.4rem;background:transparent;color:inherit}
textarea{min-height:4.5rem;resize:vertical}
.row{display:flex;gap:.5rem;align-items:flex-end;margin-top:.5rem}
.row textarea{min-height:2.75rem;height:2.75rem}
button{font:inherit;font-weight:600;padding:.55rem 1rem;border:0;border-radius:.4rem;background:#1d4ed8;color:#fff;cursor:pointer}
button.quiet{background:none;color:inherit;border:1px solid #888;font-weight:400}
button:disabled{opacity:.6;cursor:default}
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}
.stars{display:flex;gap:.35rem;margin:.4rem 0}
.stars button{background:none;color:inherit;border:1px solid #888;padding:.35rem .7rem}
.err{color:#b91c1c;margin:.4rem 0 0}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
[hidden]{display:none!important}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}.sub,.m .who,.system{color:#aaa}.err{color:#fca5a5}.visitor .who{color:#dbeafe}}
`;

/** The page's script: plain DOM, text only. Polls for what was said since the last message it has. */
const SCRIPT = `
(function(){
var d=JSON.parse(document.getElementById('chat').textContent),w=d.words,base=d.base,store='livechat:'+d.key;
var $=function(id){return document.getElementById(id)};
var secret=null,last=0,state=null,timer=null,busy=false;
try{secret=sessionStorage.getItem(store)}catch(e){}
function call(method,path,body){
  var h={'accept':'application/json'};if(secret)h['x-chat-secret']=secret;if(body)h['content-type']='application/json';
  return fetch(base+path,{method:method,headers:h,body:body?JSON.stringify(body):undefined}).then(function(r){
    return r.text().then(function(t){var j=null;try{j=t?JSON.parse(t):null}catch(e){}return{status:r.status,json:j}})})}
function line(m){
  var p=document.createElement('div');p.className='m '+m.kind;
  if(m.kind!=='system'){var s=document.createElement('span');s.className='who';s.textContent=m.kind==='visitor'?w.you:(m.author||'');p.appendChild(s)}
  p.appendChild(document.createTextNode(m.body));$('log').appendChild(p);$('log').scrollTop=$('log').scrollHeight}
function show(v){
  (v.messages||[]).forEach(function(m){if(m.id>last){last=m.id;line(m)}});
  if(v.state===state)return;state=v.state;
  var over=state==='closed'||state==='missed';
  $('start').hidden=true;$('talk').hidden=over;$('over').hidden=!over;
  $('status').textContent=state==='waiting'?w.waiting:state==='active'?(v.operator?w.with+' '+v.operator:''):state==='missed'?w.missed:w.ended;
  $('rate').hidden=state!=='closed'||!!d.rated;
  if(over&&timer){clearInterval(timer);timer=null}}
function poll(){
  if(busy||!secret)return;busy=true;
  call('GET','/sessions/current?after='+last).then(function(r){busy=false;
    if(r.status===200)show(r.json);else if(r.status===404){forget();fresh()}},function(){busy=false})}
function forget(){secret=null;last=0;state=null;try{sessionStorage.removeItem(store)}catch(e){}if(timer){clearInterval(timer);timer=null}}
function fresh(){$('log').textContent='';$('start').hidden=false;$('talk').hidden=true;$('over').hidden=true;$('status').textContent=d.online?d.welcome:d.offline;$('thanks').hidden=true}
function fail(where,text){$(where).textContent=text||w.failed;$(where).hidden=false}
$('start').addEventListener('submit',function(e){e.preventDefault();$('e1').hidden=true;$('go').disabled=true;
  call('POST','/sessions',{name:$('name').value,email:$('email').value,message:$('first').value,website:$('website').value,page:d.page,lang:d.lang}).then(function(r){
    $('go').disabled=false;
    if(r.status===201){secret=r.json.secret;try{sessionStorage.setItem(store,secret)}catch(e){}$('first').value='';show(r.json.session);timer=setInterval(poll,3000);$('say').focus()}
    else fail('e1',r.json&&r.json.detail)},function(){$('go').disabled=false;fail('e1')})});
function send(){var t=$('say').value;if(!t.trim())return;$('e2').hidden=true;$('send').disabled=true;
  call('POST','/sessions/current/messages',{body:t}).then(function(r){$('send').disabled=false;
    if(r.status===201){$('say').value='';poll();$('say').focus()}else if(r.status===409){poll()}else fail('e2',r.json&&r.json.detail)},function(){$('send').disabled=false;fail('e2')})}
$('talk').addEventListener('submit',function(e){e.preventDefault();send()});
$('say').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send()}});
$('end').addEventListener('click',function(){call('POST','/sessions/current/close',{}).then(poll,poll)});
Array.prototype.forEach.call(document.querySelectorAll('.stars button'),function(b){b.addEventListener('click',function(){
  call('POST','/sessions/current/close',{rating:Number(b.value)}).then(function(){d.rated=true;$('rate').hidden=true;$('thanks').hidden=false})})});
$('again').addEventListener('click',function(){d.rated=false;forget();fresh();$('first').focus()});
if(secret){timer=setInterval(poll,3000);poll()}else fresh();
})();
`;

/** The document a visitor gets for a channel's chat. */
export function renderWidget(
  channel: ChannelInfo,
  options: {
    readonly key: string;
    readonly base: string;
    readonly language: PageLanguage;
    readonly nonce: string;
    readonly page: string;
  },
): string {
  const words = WORDS[options.language];
  const e = escapeHtml;
  const stars = [1, 2, 3, 4, 5]
    .map(
      (n) => `<button type="button" value="${n}" aria-label="${n} ${e(words.stars)}">${n}</button>`,
    )
    .join('');
  return `<!doctype html><html lang="${options.language}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${e(channel.name)}</title><style>${STYLE}</style></head>
<body><header><h1>${e(channel.name)}</h1><p class="sub" id="status" role="status" aria-live="polite"></p></header>
<main><div id="log" role="log" aria-live="polite" aria-label="${e(channel.name)}"></div>
<form id="start" novalidate>
<label for="name">${e(words.name)}</label><input type="text" id="name" maxlength="80" autocomplete="name">
<label for="email">${e(channel.online ? words.email : words.emailNeeded)}</label><input type="email" id="email" maxlength="200" autocomplete="email"${channel.online ? '' : ' required'}>
<div class="hp" aria-hidden="true"><label for="website">Website</label><input type="text" id="website" tabindex="-1" autocomplete="off"></div>
<label for="first">${e(words.message)}</label><textarea id="first" maxlength="2000" required></textarea>
<p class="err" id="e1" role="alert" hidden></p>
<div class="row"><button type="submit" id="go">${e(words.start)}</button></div></form>
<form id="talk" hidden novalidate><p class="err" id="e2" role="alert" hidden></p>
<div class="row"><textarea id="say" maxlength="2000" aria-label="${e(words.message)}"></textarea><button type="submit" id="send">${e(words.send)}</button></div>
<div class="row"><button type="button" class="quiet" id="end">${e(words.end)}</button></div></form>
<div id="over" hidden><div id="rate"><p>${e(words.rate)}</p><div class="stars">${stars}</div></div>
<p id="thanks" role="status" hidden>${e(words.rated)}</p>
<button type="button" class="quiet" id="again">${e(words.again)}</button></div></main>
<script type="application/json" id="chat" nonce="${options.nonce}">${embed({
    key: options.key,
    base: options.base,
    words,
    online: channel.online,
    welcome: channel.welcome,
    offline: channel.offline,
    page: options.page,
    lang: options.language,
    rated: false,
  })}</script>
<script nonce="${options.nonce}">${SCRIPT}</script></body></html>`;
}

/** The document for a key that opens nothing. */
export function renderUnknown(language: PageLanguage): string {
  const words = WORDS[language];
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(words.unknown)}</title><style>${STYLE}</style></head>
<body><main><p role="status">${escapeHtml(words.unknown)}</p></main></body></html>`;
}

/** An origin a channel may be framed by: `https://shop.example.com`, nothing else in it. */
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

/** The origins of a channel's setting, one per line or space; what is not an origin is left out. */
export function framedBy(setting: string | null | undefined): string[] {
  return (setting ?? '')
    .split(/\s+/)
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => ORIGIN.test(o))
    .slice(0, 20);
}

/**
 * The headers of the chat window: its own script and style only, never cached; framed by nobody unless the
 * channel names the sites that may.
 */
export const pageSecurity = (
  nonce: string,
  origins: readonly string[],
): Readonly<Record<string, string>> => ({
  'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors ${origins.length === 0 ? "'none'" : origins.join(' ')}; base-uri 'none'`,
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});
