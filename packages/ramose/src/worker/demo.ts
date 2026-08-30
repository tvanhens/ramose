export const DEMO_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ramose demo</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font:15px/1.4 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
 h1{font-weight:600} h1 small{font-weight:400;color:#666;font-size:.6em}
 fieldset{border:1px solid #ddd;border-radius:8px;margin:1rem 0;padding:1rem}
 input,textarea,button{font:inherit} input,textarea{width:100%;box-sizing:border-box;padding:.4rem;margin:.2rem 0}
 button{padding:.4rem .8rem;border-radius:6px;border:1px solid #888;background:#f6f6f6;cursor:pointer} button:hover{background:#eee}
 table{width:100%;border-collapse:collapse} td,th{border-bottom:1px solid #eee;padding:.4rem;text-align:left;vertical-align:top}
 .muted{color:#777;font-size:.9em} pre{background:#f7f7f7;padding:.6rem;border-radius:6px;overflow:auto;font-size:.85em}
 .row{display:flex;gap:1rem;align-items:center} .row input[type=range]{flex:1}
</style></head><body>
<h1>Ramose <small>immutable, Datomic-inspired, on Cloudflare</small></h1>
<div class="row"><label>Database <input id="db" value="demo" style="width:10em"></label>
<button onclick="installSchema()">Install schema</button> <button onclick="refresh()">Refresh</button>
<span id="status" class="muted"></span></div>

<fieldset><legend>New note</legend>
<input id="title" placeholder="title"><textarea id="body" rows="3" placeholder="body"></textarea>
<button onclick="addNote()">Add note</button></fieldset>

<fieldset><legend>Notes <span id="asofLabel" class="muted"></span></legend>
<div class="row"><span class="muted">as of t:</span><input type="range" id="asof" min="1" max="1" value="1" oninput="onSlide()"><span id="asofT"></span>
<button onclick="latest()">latest</button></div>
<table><thead><tr><th>id</th><th>title</th><th>body</th><th>updated (tx)</th><th></th></tr></thead><tbody id="notes"></tbody></table>
</fieldset>

<fieldset><legend>History of note <span id="histId" class="muted"></span></legend><pre id="hist">click "history" on a note</pre></fieldset>
<fieldset><legend>Raw query</legend>
<textarea id="q" rows="3">[:find ?e ?title ?tx :where [?e :note/title ?title ?tx]]</textarea>
<button onclick="runQuery()">Run</button><pre id="qout"></pre></fieldset>

<script>
const $ = (id) => document.getElementById(id);
const api = (path, body) => fetch('/db/' + encodeURIComponent($('db').value) + path, body ? {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)} : undefined).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; });
let basisT = 1, asOf = null;
const status = (s) => $('status').textContent = s;

async function installSchema(){
  await api('/transact', { tx: [
    {':db/ident': ':note/title', ':db/valueType': ':db.type/string', ':db/cardinality': ':db.cardinality/one', ':db/index': true},
    {':db/ident': ':note/body',  ':db/valueType': ':db.type/string', ':db/cardinality': ':db.cardinality/one'},
  ]});
  status('schema installed'); refresh();
}
async function addNote(){
  const r = await api('/transact', { tx: [{':note/title': $('title').value, ':note/body': $('body').value}] });
  $('title').value = ''; $('body').value = ''; status('added at t=' + r.t); refresh();
}
async function editNote(e){
  const title = prompt('new title'); if (title === null) return;
  const r = await api('/transact', { tx: [[':db/add', e, ':note/title', title]] }); status('updated at t=' + r.t); refresh();
}
async function delNote(e){ const r = await api('/transact', { tx: [[':db/retractEntity', e]] }); status('deleted at t=' + r.t); refresh(); }
async function history(e){
  $('histId').textContent = e;
  const r = await api('/query', { history: true, query: '[:find ?tx ?a ?v ?op :in $ ?e :where [?e ?attr ?v ?tx ?op] [?attr :db/ident ?a]]', inputs: [e] });
  const rows = r.result.sort((x,y)=>x[0]-y[0]);
  $('hist').textContent = rows.map(([tx,a,v,op]) => (op?'+':'-') + ' t=' + (tx - 2**42) + ' ' + a + ' ' + JSON.stringify(v)).join('\\n') || '(no history)';
}
async function refresh(){
  const body = { query: '[:find ?e ?title ?body ?tx :where [?e :note/title ?title ?tx] [(get-else $ ?e :note/body "") ?body]]' };
  if (asOf !== null) body.asOf = asOf;
  let r;
  try { r = await api('/query', body); } catch (err) { status('error: ' + err.message); return; }
  basisT = r.t; $('asof').max = basisT; if (asOf === null) $('asof').value = basisT;
  $('asofT').textContent = asOf === null ? 'latest (t=' + basisT + ')' : 't=' + asOf;
  $('asofLabel').textContent = asOf === null ? '' : '(as of t=' + asOf + ')';
  const tb = $('notes'); tb.innerHTML = '';
  for (const [e, title, bodyText, tx] of r.result.sort((a,b)=>a[0]-b[0])) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + e + '</td><td>' + esc(title) + '</td><td>' + esc(bodyText) + '</td><td>' + (tx - 2**42) + '</td><td>' +
      '<button onclick="editNote(' + e + ')">edit</button> <button onclick="delNote(' + e + ')">delete</button> <button onclick="history(' + e + ')">history</button></td>';
    tb.appendChild(tr);
  }
  status('basis t=' + basisT + ' (' + r.result.length + ' notes)');
}
function onSlide(){ asOf = Number($('asof').value); refresh(); }
function latest(){ asOf = null; refresh(); }
async function runQuery(){ try { const r = await api('/query', { query: $('q').value }); $('qout').textContent = JSON.stringify(r.result, null, 1); } catch (e) { $('qout').textContent = 'error: ' + e.message; } }
const esc = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
refresh();
</script></body></html>`;
