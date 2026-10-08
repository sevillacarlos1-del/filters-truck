/* ==========================================================================
   TFCREDIT v1.0.0 — MÓDULO SIDECAR: CONTROL DE CLIENTES MOROSOS / CxC
   Truck Filters, c.a. — Sistema Comercial
   --------------------------------------------------------------------------
   PATRÓN: plugin autocontenido (sidecar) con acoplamiento por contrato.
   · NO edita el código principal: se carga DESPUÉS y se acopla mediante
     envolturas reversibles (decoradores) + inyección DOM observada.
   · NO muta la base del host (db): mantiene su PROPIA base en la clave
     de localStorage 'tf_credit_store_v1' (clientes + ledger de alertas).
   · Interfaz pública: window.TFCredit (ver tabla al final del archivo).
   · Desmontaje limpio: TFCredit.destroy() restaura todo el host.
   Requiere el host Truck Filters v2 cargado en el mismo documento.
   ========================================================================== */
;(() => {
'use strict';

/* ---------- Salvaguarda: detectar integración previa conflictiva ---------- */
if (typeof window.creditSnapshot === 'function' || typeof window.CSTATE === 'object') {
  console.warn('[TFCredit] Detectado un módulo de morosidad INTEGRADO en el archivo principal. Desactívalo (revierte esos fragmentos) para evitar doble validación. El sidecar no se activará.');
  return;
}

/* ==========================================================================
   1. IDENTIDAD, STORAGE PROPIO Y BUS DE EVENTOS
   ========================================================================== */
const VERSION     = '1.0.0';
const STORE_KEY   = 'tf_credit_store_v1';   // base propia — jamás toca tf_db_v2
const NAV_VIEW_ID = 'credit';               // id de vista dentro de ui.view

const state = { clients: [], ledger: [] };  // ledger = pedidos con alerta de crédito
const bus   = { map: {} };
const on    = (ev, cb) => { (bus.map[ev] = bus.map[ev] || []).push(cb); };
const emit  = (ev, payload) => { (bus.map[ev] || []).forEach(cb => { try { cb(payload); } catch(e){} }); };

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      state.clients = Array.isArray(d.clients) ? d.clients : [];
      state.ledger  = Array.isArray(d.ledger)  ? d.ledger  : [];
      return;
    }
  } catch(e){}
  state.clients = []; state.ledger = [];
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch(e){ console.error('[TFCredit] No se pudo persistir el store propio:', e); }
  emit('store:changed');
}

/* ==========================================================================
   2. UTILIDADES AUTÓNOMAS (no dependen del host para funcionar)
   ========================================================================== */
const esc   = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const money = n => '$' + Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const round2= v => Math.round(v * 100) / 100;
const normRif = r => String(r||'').trim().toUpperCase().replace(/\s/g,'').replace(/^([JVGPE])-?(\d{8})-?(\d)$/, '$1-$2-$3');
const RIF_OK  = r => /^[JVGPE]-\d{8}-\d$/.test(normRif(r));
const fDT   = ts => new Date(ts).toLocaleDateString('es-VE',{day:'2-digit',month:'2-digit',year:'2-digit'}) + ' · ' + new Date(ts).toLocaleTimeString('es-VE',{hour:'2-digit',minute:'2-digit'});

/* Toast y confirmación: usa las APIs del host si existen (contrato), con
   fallback nativo si el host no las expone. */
function say(msg, type='info', ms=3600) {
  if (typeof window.toast === 'function') { window.toast(msg, type, ms); return; }
  console.log('[TFCredit]', type, msg.replace(/<[^>]*>/g,''));
}
function askConfirm(title, html, okLabel, onOk, danger=false) {
  if (typeof window.confirmDialog === 'function') { window.confirmDialog(title, html, okLabel, onOk, danger); return; }
  if (window.confirm(title.replace(/<[^>]*>/g,'') + '\n' + html.replace(/<[^>]*>/g,''))) onOk();
}

const CSTATE = {
  ok:        { l:'Cuenta al día',    chip:'bg-emerald-50 text-emerald-800 border-emerald-300', ic:'fa-circle-check' },
  moroso:    { l:'Saldo pendiente',  chip:'bg-amber-50 text-amber-800 border-amber-300',       ic:'fa-triangle-exclamation' },
  bloqueado: { l:'Cuenta bloqueada', chip:'bg-red-50 text-red-800 border-red-300',             ic:'fa-ban' },
};

/* ==========================================================================
   3. NÚCLEO DE DOMINIO: clientes, snapshots, abonos, ledger
   ========================================================================== */
const byRif = rif => { const n = normRif(rif); return n ? state.clients.find(c => c.rif === n) || null : null; };
const oldestDays = c => ((c.credit && c.credit.overdueInvoices) || []).reduce((m,i)=>Math.max(m, i.days||0), 0);

function snapshot(rif) {
  const c = byRif(rif);
  if (!c || !c.credit) return { registered:false, state:'ok', balance:0, days:0, invCount:0, limit:0, name:'' };
  return {
    registered:true, state:c.credit.state,
    balance:round2(c.credit.balance||0), days:oldestDays(c),
    invCount:(c.credit.overdueInvoices||[]).length,
    limit:c.credit.limit||0, name:c.name
  };
}
function kpi() {
  const total = state.clients.reduce((a,c)=>a+(c.credit.state!=='ok'?round2(c.credit.balance):0),0);
  return {
    total: round2(total),
    morosos:    state.clients.filter(c=>c.credit.state==='moroso').length,
    bloqueados: state.clients.filter(c=>c.credit.state==='bloqueado').length,
    clientes:   state.clients.length
  };
}
/* Crea o actualiza una cuenta. Devuelve {ok, error?, client?} */
function upsertClient(data) {
  const rif = normRif(data.rif);
  if (!RIF_OK(rif)) return { ok:false, error:'RIF inválido (formato J-30123456-7).' };
  if (!data.name || !String(data.name).trim()) return { ok:false, error:'La razón social es obligatoria.' };
  const bal = Math.max(0, round2(parseFloat(data.balance)||0));
  const lim = Math.max(0, round2(parseFloat(data.limit)||0));
  let cst = ['ok','moroso','bloqueado'].includes(data.state) ? data.state : 'ok';
  if (bal <= 0 && cst === 'moroso') cst = 'ok';
  const invs = (Array.isArray(data.invoices) ? data.invoices : [])
    .map(i => ({ number:String(i.number||'').trim(), days:Math.max(0, parseInt(i.days)||0), amount:Math.max(0, round2(parseFloat(i.amount)||0)) }))
    .filter(i => i.number && i.amount > 0);
  let c = byRif(rif);
  if (c) {
    Object.assign(c, { name:String(data.name).trim(), contact:String(data.contact||'').trim(), phone:String(data.phone||'').trim() });
    Object.assign(c.credit, { state:cst, balance:bal, limit:lim, overdueInvoices:invs });
  } else {
    c = { rif, name:String(data.name).trim(), contact:String(data.contact||'').trim(), phone:String(data.phone||'').trim(),
          credit:{ state:cst, balance:bal, limit:lim, overdueInvoices:invs, payments:[] } };
    state.clients.push(c);
  }
  save(); emit('client:updated', { rif });
  return { ok:true, client:c };
}
function removeClient(rif) {
  const c = byRif(rif); if (!c) return false;
  state.clients = state.clients.filter(x => x !== c);
  save(); emit('client:updated', { rif }); return true;
}
function setState(rif, newState) {
  const c = byRif(rif); if (!c || !CSTATE[newState]) return false;
  c.credit.state = newState;
  save(); emit('client:updated', { rif }); return true;
}
/* Abono con aplicación FIFO a la factura más antigua. Devuelve {ok, error? | applied, remaining} */
function registerPayment(rif, amount, ref='') {
  const c = byRif(rif); if (!c) return { ok:false, error:'Cliente no encontrado.' };
  const amt = round2(parseFloat(amount));
  if (isNaN(amt) || amt <= 0) return { ok:false, error:'Monto de abono inválido.' };
  if (c.credit.balance <= 0)  return { ok:false, error:'La cuenta no registra saldo pendiente.' };
  if (amt > round2(c.credit.balance) + 0.005) return { ok:false, error:'El abono excede el saldo pendiente.' };
  let rest = amt;
  const invs = (c.credit.overdueInvoices||[]).slice().sort((a,b)=>b.days - a.days);
  while (rest > 0.004 && invs.length) {
    const inv = invs[0];
    if (rest >= inv.amount - 0.004) { rest = round2(rest - inv.amount); invs.shift(); }
    else { inv.amount = round2(inv.amount - rest); rest = 0; }
  }
  c.credit.overdueInvoices = invs;
  c.credit.balance = round2(Math.max(0, c.credit.balance - amt));
  c.credit.payments = c.credit.payments || [];
  c.credit.payments.unshift({ ts:Date.now(), amount:amt, ref:String(ref||'').trim() });
  if (c.credit.payments.length > 20) c.credit.payments.length = 20;
  if (c.credit.balance <= 0.004) { c.credit.balance = 0; c.credit.state = 'ok'; }
  save(); emit('payment:registered', { rif, amount:amt, remaining:c.credit.balance });
  return { ok:true, applied:amt, remaining:c.credit.balance };
}
/* Ledger: fotografía de mora adjunta a un pedido por su NÚMERO (sin mutar el pedido) */
const ledgerFor = orderNumber => state.ledger.find(l => l.orderNumber === orderNumber) || null;
function flagOrder(orderNumber, snap) {
  if (!orderNumber || !snap.registered || snap.state === 'ok') return;
  if (ledgerFor(orderNumber)) return;
  state.ledger.unshift({ orderNumber, rif:snap.rif || '', name:snap.name || '', state:snap.state, balance:snap.balance, days:snap.days, ts:Date.now() });
  if (state.ledger.length > 200) state.ledger.length = 200;
  save(); emit('order:flagged', { orderNumber });
}
/* Importa clientes descubiertos en los pedidos del host (SOLO LECTURA de db) */
function importFromOrders() {
  if (!window.db || !Array.isArray(window.db.orders)) return { imported:0, skipped:0 };
  let imported = 0, skipped = 0;
  const seen = {};
  window.db.orders.forEach(o => {
    const rif = normRif(o.client && o.client.rif);
    if (!rif || !RIF_OK(rif)) return;
    if (seen[rif]) return; seen[rif] = 1;
    if (byRif(rif)) { skipped++; return; }
    state.clients.push({
      rif, name:o.client.name || '', contact:o.client.contact || '', phone:o.client.phone || '',
      credit:{ state:'ok', balance:0, limit:0, overdueInvoices:[], payments:[] }
    });
    imported++;
  });
  if (imported) { save(); emit('client:updated', {}); }
  return { imported, skipped };
}
/* Datos de demostración — solo si la cartera está vacía y con confirmación */
function seedDemo() {
  if (state.clients.length) { say('La cartera ya tiene cuentas registradas.','warn'); return; }
  const demo = [
    { rif:'J-30184726-5', name:'Distribuidora Los Andes, C.A.', contact:'José Pérez', phone:'0414-5523311', state:'moroso', balance:845.60, limit:2500,
      invoices:[{number:'FA-1187',days:47,amount:520.10},{number:'FA-1203',days:12,amount:325.50}] },
    { rif:'J-30678210-4', name:'Fletes La Pradera, C.A.', contact:'Alfredo Márquez', phone:'0414-9874502', state:'bloqueado', balance:1870.25, limit:2000,
      invoices:[{number:'FA-1093',days:96,amount:1120.25},{number:'FA-1155',days:61,amount:750.00}] },
    { rif:'G-20012458-1', name:'Transporte El Samán, C.A.', contact:'Ramón Utrera', phone:'0412-6337741', state:'ok', balance:0, limit:3000, invoices:[] },
    { rif:'J-40555123-9', name:'Repuestos El Trigal', contact:'María Salazar', phone:'0424-4189902', state:'ok', balance:0, limit:1500, invoices:[] },
  ];
  demo.forEach(d => upsertClient(d));
  say('Cartera de demostración cargada: 4 cuentas (2 con deuda, 1 bloqueada).','ok');
}

/* ==========================================================================
   4. CONSTRUCTORES DE UI (chips, banners, notas — nodos marcados con data-tfc)
   ========================================================================== */
function chipHTML(s) {
  if (!s.registered) return '';
  const m = CSTATE[s.state];
  return `<span class="tag ${m.chip}"><i class="fa-solid ${m.ic}"></i>${m.l}${s.state!=='ok' ? ` · ${money(s.balance)}` : ''}</span>`;
}
function bannerHTML(s) {
  if (!s.registered || s.state === 'ok') return '';
  const bad = s.state === 'bloqueado';
  const usedPct = s.limit ? Math.min(100, Math.round(s.balance / s.limit * 100)) : 0;
  return `
  <div data-tfc="banner" class="border-2 ${bad ? 'border-red-600 bg-red-50' : 'border-acc-dark bg-acc-soft'} rounded-sm p-4 flex items-start gap-3">
    <span class="w-10 h-10 shrink-0 grid place-items-center rounded-sm ${bad ? 'bg-red-600 text-white' : 'bg-acc text-navy-950'}"><i class="fa-solid ${bad ? 'fa-ban' : 'fa-triangle-exclamation'} text-lg"></i></span>
    <div class="min-w-0 flex-1">
      <p class="font-disp uppercase tracking-wider text-sm font-semibold ${bad ? 'text-red-800' : 'text-navy-900'}">${bad ? 'Cuenta bloqueada por crédito' : 'Cliente con saldo pendiente'}</p>
      <p class="text-xs leading-relaxed mt-1 ${bad ? 'text-red-900' : 'text-navy-800'}"><b class="font-mono text-base">${money(s.balance)}</b> adeudados en <b>${s.invCount} factura${s.invCount!==1?'s':''}</b> vencida${s.invCount!==1?'s':''} — mora más antigua: <b>${s.days} días</b>.${s.limit ? ` Cupo: ${money(s.limit)} · utilizado ${usedPct}%.` : ''}</p>
      <p class="text-[11px] mt-1.5 font-disp uppercase tracking-wider ${bad ? 'text-red-700' : 'text-acc-dark'}"><i class="fa-solid ${bad ? 'fa-lock' : 'fa-user-shield'} mr-1"></i>${bad ? 'No es posible registrar pedidos para esta cuenta. Coordine el pago con oficina central.' : 'El pedido quedará sujeto a revisión administrativa antes del despacho.'}</p>
    </div>
  </div>`;
}
function summaryNoteHTML(s) {
  if (!s.registered || s.state === 'ok') return '';
  const bad = s.state === 'bloqueado';
  return `
  <div data-tfc="summary-note" class="border border-dashed ${bad ? 'border-red-400 bg-red-50 text-red-800' : 'border-acc-dark bg-acc-soft text-navy-800'} rounded-sm p-3 text-[11px] leading-relaxed">
    <i class="fa-solid fa-triangle-exclamation text-acc-dark mr-1"></i><b>Nota de crédito:</b> saldo pendiente de <b class="font-mono">${money(s.balance)}</b> (${s.days} días de mora).${bad ? ' <b>Cuenta bloqueada:</b> no se puede generar el pedido.' : ' El pedido se registrará sujeto a revisión administrativa.'}
  </div>`;
}
function flagTag(entry) {
  const bad = entry.state === 'bloqueado';
  return `<span class="tag ${bad?'bg-red-50 text-red-700 border-red-300':'bg-amber-50 text-amber-800 border-amber-300'}" data-tfc="flag" title="Módulo de crédito: saldo al registro ${money(entry.balance)} · ${entry.days} días"><i class="fa-solid fa-triangle-exclamation"></i>Crédito</span>`;
}
function receiptNoteHTML(entry) {
  const bad = entry.state === 'bloqueado';
  return `
  <div data-tfc="receipt" class="border-2 border-dashed ${bad?'border-red-500 bg-red-50':'border-acc-dark bg-acc-soft'} rounded-sm p-3.5 flex items-start gap-3">
    <i class="fa-solid ${bad?'fa-ban':'fa-triangle-exclamation'} ${bad?'text-red-600':'text-acc-dark'} mt-0.5"></i>
    <div class="text-xs leading-relaxed flex-1">
      <p class="font-disp uppercase tracking-wider font-semibold ${bad?'text-red-800':'text-navy-900'}">Nota de crédito — sujeto a revisión administrativa</p>
      <p class="mt-0.5 text-navy-800">Al momento del registro (${fDT(entry.ts)}): saldo <b class="font-mono">${money(entry.balance)}</b> · ${entry.days} días de mora. Este pedido no será despachado hasta la revisión y autorización de oficina central.</p>
    </div>
  </div>`;
}
function navBtnHTML(kind) {
  const isAside = kind === 'aside';
  return `<button type="button" data-tfc="nav" data-tfckind="${kind}" onclick="TFCredit.openCreditView()" class="${isAside
    ? 'nav-item w-full flex items-center gap-3 px-3 py-2.5 rounded-sm text-sm transition'
    : 'nav-item relative flex-1 min-w-0 flex flex-col items-center gap-1 py-2.5 transition'}">
    <i class="fa-solid fa-hand-holding-dollar ${isAside?'w-5 text-center':'text-lg'}"></i><span class="font-disp uppercase tracking-wider ${isAside?'':'text-[10px] truncate max-w-full px-0.5'}">CxC</span></button>`;
}

/* ==========================================================================
   5. INYECCIÓN DOM OBSERVADA (idempotente — el corazón del acoplamiento)
   ========================================================================== */
let observer = null, enrichTimer = null;
const scheduleEnrich = () => { clearTimeout(enrichTimer); enrichTimer = setTimeout(enrich, 60); };

function enrich() {
  try {
    cleanupIfLoggedOut();
    injectAdminNav();
    enrichCart();
    refreshModuleNavState();
  } catch(e){ console.error('[TFCredit] enrich:', e); }
}
function cleanupIfLoggedOut() {
  if (!window.session) document.querySelectorAll('[data-tfc]').forEach(n => n.remove());
}
function injectAdminNav() {
  if (!window.session || window.session.role !== 'admin') return;
  const asideNav = document.querySelector('aside nav');
  if (asideNav && !asideNav.querySelector('[data-tfc="nav"]')) asideNav.insertAdjacentHTML('beforeend', navBtnHTML('aside'));
  const tabBar = document.querySelector('nav.lg\\:hidden > div');
  if (tabBar && !tabBar.querySelector('[data-tfc="nav"]')) {
    tabBar.insertAdjacentHTML('beforeend', navBtnHTML('tab'));
    /* Reparte la barra en columnas iguales al añadir la 5ª pestaña (solo DOM) */
    try {
      tabBar.style.display = 'flex';
      tabBar.querySelectorAll(':scope > button').forEach(b => { b.style.flex = '1 1 0'; b.style.minWidth = '0'; });
    } catch(e){}
  }
}
function refreshModuleNavState() {
  const on = !!(window.ui && window.ui.view === NAV_VIEW_ID);
  document.querySelectorAll('[data-tfc="nav"]').forEach(b => {
    const aside = b.dataset.tfckind === 'aside';
    b.className = aside
      ? 'nav-item w-full flex items-center gap-3 px-3 py-2.5 rounded-sm text-sm transition ' + (on ? 'bg-acc text-navy-950 font-semibold' : 'text-steel-200 hover:bg-white/10')
      : 'nav-item relative flex-1 min-w-0 flex flex-col items-center gap-1 py-2.5 transition ' + (on ? 'text-acc' : 'text-steel-300');
  });
}
/* Carrito del vendedor: chip bajo el RIF + banner + nota de resumen + botón */
function enrichCart() {
  const form = document.getElementById('client-form');
  if (!form || !window.session || window.session.role !== 'seller') return;
  const rifEl = document.getElementById('cl-rif');
  if (!rifEl) return;

  /* Chip junto al RIF */
  let chipWrap = document.getElementById('tfc-rif-chip');
  if (!chipWrap) {
    chipWrap = document.createElement('div');
    chipWrap.id = 'tfc-rif-chip'; chipWrap.dataset.tfc = 'chip'; chipWrap.className = 'mt-1.5';
    rifEl.insertAdjacentElement('afterend', chipWrap);
  }
  /* Banner tras el formulario */
  let banner = document.getElementById('tfc-cart-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'tfc-cart-banner'; banner.dataset.tfc = 'banner'; banner.className = 'px-5 pb-5';
    form.insertAdjacentElement('afterend', banner);
  }
  /* Nota en el resumen (después del <dl> del panel sticky) */
  const dl = document.querySelector('#view .lg\\:sticky dl');
  let note = document.getElementById('tfc-summary-note');
  if (dl && !note) {
    note = document.createElement('div');
    note.id = 'tfc-summary-note'; note.dataset.tfc = 'note'; note.className = 'mt-3';
    dl.insertAdjacentElement('afterend', note);
  }
  /* Enganche de la validación en vivo (una sola vez por nodo) */
  if (!rifEl.dataset.tfcBound) {
    rifEl.dataset.tfcBound = '1';
    rifEl.addEventListener('input', () => { autocompleteClient(rifEl.value); scheduleEnrich(); });
  }
  /* Pintado según el estado actual del RIF */
  const s = snapshot(rifEl.value);
  chipWrap.innerHTML = chipHTML(s);
  banner.innerHTML   = bannerHTML(s);
  if (note) note.innerHTML = summaryNoteHTML(s);
  /* Control del botón de generación */
  const btn = document.querySelector('button[onclick="generateOrder()"]');
  if (btn) {
    const blocked = s.registered && s.state === 'bloqueado';
    btn.disabled = blocked;
    btn.title = blocked ? 'Cuenta bloqueada por Administración' : '';
  }
}
/* Autocompleta datos del cliente registrado en campos vacíos del formulario */
function autocompleteClient(rif) {
  const c = byRif(rif); if (!c) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el && !el.value.trim()) el.value = val; };
  set('cl-name', c.name); set('cl-contact', c.contact || ''); set('cl-phone', c.phone || '');
}
/* Comprobante (modal): inyecta la nota de crédito si el pedido está en el ledger */
function injectReceiptNote() {
  const modal = document.getElementById('modal-root');
  if (!modal || !modal.firstElementChild) return;
  if (modal.querySelector('[data-tfc="receipt"]')) return;
  const numEl = modal.querySelector('.font-mono.font-bold.text-xl, .font-mono.font-bold.text-2xl');
  const number = numEl ? numEl.textContent.trim() : '';
  const entry = ledgerFor(number);
  if (!entry) return;
  const table = modal.querySelector('table');
  if (table) table.insertAdjacentHTML('beforebegin', receiptNoteHTML(entry));
}
/* Nota dentro del HTML de impresión (inserción por ancla de string) */
function injectPrintNote(html, order) {
  const entry = ledgerFor(order && order.number);
  if (!entry) return html;
  const bad = entry.state === 'bloqueado';
  const block = `
  <table style="width:100%;margin-top:10px;border-collapse:collapse;">
    <tr><td style="border:2px dashed ${bad?'#dc2626':'#C98A00'};background:${bad?'#fef2f2':'#FFF3D6'};padding:10px 12px;font-size:11px;line-height:1.5;color:#0B1E36;">
      <b style="font-family:Oswald,sans-serif;letter-spacing:1.5px;font-size:10px;color:${bad?'#dc2626':'#C98A00'};">NOTA DE CRÉDITO — SUJETO A REVISIÓN ADMINISTRATIVA</b><br>
      Al momento del registro: <b>saldo pendiente de ${money(entry.balance)}</b> con <b>${entry.days} días</b> de mora. Este documento no autoriza el despacho hasta la revisión y aprobación de la administración.
    </td></tr>
  </table>`;
  const anchor = '<table style="width:100%;font-size:12px;';
  const i = html.indexOf(anchor);
  return i < 0 ? html + block : html.slice(0, i) + block + html.slice(i);
}

/* ==========================================================================
   6. VISTA CxC DEL MÓDULO (panel administrativo propio, enrutada por el host)
   ========================================================================== */
const viewQ = { q:'' };
function openCreditView() {
  if (!window.ui || !window.session || window.session.role !== 'admin') return;
  window.ui.view = NAV_VIEW_ID;                     // única escritura al estado del host
  if (typeof window.closeModal === 'function') window.closeModal();
  window.renderView(); window.setNav(); window.setTitle();
  window.scrollTo({ top:0 });
}
function paintCreditView() {
  const v = document.getElementById('view'); if (!v) return;
  const k = kpi();
  v.innerHTML = `
  <section class="max-w-6xl mx-auto p-4 lg:p-8">
    <div class="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div>
        <p class="kicker">Módulo de crédito · v${VERSION} · datos independientes del sistema principal</p>
        <h2 class="sec-title mt-1">Cuentas por cobrar y control de morosidad</h2>
      </div>
      <div class="relative w-64">
        <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-steel-400 text-sm"></i>
        <input value="${esc(viewQ.q)}" oninput="TFCredit.filter(this.value)" class="input !pl-10 !py-2" placeholder="Buscar cliente o RIF…">
      </div>
    </div>
    <div class="card grid grid-cols-3 divide-x divide-steel-200 overflow-hidden mb-5">
      <div class="p-5"><p class="kicker"><i class="fa-solid fa-sack-dollar text-acc-dark mr-1"></i>Total por cobrar</p><p class="font-mono font-bold text-2xl text-navy-900 mt-1">${money(k.total)}</p></div>
      <div class="p-5"><p class="kicker"><i class="fa-solid fa-triangle-exclamation text-acc-dark mr-1"></i>Cuentas en mora</p><p class="font-mono font-bold text-2xl text-acc-dark mt-1">${k.morosos}</p></div>
      <div class="p-5"><p class="kicker"><i class="fa-solid fa-ban text-acc-dark mr-1"></i>Bloqueadas</p><p class="font-mono font-bold text-2xl text-red-600 mt-1">${k.bloqueados}</p></div>
    </div>
    <div class="flex flex-wrap gap-2 mb-5">
      <button onclick="TFCredit.openEdit(null)" class="btn-amber"><i class="fa-solid fa-user-plus"></i> Agregar cuenta</button>
      <button onclick="TFCredit.doImport()" class="btn-line"><i class="fa-solid fa-file-import"></i> Importar de pedidos</button>
      ${state.clients.length === 0 ? `<button onclick="TFCredit.doSeedDemo()" class="btn-navy"><i class="fa-solid fa-wand-magic-sparkles"></i> Cargar datos de demostración</button>` : ''}
      <span class="ml-auto text-[11px] text-steel-400 self-center font-mono">storage: ${STORE_KEY}</span>
    </div>
    <div class="card overflow-hidden"><div id="tfc-clients-table">${creditTable()}</div></div>
  </section>`;
}
function creditTable() {
  const q = viewQ.q.trim().toLowerCase();
  const list = state.clients
    .filter(c => !q || c.name.toLowerCase().includes(q) || c.rif.toLowerCase().includes(q))
    .slice().sort((a,b) => (b.credit.state==='ok'?0:b.credit.balance) - (a.credit.state==='ok'?0:a.credit.balance));
  if (!list.length) return `
    <div class="p-10 text-center text-sm text-steel-500">
      <i class="fa-solid fa-address-book text-3xl text-steel-300 block mb-3"></i>
      ${state.clients.length ? 'Sin resultados para la búsqueda.' : 'Cartera vacía. Agregue cuentas manualmente, impórtelas desde los pedidos o cargue los datos de demostración.'}
    </div>`;
  return `<div class="overflow-x-auto"><table class="w-full min-w-[780px]">
    <thead><tr><th class="th">Cliente</th><th class="th">Estatus</th><th class="th text-right">Saldo pendiente</th><th class="th text-right">Mora más antigua</th><th class="th">Uso del cupo</th><th class="th text-right">Acciones</th></tr></thead>
    <tbody>${list.map(c => {
      const m = CSTATE[c.credit.state];
      const days = oldestDays(c);
      const pct = c.credit.limit ? Math.min(100, Math.round(c.credit.balance / c.credit.limit * 100)) : 0;
      return `<tr class="hover:bg-steel-50">
        <td class="td"><p class="font-semibold text-navy-900 leading-tight">${esc(c.name)}</p><p class="font-mono text-[11px] text-steel-500">${esc(c.rif)} · ${esc(c.contact)} · ${esc(c.phone)}</p></td>
        <td class="td"><span class="tag ${m.chip}"><i class="fa-solid ${m.ic}"></i>${m.l}</span></td>
        <td class="td text-right font-mono font-bold ${c.credit.balance>0?'text-navy-900':'text-emerald-700'}">${money(c.credit.balance)}</td>
        <td class="td text-right font-mono ${days?'text-acc-dark font-semibold':''}">${days ? days + ' días' : '—'}</td>
        <td class="td w-40"><div class="h-2 bg-steel-100 rounded-full overflow-hidden"><div class="h-full ${pct>=90?'bg-red-500':pct>=60?'bg-acc':'bg-emerald-600'}" style="width:${pct}%"></div></div><p class="text-[10px] text-steel-500 font-mono mt-1">${money(c.credit.balance)} / ${money(c.credit.limit||0)}</p></td>
        <td class="td text-right whitespace-nowrap">
          <button onclick="TFCredit.openPayment('${c.rif}')" class="btn-navy !px-3 !py-1.5 !text-xs"><i class="fa-solid fa-hand-holding-dollar"></i> Abono</button>
          <button onclick="TFCredit.openEdit('${c.rif}')" class="btn-line !px-3 !py-1.5 !text-xs ml-1" title="Editar"><i class="fa-solid fa-pen"></i></button>
          <button onclick="TFCredit.toggleBlock('${c.rif}')" class="btn-line !px-3 !py-1.5 !text-xs ml-1" title="${c.credit.state==='bloqueado'?'Habilitar':'Bloquear'}"><i class="fa-solid ${c.credit.state==='bloqueado'?'fa-unlock':'fa-lock'}"></i></button>
          <button onclick="TFCredit.confirmRemove('${c.rif}')" class="btn-line !px-3 !py-1.5 !text-xs ml-1 text-red-700" title="Eliminar"><i class="fa-solid fa-trash-can"></i></button>
        </td></tr>`;
    }).join('')}</tbody></table></div>`;
}
function refreshCreditTable() { const el = document.getElementById('tfc-clients-table'); if (el) el.innerHTML = creditTable(); }

/* ---- Modales de gestión (usan openModal del host) ---- */
function openEdit(rif) {
  if (typeof window.openModal !== 'function') return;
  const c = rif ? byRif(rif) : null;
  const invText = c ? (c.credit.overdueInvoices||[]).map(i => `${i.number}, ${i.days}, ${i.amount}`).join('\n') : '';
  window.openModal(`
    <div class="p-6">
      <div class="flex items-center gap-3 mb-5"><span class="w-10 h-10 grid place-items-center rounded-sm bg-navy-900 text-acc"><i class="fa-solid fa-hand-holding-dollar"></i></span>
        <div><p class="kicker">Módulo de crédito · ${c ? 'editar cuenta' : 'nueva cuenta'}</p>
        <p class="font-disp font-semibold uppercase tracking-wide text-lg">${c ? esc(c.name) : 'Registro de cliente'}</p></div></div>
      <div class="grid sm:grid-cols-2 gap-4">
        <div><label class="lbl">RIF *</label><input id="tfc-f-rif" value="${c?esc(c.rif):''}" ${c?'readonly class="input font-mono bg-steel-50"':'class="input font-mono"'} placeholder="J-30123456-7"></div>
        <div><label class="lbl">Razón social *</label><input id="tfc-f-name" value="${c?esc(c.name):''}" class="input" placeholder="Nombre de la empresa"></div>
        <div><label class="lbl">Contacto</label><input id="tfc-f-contact" value="${c?esc(c.contact):''}" class="input" placeholder="Persona de contacto"></div>
        <div><label class="lbl">Teléfono</label><input id="tfc-f-phone" value="${c?esc(c.phone):''}" class="input font-mono" placeholder="0414-0000000"></div>
        <div><label class="lbl">Cupo de crédito (USD)</label><input id="tfc-f-limit" type="number" step="0.01" min="0" value="${c?c.credit.limit:0}" class="input font-mono"></div>
        <div><label class="lbl">Saldo pendiente (USD)</label><input id="tfc-f-balance" type="number" step="0.01" min="0" value="${c?c.credit.balance:0}" class="input font-mono"></div>
        <div><label class="lbl">Estatus de cuenta</label>
          <select id="tfc-f-state" class="input">
            ${Object.entries(CSTATE).map(([k,m]) => `<option value="${k}" ${c && c.credit.state===k ? 'selected':''}>${m.l}</option>`).join('')}
          </select></div>
        <div class="sm:col-span-2"><label class="lbl">Facturas vencidas — una por línea: número, días, monto</label>
          <textarea id="tfc-f-inv" rows="3" class="input font-mono text-xs" placeholder="FA-1187, 47, 520.10">${esc(invText)}</textarea></div>
      </div>
      <div class="flex justify-end gap-2 mt-5">
        <button type="button" ${typeof window.closeModal==='function'?'onclick="closeModal()"':''} class="btn-line">Cancelar</button>
        <button class="btn-navy" onclick="TFCredit.saveEdit('${c?c.rif:''}')"><i class="fa-solid fa-floppy-disk"></i> Guardar cuenta</button>
      </div>
    </div>`);
}
function saveEdit(originalRif) {
  const g = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const res = upsertClient({
    rif: originalRif || g('tfc-f-rif'), name: g('tfc-f-name'), contact: g('tfc-f-contact'), phone: g('tfc-f-phone'),
    limit: g('tfc-f-limit'), balance: g('tfc-f-balance'), state: g('tfc-f-state'),
    invoices: g('tfc-f-inv').split('\n').map(line => {
      const p = line.split(',').map(x => x.trim());
      return { number:p[0]||'', days:parseInt(p[1])||0, amount:parseFloat(p[2])||0 };
    })
  });
  if (!res.ok) { say(esc(res.error), 'warn'); return; }
  if (typeof window.closeModal === 'function') window.closeModal();
  say(`Cuenta de <b>${esc(res.client.name)}</b> guardada en el módulo de crédito.`, 'ok');
  if (window.ui && window.ui.view === NAV_VIEW_ID) paintCreditView(); else enrich();
}
function openPayment(rif) {
  if (typeof window.openModal !== 'function') return;
  const c = byRif(rif); if (!c) return;
  if (c.credit.balance <= 0) { say('Esta cuenta no registra saldo pendiente.','info'); return; }
  window.openModal(`
    <div class="p-6">
      <div class="flex items-center gap-3 mb-1"><span class="w-10 h-10 grid place-items-center rounded-sm bg-navy-900 text-acc"><i class="fa-solid fa-hand-holding-dollar"></i></span>
        <div><p class="kicker">Registro de abono · módulo de crédito</p><p class="font-semibold text-navy-900">${esc(c.name)}</p><p class="font-mono text-[11px] text-steel-500">${esc(c.rif)}</p></div></div>
      <div class="mt-4 border border-steel-200 rounded-sm p-3 text-sm">
        <div class="flex justify-between"><span class="text-steel-500">Saldo actual</span><b class="font-mono">${money(c.credit.balance)}</b></div>
        ${(c.credit.overdueInvoices||[]).map(i => `<div class="flex justify-between text-xs text-steel-500 mt-1"><span class="font-mono">${esc(i.number)}</span><span>${i.days} días · <b class="font-mono text-navy-800">${money(i.amount)}</b></span></div>`).join('')}
        ${(c.credit.payments||[]).slice(0,3).map(p => `<div class="flex justify-between text-xs text-emerald-700 mt-1 border-t border-dashed border-steel-200 pt-1"><span><i class="fa-solid fa-check mr-1"></i>Abono ${fDT(p.ts)}${p.ref?' · '+esc(p.ref):''}</span><b class="font-mono">−${money(p.amount)}</b></div>`).join('')}
      </div>
      <div class="grid grid-cols-2 gap-4 mt-4">
        <div><label class="lbl">Monto del abono (USD)</label><input id="tfc-p-amt" type="number" step="0.01" min="0.01" max="${c.credit.balance}" value="${c.credit.balance}" class="input font-mono"></div>
        <div><label class="lbl">Referencia / método</label><input id="tfc-p-ref" class="input" placeholder="Transferencia, cheque, efectivo…"></div>
      </div>
      <p class="text-[11px] text-steel-500 mt-3">Aplicación FIFO a la factura más antigua. Si el saldo llega a cero, la cuenta vuelve automáticamente a <b>al día</b>.</p>
      <div class="flex justify-end gap-2 mt-5">
        <button type="button" ${typeof window.closeModal==='function'?'onclick="closeModal()"':''} class="btn-line">Cancelar</button>
        <button class="btn-ok" onclick="TFCredit.doPayment('${c.rif}')"><i class="fa-solid fa-check"></i> Registrar abono</button>
      </div>
    </div>`);
}
function doPayment(rif) {
  const amt = document.getElementById('tfc-p-amt'), ref = document.getElementById('tfc-p-ref');
  const res = registerPayment(rif, amt ? amt.value : '', ref ? ref.value : '');
  if (!res.ok) { say(esc(res.error), 'warn'); return; }
  if (typeof window.closeModal === 'function') window.closeModal();
  const c = byRif(rif);
  say(`Abono de <b>${money(res.applied)}</b> registrado. Saldo actual: <b class="font-mono">${money(res.remaining)}</b>.`, 'ok');
  if (res.remaining <= 0 && c) say(`La cuenta de <b>${esc(c.name)}</b> quedó <b>al día</b> y habilitada para pedidos.`, 'ok', 5000);
  if (window.ui && window.ui.view === NAV_VIEW_ID) paintCreditView(); else enrich();
}
function toggleBlock(rif) {
  const c = byRif(rif); if (!c) return;
  const toBlock = c.credit.state !== 'bloqueado';
  askConfirm(
    toBlock ? 'Bloquear cuenta' : 'Habilitar cuenta',
    toBlock
      ? `Se bloqueará a <b>${esc(c.name)}</b>: sus vendedores no podrán registrarle pedidos hasta que la administración la habilite.`
      : `Se habilitará a <b>${esc(c.name)}</b>.${c.credit.balance>0 ? ` Conserva un saldo de <b class="font-mono">${money(c.credit.balance)}</b> y pasará a <b>en mora</b>: sus pedidos quedarán sujetos a revisión.` : ' La cuenta está al día.'}`,
    toBlock ? 'Bloquear' : 'Habilitar',
    () => {
      c.credit.state = toBlock ? 'bloqueado' : (c.credit.balance > 0 ? 'moroso' : 'ok');
      save(); emit('client:updated', { rif });
      say(`Cuenta de <b>${esc(c.name)}</b> ${toBlock?'bloqueada':'habilitada'}.`, toBlock?'warn':'ok');
      if (window.ui && window.ui.view === NAV_VIEW_ID) paintCreditView(); else enrich();
    }, toBlock);
}
function confirmRemove(rif) {
  const c = byRif(rif); if (!c) return;
  askConfirm('Eliminar cuenta', `Se eliminará del módulo de crédito a <b>${esc(c.name)}</b> (${esc(c.rif)}) junto con su historial de pagos. Los pedidos del sistema principal no se ven afectados.`, 'Eliminar', () => {
    removeClient(rif);
    say('Cuenta eliminada del módulo.','info');
    if (window.ui && window.ui.view === NAV_VIEW_ID) paintCreditView(); else enrich();
  }, true);
}
function doImport() {
  const r = importFromOrders();
  say(r.imported ? `Importación completa: <b>${r.imported}</b> cuenta(s) nueva(s) desde los pedidos${r.skipped?`, ${r.skipped} ya existentes`:''}.` : 'No hay clientes nuevos que importar desde los pedidos.', r.imported?'ok':'info');
  if (window.ui && window.ui.view === NAV_VIEW_ID) paintCreditView();
}
function doSeedDemo() {
  askConfirm('Cargar demostración', 'Se crearán 4 cuentas de ejemplo (2 en mora, 1 bloqueada, 1 al día) en la base independiente del módulo. No altera ningún dato del sistema principal.', 'Cargar', () => seedDemo(), false);
}
function filter(q) { viewQ.q = q; refreshCreditTable(); }

/* ==========================================================================
   7. ACOPLAMIENTO AL HOST — envolturas reversibles (decoradores)
   ========================================================================== */
const HOOK_NAMES = ['generateOrder','buildWaText','buildPrintHTML','ordersTable','openOrder',
                    'renderView','setNav','setTitle','changeQty','removeLine','setLinePrice',
                    'showReceipt','viewCart'];
const orig = {};

function decorate() {
  /* — generateOrder: validación pre-checkout + flag del ledger post-creación — */
  window.generateOrder = function(...args) {
    if (tfcArmed) {                              // segunda pasada: el vendedor ya confirmó
      const before = window.db ? window.db.counter : 0;
      const r = orig.generateOrder.apply(this, args);
      try {
        if (window.db && window.db.counter === before + 1 && window.db.orders[0]) {
          flagOrder(window.db.orders[0].number, tfcArmed);
          say('Pedido registrado con <b>advertencia de crédito</b>: pasará a revisión administrativa antes del despacho.','warn',6000);
        }
      } catch(e){}
      tfcArmed = null;
      return r;
    }
    let snap = { registered:false, state:'ok' };
    try {
      const rifEl = document.getElementById('cl-rif');
      snap = snapshot(rifEl ? rifEl.value : '');
    } catch(e){}
    if (snap.registered && snap.state === 'bloqueado') {
      say(`<b>Pedido bloqueado:</b> ${esc(snap.name)} registra <b class="font-mono">${money(snap.balance)}</b> en mora y su cuenta está <b>bloqueada</b> por Administración.`, 'bad', 8000);
      return;
    }
    if (snap.registered && snap.state === 'moroso') {
      askConfirm('Cliente con saldo pendiente',
        `La cuenta de <b>${esc(snap.name)}</b> registra <b class="font-mono">${money(snap.balance)}</b> vencidos (${snap.days} días de mora).<br><br>El pedido se registrará <b>sujeto a revisión administrativa</b> y no será despachado hasta su autorización. ¿Desea continuar?`,
        'Registrar igualmente',
        () => { tfcArmed = snap; window.generateOrder.apply(this, args); }, false);
      return;
    }
    const before = window.db ? window.db.counter : 0;
    const r = orig.generateOrder.apply(this, args);
    try {
      if (window.db && window.db.counter === before + 1 && window.db.orders[0]) {
        /* Cliente al día: nada que flaggear; el ledger solo guarda morosos */
      }
    } catch(e){}
    return r;
  };
  let tfcArmed = null;  // cerrado sobre el wrapper (hoisted por closure del IIFE)

  /* — WhatsApp: agrega la advertencia si el pedido está flaggeado — */
  window.buildWaText = function(o) {
    let txt = orig.buildWaText.apply(this, arguments);
    try {
      const e = ledgerFor(o && o.number);
      if (e) txt += `\n\nADVERTENCIA DE CRÉDITO: la cuenta registra saldo pendiente de ${money(e.balance)} (${e.days} días de mora). Pedido sujeto a revisión administrativa antes del despacho.`;
    } catch(err){}
    return txt;
  };
  /* — Impresión: nota de crédito con estilos inline dentro del HTML — */
  window.buildPrintHTML = function(o) {
    let html = orig.buildPrintHTML.apply(this, arguments);
    try { html = injectPrintNote(html, o); } catch(err){}
    return html;
  };
  /* — Tablas de pedidos (dashboard / registro): etiqueta "Crédito" — */
  window.ordersTable = function(list) {
    let html = orig.ordersTable.apply(this, arguments);
    try {
      (list || []).forEach(o => {
        const e = ledgerFor(o.number);
        if (!e) return;
        const find = `>${o.number}</td>`;
        const i = html.indexOf(find);
        if (i >= 0) html = html.slice(0, i) + `>${o.number}${flagTag(e)}</td>` + html.slice(i + find.length);
      });
    } catch(err){}
    return html;
  };
  /* — Modal de comprobante y de gestión admin: nota de crédito inyectada — */
  window.showReceipt = function(...args) {
    const r = orig.showReceipt.apply(this, args);
    try { injectReceiptNote(); } catch(err){}
    return r;
  };
  window.openOrder = function(...args) {
    const r = orig.openOrder.apply(this, args);
    try {
      injectReceiptNote();
      /* Atajo de abono dentro del modal de gestión si hay saldo vigente */
      const modal = document.getElementById('modal-root');
      const note = modal && modal.querySelector('[data-tfc="receipt"]');
      const numEl = modal && modal.querySelector('.font-mono.font-bold.text-2xl');
      const entry = numEl ? ledgerFor(numEl.textContent.trim()) : null;
      if (note && entry) {
        const c = byRif(entry.rif);
        if (c && c.credit.balance > 0) {
          note.insertAdjacentHTML('beforeend', `<button type="button" onclick="TFCredit.openPayment('${c.rif}')" class="btn-line !py-1.5 !text-xs mt-2"><i class="fa-solid fa-hand-holding-dollar"></i> Registrar abono (saldo actual: ${money(c.credit.balance)})</button>`);
        }
      }
    } catch(err){}
    return r;
  };
  /* — Enrutado: la vista 'credit' la pinta el módulo; el resto pasa al host — */
  window.renderView = function(...args) {
    if (window.ui && window.ui.view === NAV_VIEW_ID) { paintCreditView(); return; }
    return orig.renderView.apply(this, args);
  };
  /* — Navegación y título: after-hooks que mantienen coherente la vista CxC — */
  window.setNav = function(...args) {
    const r = orig.setNav.apply(this, args);
    try { refreshModuleNavState(); } catch(err){}
    return r;
  };
  window.setTitle = function(...args) {
    const r = orig.setTitle.apply(this, args);
    try {
      if (window.ui && window.ui.view === NAV_VIEW_ID) {
        const t = document.getElementById('view-title');
        if (t) t.textContent = 'Cuentas por cobrar';
      }
    } catch(err){}
    return r;
  };
  /* — Preservación del formulario del cliente en re-renders del carrito — */
  const preserveForm = fn => function(...args) {
    let draft = null;
    try {
      const g = id => { const el = document.getElementById(id); return el ? el.value : ''; };
      draft = { name:g('cl-name'), rif:g('cl-rif'), phone:g('cl-phone'), contact:g('cl-contact'), addr:g('cl-addr'), notes:g('cl-notes') };
    } catch(e){}
    const r = fn.apply(this, args);
    try {
      if (draft) {
        const s = (id, v) => { const el = document.getElementById(id); if (el && v !== null && v !== undefined) el.value = v; };
        s('cl-name', draft.name); s('cl-rif', draft.rif); s('cl-phone', draft.phone);
        s('cl-contact', draft.contact); s('cl-addr', draft.addr); s('cl-notes', draft.notes);
      }
    } catch(e){}
    scheduleEnrich();
    return r;
  };
  window.changeQty    = preserveForm(orig.changeQty);
  window.removeLine   = preserveForm(orig.removeLine);
  window.setLinePrice = preserveForm(orig.setLinePrice);
}

/* Espera activa al host (cinturón y tirantes: el script se coloca después,
   pero así el módulo también funciona con carga diferida o reordenada) */
function waitForHost(attempt = 0) {
    const ready = document.body !== null;
    if (ready) { boot(); return; }
    if (attempt > 200) { console.error('[TFCredit] Host Truck Filters no encontrado.'); return; }
    setTimeout(() => waitForHost(attempt + 1), 50);
}
function boot() {
  load();
  HOOK_NAMES.forEach(n => { if (typeof window[n] === 'function') orig[n] = window[n]; else console.warn('[TFCredit] Hook no encontrado en el host:', n); });
  decorate();
  /* Observador de DOM: re-inyecta ante cualquier re-render del host */
  observer = new MutationObserver(scheduleEnrich);
  observer.observe(document.body, { childList:true, subtree:true });
  /* Sincronización entre pestañas usando SOLO la clave propia del módulo */
  window.addEventListener('storage', onStorage);
  enrich();
  console.info(`[TFCredit] v${VERSION} activo. Interfaz pública: window.TFCredit`);
}
function onStorage(e) {
  if (e.key !== STORE_KEY) return;
  load();
  emit('store:changed');
  if (window.ui && window.ui.view === NAV_VIEW_ID) paintCreditView();
  scheduleEnrich();
}

/* ==========================================================================
   8. DESMONTAJE LIMPIO — el host queda exactamente como estaba
   ========================================================================== */
function destroy() {
  HOOK_NAMES.forEach(n => { if (orig[n]) window[n] = orig[n]; });
  if (observer) { observer.disconnect(); observer = null; }
  window.removeEventListener('storage', onStorage);
  document.querySelectorAll('[data-tfc]').forEach(n => n.remove());
  if (window.ui && window.ui.view === NAV_VIEW_ID) { window.ui.view = 'dash'; }
  if (typeof window.renderView === 'function') window.renderView();
  console.info('[TFCredit] Módulo desmontado. Funciones del host restauradas. Los datos del módulo permanecen en localStorage.');
}

/* ==========================================================================
   9. INTERFAZ PÚBLICA — el único punto de contacto con el exterior
   ========================================================================== */
window.TFCredit = {
  version: VERSION,
  /* Consulta */
  snapshot, getClient: byRif, list: () => state.clients.slice(), kpi,
  ledgerFor, oldestDays,
  /* Escritura (sobre la base propia del módulo) */
  upsertClient, removeClient, setState, registerPayment, importFromOrders, seedDemo,
  /* UI */
  openCreditView, openEdit, saveEdit, openPayment, doPayment, toggleBlock, confirmRemove,
  doImport, doSeedDemo, filter,
  /* Eventos: 'client:updated' · 'payment:registered' · 'order:flagged' · 'store:changed' */
  on, emit,
  /* Ciclo de vida */
  destroy
};

/* Arranque */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => waitForHost());
} else {
    waitForHost();
}

})();
