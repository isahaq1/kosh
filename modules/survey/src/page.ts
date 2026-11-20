/**
 * The public page of a survey (RFC 0034 §2.6): one self-contained document — no sign-in, no framework, nothing
 * loaded from elsewhere — that asks the questions, shows and hides those that wait for an answer, and sends what
 * was answered. It works with a keyboard and a screen reader, in light and dark, on a phone, in English and
 * Bangla. The page is for comfort: the server reviews every answer again.
 */
import type { SurveyPage } from './module.js';

const WORDS = {
  en: {
    send: 'Send',
    sending: 'Sending…',
    required: 'required',
    yes: 'Yes',
    no: 'No',
    name: 'Your name',
    email: 'Your email',
    anonymous: 'Your answers are anonymous: nothing that names you is kept.',
    thanks: 'Thank you — your answers are in.',
    failed: 'It could not be sent. Check your connection and try again.',
    fix: 'Some answers need another look:',
    unknown: 'This link does not open a survey.',
    closed: 'This survey is not taking answers.',
    used: 'This link was used already. Thank you.',
    of: 'of',
  },
  bn: {
    send: 'পাঠান',
    sending: 'পাঠানো হচ্ছে…',
    required: 'আবশ্যক',
    yes: 'হ্যাঁ',
    no: 'না',
    name: 'আপনার নাম',
    email: 'আপনার ইমেইল',
    anonymous: 'আপনার উত্তর বেনামি: আপনাকে চেনা যায় এমন কিছু রাখা হয় না।',
    thanks: 'ধন্যবাদ — আপনার উত্তর পাওয়া গেছে।',
    failed: 'পাঠানো যায়নি। সংযোগ দেখে আবার চেষ্টা করুন।',
    fix: 'কিছু উত্তর আবার দেখা দরকার:',
    unknown: 'এই লিংকে কোনো জরিপ নেই।',
    closed: 'এই জরিপ এখন উত্তর নিচ্ছে না।',
    used: 'এই লিংক আগেই ব্যবহৃত হয়েছে। ধন্যবাদ।',
    of: 'এর মধ্যে',
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
body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
h1{font-size:1.5rem;margin:0 0 .5rem}
fieldset{border:0;border-top:1px solid #8884;margin:0;padding:1rem 0}
legend,label.q{font-weight:600;padding:0;display:block;margin-bottom:.35rem}
.hint{color:#555;font-size:.9rem;margin:0 0 .4rem}
.req{color:#b91c1c;font-weight:400;font-size:.85rem}
input[type=text],input[type=number],input[type=date],input[type=email],textarea{font:inherit;width:100%;box-sizing:border-box;padding:.5rem;border:1px solid #888;border-radius:.4rem;background:transparent;color:inherit}
textarea{min-height:6rem}
.opt{display:block;padding:.2rem 0}
.scale{display:flex;flex-wrap:wrap;gap:.35rem}
.scale label{border:1px solid #888;border-radius:.4rem;padding:.35rem .7rem;cursor:pointer}
.scale input{position:absolute;opacity:0}
.scale input:checked+span{font-weight:700;text-decoration:underline}
.scale label:has(input:checked){background:#1d4ed8;color:#fff;border-color:#1d4ed8}
.scale label:has(input:focus-visible){outline:3px solid #f59e0b;outline-offset:2px}
button{font:inherit;padding:.6rem 1.4rem;border-radius:.5rem;border:1px solid #1d4ed8;background:#1d4ed8;color:#fff;cursor:pointer;margin-top:1rem}
button:disabled{opacity:.6;cursor:progress}
.bad{border-left:4px solid #b91c1c;padding-left:.75rem}
#out{margin-top:1rem}
#out ul{margin:.3rem 0;padding-left:1.2rem}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}.hint{color:#bbb}.req{color:#fca5a5}}
`;

/** The script of the page: renders the questions, follows the conditions, sends the answers. */
const SCRIPT = `
(function(){
var data=JSON.parse(document.getElementById('survey').textContent);
var S=data.page,W=data.words,form=document.getElementById('f'),out=document.getElementById('out');
function el(tag,attrs,text){var e=document.createElement(tag);for(var k in attrs||{})e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;return e}
function field(q){
  var id='q'+q.id,box=el(q.kind==='choice'||q.kind==='choices'||q.kind==='yes_no'||q.kind==='rating'||q.kind==='nps'?'fieldset':'div',{'data-q':q.id});
  var title=el(box.tagName==='FIELDSET'?'legend':'label',box.tagName==='FIELDSET'?{}:{'for':id,'class':'q'},q.title+' ');
  if(q.required)title.appendChild(el('span',{'class':'req'},'('+W.required+')'));
  box.appendChild(title);
  if(q.help)box.appendChild(el('p',{'class':'hint'},q.help));
  function radios(options,cls){var wrap=el('div',{'class':cls});options.forEach(function(o){var l=el('label',cls==='scale'?{}:{'class':'opt'});var i=el('input',{type:'radio',name:id,value:o.value});l.appendChild(i);l.appendChild(el('span',{},' '+o.label));wrap.appendChild(l)});box.appendChild(wrap)}
  if(q.kind==='text')box.appendChild(el('input',{type:'text',id:id,name:id,maxlength:'4000'}));
  else if(q.kind==='long_text')box.appendChild(el('textarea',{id:id,name:id,maxlength:'4000'}));
  else if(q.kind==='number')box.appendChild(el('input',{type:'number',id:id,name:id,step:'any',inputmode:'decimal'}));
  else if(q.kind==='date')box.appendChild(el('input',{type:'date',id:id,name:id}));
  else if(q.kind==='yes_no')radios([{value:'yes',label:W.yes},{value:'no',label:W.no}],'opts');
  else if(q.kind==='choice')radios(q.choices.map(function(c){return{value:String(c.id),label:c.label}}),'opts');
  else if(q.kind==='choices'){var wrap=el('div',{'class':'opts'});q.choices.forEach(function(c){var l=el('label',{'class':'opt'});l.appendChild(el('input',{type:'checkbox',name:id,value:String(c.id)}));l.appendChild(el('span',{},' '+c.label));wrap.appendChild(l)});box.appendChild(wrap)}
  else{var from=q.kind==='nps'?0:1,to=q.kind==='nps'?10:q.scaleMax,o=[];for(var n=from;n<=to;n++)o.push({value:String(n),label:String(n)});radios(o,'scale')}
  return box}
function read(q){
  var id='q'+q.id;
  if(q.kind==='choices'){var a=[];form.querySelectorAll('input[name="'+id+'"]:checked').forEach(function(i){a.push(Number(i.value))});return a}
  if(q.kind==='choice'||q.kind==='yes_no'||q.kind==='rating'||q.kind==='nps'){var c=form.querySelector('input[name="'+id+'"]:checked');if(!c)return null;return q.kind==='yes_no'?c.value:Number(c.value)}
  var v=form.querySelector('[name="'+id+'"]').value;return v.trim()===''?null:v}
function given(v){if(v==null)return[];if(Array.isArray(v))return v.map(String);return[String(v).trim()]}
function visible(){
  var seen={},before={};
  S.questions.forEach(function(q){
    var c=q.showWhen,ok=!c;
    if(c&&before[c.question]){
      var target=S.questions.filter(function(x){return x.id===c.question})[0],g=seen[c.question]?given(read(target)):[];
      if(c.op==='answered')ok=g.length>0;
      else if(c.op==='eq')ok=g.indexOf(c.value)>=0;
      else if(c.op==='ne')ok=g.length>0&&g.indexOf(c.value)<0;
      else if(c.op==='gt')ok=g.some(function(x){return Number(x)>Number(c.value)});
      else if(c.op==='lt')ok=g.some(function(x){return Number(x)<Number(c.value)})}
    seen[q.id]=ok;before[q.id]=true;
    form.querySelector('[data-q="'+q.id+'"]').hidden=!ok});
  return seen}
S.questions.forEach(function(q){form.insertBefore(field(q),form.lastElementChild)});
form.addEventListener('input',visible);form.addEventListener('change',visible);visible();
form.addEventListener('submit',function(e){
  e.preventDefault();
  var seen=visible(),answers={},button=form.querySelector('button');
  S.questions.forEach(function(q){if(seen[q.id]){var v=read(q);if(v!=null&&!(Array.isArray(v)&&v.length===0))answers[q.id]=v}});
  form.querySelectorAll('.bad').forEach(function(b){b.classList.remove('bad')});
  var body={answers:answers};
  if(S.askWho){body.name=document.getElementById('who').value;body.email=document.getElementById('mail').value}
  button.disabled=true;button.textContent=W.sending;out.textContent='';
  fetch(data.post,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  .then(function(r){return r.json().then(function(j){return{ok:r.ok,status:r.status,json:j}})})
  .then(function(r){
    if(r.ok){form.hidden=true;out.textContent=r.json.thanks||W.thanks;out.focus();return}
    button.disabled=false;button.textContent=W.send;
    if(r.status===422&&r.json.errors){
      out.textContent=W.fix;var list=el('ul');
      r.json.errors.forEach(function(x){list.appendChild(el('li',{},x.title+': '+x.problem));var b=form.querySelector('[data-q="'+x.question+'"]');if(b)b.classList.add('bad')});
      out.appendChild(list);out.focus();return}
    out.textContent=r.json.detail||W.failed;out.focus()})
  .catch(function(){button.disabled=false;button.textContent=W.send;out.textContent=W.failed;out.focus()})});
})();
`;

/** The document a visitor gets for a survey they may answer. */
export function renderSurvey(
  page: SurveyPage,
  options: { readonly post: string; readonly language: PageLanguage; readonly nonce: string },
): string {
  const words = WORDS[options.language];
  const who = page.askWho
    ? `<div><label class="q" for="who">${escapeHtml(words.name)}</label><input type="text" id="who" maxlength="120" autocomplete="name"></div>
<div style="margin-top:.75rem"><label class="q" for="mail">${escapeHtml(words.email)}</label><input type="email" id="mail" maxlength="200" autocomplete="email"></div>`
    : '';
  return `<!doctype html><html lang="${options.language}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(page.name)}</title><style>${STYLE}</style></head>
<body><main><h1>${escapeHtml(page.name)}</h1>
${page.description === null ? '' : `<p>${escapeHtml(page.description).replace(/\n/g, '<br>')}</p>`}
${page.anonymous ? `<p class="hint">${escapeHtml(words.anonymous)}</p>` : ''}
<form id="f" novalidate>${who}<button type="submit">${escapeHtml(words.send)}</button></form>
<div id="out" role="status" aria-live="polite" tabindex="-1"></div></main>
<script type="application/json" id="survey" nonce="${options.nonce}">${embed({ page, words, post: options.post })}</script>
<script nonce="${options.nonce}">${SCRIPT}</script></body></html>`;
}

/** The document for a link that opens nothing: unknown, closed, or used already. */
export function renderClosed(why: 'unknown' | 'closed' | 'used', language: PageLanguage): string {
  const words = WORDS[language];
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(words[why])}</title><style>${STYLE}</style></head>
<body><main><p role="status">${escapeHtml(words[why])}</p></main></body></html>`;
}

/** The headers of a public page: its own script and style only, never framed, never cached. */
export const pageSecurity = (nonce: string): Readonly<Record<string, string>> => ({
  'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});
