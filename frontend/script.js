/* ======================================================================
   RotaStock — Lógica de negocio (Vanilla JS)
   FIFO estricto · Métricas dinámicas por período · Persistencia local JSON
   ====================================================================== */

/* ------------------------------------------------------------------ */
/* Capa de persistencia (Electron IPC o localStorage como respaldo)  */
/* ------------------------------------------------------------------ */
const Store = {
  hasElectron: !!(window.rotastock && window.rotastock.isElectron),
  async load() {
    if (this.hasElectron) return await window.rotastock.loadDB();
    const raw = localStorage.getItem('rotastock_db');
    if (raw) return JSON.parse(raw);
    // Semilla inicial cuando se abre directamente en el navegador
    const seed = await fetch('../datos/inventario.json').then(r => r.ok ? r.json() : null).catch(() => null);
    return seed || Engine.defaultDB();
  },
  async save(db) {
    if (this.hasElectron) return await window.rotastock.saveDB(db);
    localStorage.setItem('rotastock_db', JSON.stringify(db));
    return true;
  }
};

/* ------------------------------------------------------------------ */
/* Utilidades                                                        */
/* ------------------------------------------------------------------ */
const DAY = 86400000;
const uid = () => 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtMoney = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtDateTime = iso => {
  const d = new Date(iso);
  return d.toLocaleString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const daysBetween = (a, b) => Math.floor((b - a) / DAY);
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ESTADOS = {
  sana:     { label: 'Rotación Sana',      dot: '🟢' },
  lenta:    { label: 'Rotación Lenta',     dot: '🟡' },
  muyLenta: { label: 'Rotación Muy Lenta', dot: '🟠' },
  dormido:  { label: 'Inventario Dormido', dot: '🔴' }
};
const ESTADO_ORDEN = { sana: 0, lenta: 1, muyLenta: 2, dormido: 3, sinDatos: -1 };

/* ------------------------------------------------------------------ */
/* Tema visual (claro / oscuro) — solo presentación                  */
/* ------------------------------------------------------------------ */
const THEME_KEY = 'rotastock_theme';
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const currentTheme = () => document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('btnTheme');
  if (btn) btn.title = theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* sin almacenamiento */ }
  applyTheme(saved === 'light' || saved === 'dark' ? saved : currentTheme());
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* sin almacenamiento */ }
  // Los gráficos (canvas) no leen CSS por sí solos: se redibujan con la nueva paleta
  if (typeof currentView !== 'undefined' && currentView === 'rotacion' && DB) renderDashboard();
}

/* ------------------------------------------------------------------ */
/* Motor: replay cronológico + valoración FIFO estricta              */
/* ------------------------------------------------------------------ */
const Engine = {
  defaultDB() {
    return {
      meta: { version: 1, createdAt: new Date().toISOString() },
      config: { metodoCosteo: 'FIFO', umbrales: { sana: 7, lenta: 15, muyLenta: 30 } },
      productos: [], movimientos: []
    };
  },

  /* Reconstruye todo el estado derivado a partir de los movimientos.
     Cualquier edición/eliminación se refleja porque se recalcula desde cero. */
  compute(db) {
    const byProd = {};
    db.productos.forEach(p => {
      byProd[p.id] = {
        producto: p, lots: [], lastCost: 0,
        stockQty: 0, stockVal: 0, lastMovDate: null,
        firstMovDate: null, snapshots: [], sales: [], purchases: []
      };
    });

    // Orden cronológico estricto (empate → por id para estabilidad)
    const movs = [...db.movimientos].sort((a, b) =>
      (new Date(a.fecha) - new Date(b.fecha)) || String(a.id).localeCompare(String(b.id)));

    movs.forEach(m => {
      const st = byProd[m.productoId];
      if (!st) return;                       // movimiento huérfano → se ignora
      const fecha = new Date(m.fecha).getTime();
      const qty = parseInt(m.cantidad, 10) || 0; // Forzando a enteros
      const cu = Number(m.costoUnitario) || 0;

      if (m.tipo === 'compra') {
        st.lots.push({ remaining: qty, costo: cu, fecha, movId: m.id });
        st.lastCost = cu;
        st.purchases.push({ fecha, qty, costo: cu, total: qty * cu });
        m._cogs = qty * cu;                  // costo de adquisición del lote
        m._ingreso = 0;
      } else { // venta → consume FIFO
        let need = qty, cogs = 0;
        while (need > 0 && st.lots.length) {
          const lot = st.lots[0];
          const take = Math.min(lot.remaining, need);
          cogs += take * lot.costo;
          lot.remaining -= take; need -= take;
          if (lot.remaining <= 1e-9) st.lots.shift();
        }
        if (need > 0) cogs += need * st.lastCost; // faltante: costo de referencia
        const ingreso = qty * cu;
        st.sales.push({ fecha, qty, cogs, ingreso });
        m._cogs = cogs;
        m._ingreso = ingreso;
      }

      // Recalcular stock actual y snapshot temporal
      st.stockQty = st.lots.reduce((s, l) => s + l.remaining, 0);
      st.stockVal = st.lots.reduce((s, l) => s + l.remaining * l.costo, 0);
      st.snapshots.push({ fecha, qty: st.stockQty, val: st.stockVal });
      st.lastMovDate = fecha;
      if (st.firstMovDate === null) st.firstMovDate = fecha;
    });

    this._byProd = byProd;
    this._movs = movs;
    return { byProd, movs };
  },

  /* Valor/cantidad de inventario en un instante dado (último snapshot ≤ fecha) */
  invAt(st, t, key) {
    let v = 0;
    for (const s of st.snapshots) { if (s.fecha <= t) v = s[key]; else break; }
    return v;
  },

  firstGlobalMov() {
    let min = null;
    Object.values(this._byProd).forEach(st => {
      if (st.firstMovDate !== null && (min === null || st.firstMovDate < min)) min = st.firstMovDate;
    });
    return min;
  },

  /* Rango [start,end] del período seleccionado */
  periodRange(periodValue) {
    const end = Date.now();
    if (periodValue === 'all') {
      const first = this.firstGlobalMov();
      return { start: first !== null ? first : end, end };
    }
    return { start: end - Number(periodValue) * DAY, end };
  },

  estadoDe(diasSinMov, umbrales) {
    if (diasSinMov === null) return 'sinDatos';
    if (diasSinMov <= umbrales.sana) return 'sana';
    if (diasSinMov <= umbrales.lenta) return 'lenta';
    if (diasSinMov <= umbrales.muyLenta) return 'muyLenta';
    return 'dormido'; // Todo lo que supera "muyLenta" cae aquí automáticamente
  },

  /* Métricas de un producto dentro del período */
  productMetrics(st, range, umbrales) {
    const { start, end } = range;
    const periodDays = Math.max(1, daysBetween(start, end) || 1);

    let cogs = 0, ingresos = 0, unidadesVendidas = 0;
    st.sales.forEach(s => { if (s.fecha >= start && s.fecha <= end) { cogs += s.cogs; ingresos += s.ingreso; unidadesVendidas += s.qty; } });
    const ganancia = ingresos - cogs;

    const invIniVal = this.invAt(st, start, 'val');
    const invFinVal = this.invAt(st, end, 'val');
    const invIniQty = this.invAt(st, start, 'qty');
    const invFinQty = this.invAt(st, end, 'qty');
    const invPromVal = (invIniVal + invFinVal) / 2;
    const invPromQty = (invIniQty + invFinQty) / 2;

    const rotacion = invPromVal > 0 ? cogs / invPromVal : 0;
    const cogsPerDay = cogs / periodDays;
    let cobertura = null;                       // días de cobertura
    if (cogsPerDay > 0) cobertura = invFinVal / cogsPerDay;

    const diasSinMov = st.lastMovDate !== null ? Math.max(0, daysBetween(st.lastMovDate, end)) : null;
    const estado = this.estadoDe(diasSinMov, umbrales);

    return {
      cogs, ingresos, ganancia, unidadesVendidas,
      invPromVal, invPromQty, rotacion, cobertura,
      stockActual: st.stockQty, valorInventario: st.stockVal,
      diasSinMov, estado
    };
  },

  /* Métricas agregadas del dashboard */
  dashboard(db, range) {
    const rows = db.productos.map(p => {
      const st = this._byProd[p.id];
      const met = this.productMetrics(st, range, db.config.umbrales);
      return { id: p.id, nombre: p.nombre, ...met, estadoOrden: ESTADO_ORDEN[met.estado] };
    });
    const periodDays = Math.max(1, daysBetween(range.start, range.end) || 1);
    const totCogs = rows.reduce((s, r) => s + r.cogs, 0);
    const totIngresos = rows.reduce((s, r) => s + r.ingresos, 0);
    const totValInv = rows.reduce((s, r) => s + r.valorInventario, 0);
    const cogsPerDay = totCogs / periodDays;
    const diasInventario = cogsPerDay > 0 ? totValInv / cogsPerDay : null;
    const alertas = rows.filter(r => r.estado === 'dormido').length;
    return {
      rows, periodDays,
      totCogs, totIngresos, totGanancia: totIngresos - totCogs,
      diasInventario, alertas, totValInv
    };
  }
};

/* ================================================================== */
/* Estado de la aplicación / UI                                      */
/* ================================================================== */
let DB = null;
let currentView = 'rotacion';
const PERIOD_LABELS = { '7': '1 semana', '15': '15 días', '30': '1 mes', '90': '3 meses', '180': '6 meses', '365': '1 año', 'all': 'Siempre' };

const ui = {
  dashSort: { field: 'diasSinMov', dir: 'desc' }, dashPage: 1, dashSearch: '',
  movSort: { field: 'fecha', dir: 'desc' }, movPage: 1, movSearch: '', movTipo: '',
  prodSearch: '', prodEstado: '', prodSortField: 'nombre', prodSortDir: 'asc'
};
const PAGE = 8;
const charts = {};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ------------------------------- Toast ---------------------------- */
let toastT;
function toast(msg, type = 'ok') {
  const el = $('#toast');
  el.textContent = msg; el.className = 'toast ' + type;
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('hidden'), 10);
  toastT = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* ------------------------------- Modal ---------------------------- */
function openModal(title, bodyHtml) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalOverlay').classList.remove('hidden');
}
function closeModal() { $('#modalOverlay').classList.add('hidden'); $('#modalBody').innerHTML = ''; }

/* ================================================================== */
/* Persistir + refrescar todo                                        */
/* ================================================================== */
async function persistAndRender() {
  await Store.save(DB);
  render();
}
function currentRange() { return Engine.periodRange($('#periodSelect').value); }

function render() {
  Engine.compute(DB);
  if (currentView === 'rotacion') renderDashboard();
  if (currentView === 'productos') renderProductos();
  if (currentView === 'movimientos') renderMovimientos();
  if (currentView === 'configuracion') renderConfig();
  if (currentView === 'exportar') renderExport();
}

/* ================================================================== */
/* MÓDULO 1 — Dashboard / Rotación                                   */
/* ================================================================== */
function estadoPill(estado) {
  if (estado === 'sinDatos') return '<span class="pill">Sin datos</span>';
  return `<span class="pill ${estado}">${ESTADOS[estado].label}</span>`;
}

function renderDashboard() {
  const range = currentRange();
  const d = Engine.dashboard(DB, range);

  $('#kpiDias').textContent = d.diasInventario !== null ? fmtNum(d.diasInventario, 1) + ' días' : '—';
  $('#kpiCogs').textContent = fmtMoney(d.totCogs);
  $('#kpiIngresos').textContent = fmtMoney(d.totIngresos);
  $('#kpiGanancia').textContent = fmtMoney(d.totGanancia);
  $('#kpiAlertas').textContent = d.alertas;

  $('#periodCaption').textContent =
    `Período: ${PERIOD_LABELS[$('#periodSelect').value]} · ${new Date(range.start).toLocaleDateString('es-PE')} → ${new Date(range.end).toLocaleDateString('es-PE')}`;

  // Banner de alerta crítica con lógica del botón cerrar
  const banner = $('#alertBanner');
  if (d.alertas > 0) {
    $('#alertText').innerHTML = `<svg class="i ab-ico"><use href="#i-alert"/></svg><strong>${d.alertas}</strong>&nbsp;producto(s) clasificados como <strong><i class="dot dormido"></i>Inventario Dormido</strong>. Requiere atención inmediata.`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  // Filtro + orden + paginación
  let rows = d.rows.filter(r => r.nombre.toLowerCase().includes(ui.dashSearch.toLowerCase()));
  const { field, dir } = ui.dashSort;
  rows.sort((a, b) => {
    let va = a[field], vb = b[field];
    if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    va = va ?? -1; vb = vb ?? -1;
    return dir === 'asc' ? va - vb : vb - va;
  });

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE));
  if (ui.dashPage > totalPages) ui.dashPage = totalPages;
  const pageRows = rows.slice((ui.dashPage - 1) * PAGE, ui.dashPage * PAGE);

  const tb = $('#dashTable tbody');
  tb.innerHTML = pageRows.length ? pageRows.map(r => `
    <tr>
      <td>${escapeHtml(r.nombre)}</td>
      <td class="num">${fmtNum(r.invPromQty, 1)}</td>
      <td class="num">${fmtNum(r.rotacion, 2)}×</td>
      <td class="num">${r.cobertura !== null ? fmtNum(r.cobertura, 1) : '—'}</td>
      <td class="num">${r.diasSinMov !== null ? r.diasSinMov : '—'}</td>
      <td>${estadoPill(r.estado)}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty">Sin productos para mostrar</td></tr>`;

  updateSortHeaders('#dashTable', ui.dashSort);
  renderPager('#dashPager', ui.dashPage, totalPages, rows.length, p => { ui.dashPage = p; renderDashboard(); });

  drawCharts(d);
}

function drawCharts(d) {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  const top = [...d.rows].sort((a, b) => b.ingresos - a.ingresos).slice(0, 8);
  // Barras: Ingresos vs COGS
  if (charts.bar) charts.bar.destroy();
  charts.bar = new Chart($('#chartBar'), {
    type: 'bar',
    data: {
      labels: top.map(r => r.nombre),
      datasets: [
        { label: 'Ingresos', data: top.map(r => +r.ingresos.toFixed(2)), backgroundColor: cssVar('--chart-1'), borderRadius: 3 },
        { label: 'COGS', data: top.map(r => +r.cogs.toFixed(2)), backgroundColor: cssVar('--chart-2'), borderRadius: 3 }
      ]
    },
    options: chartOpts(true)
  });

  // Donut: distribución de estados
  const counts = { sana: 0, lenta: 0, muyLenta: 0, dormido: 0 };
  d.rows.forEach(r => { if (counts[r.estado] !== undefined) counts[r.estado]++; });
  if (charts.donut) charts.donut.destroy();
  charts.donut = new Chart($('#chartDonut'), {
    type: 'doughnut',
    data: {
      labels: ['Sana', 'Lenta', 'Muy Lenta', 'Dormido'],
      datasets: [{ data: [counts.sana, counts.lenta, counts.muyLenta, counts.dormido],
        backgroundColor: [cssVar('--sana'), cssVar('--lenta'), cssVar('--muyLenta'), cssVar('--dormido')],
        borderColor: cssVar('--surface'), borderWidth: 2 }]
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: { legend: { position: 'bottom', labels: { color: cssVar('--muted'), padding: 14 } } } }
  });
}
function chartOpts(money) {
  const tick = cssVar('--muted'), grid = cssVar('--grid');
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: tick } },
      tooltip: { callbacks: { label: c => `${c.dataset.label}: ${money ? fmtMoney(c.raw) : c.raw}` } } },
    scales: {
      x: { ticks: { color: tick, maxRotation: 40, minRotation: 0 }, grid: { color: grid } },
      y: { ticks: { color: tick }, grid: { color: grid } }
    }
  };
}

/* ================================================================== */
/* MÓDULO 2 — Productos (CRUD en grid)                               */
/* ================================================================== */
function renderProductos() {
  const range = currentRange();
  let rows = DB.productos.map(p => {
    const st = Engine._byProd[p.id];
    const met = Engine.productMetrics(st, range, DB.config.umbrales);
    return { id: p.id, nombre: p.nombre, ...met };
  });

  if (ui.prodSearch) rows = rows.filter(r => r.nombre.toLowerCase().includes(ui.prodSearch.toLowerCase()));
  if (ui.prodEstado) rows = rows.filter(r => r.estado === ui.prodEstado);

  const f = ui.prodSortField, dir = ui.prodSortDir;
  const key = { nombre: 'nombre', rotacion: 'rotacion', cogs: 'cogs', ingresos: 'ingresos', ganancia: 'ganancia', cobertura: 'cobertura', diasSinMov: 'diasSinMov' }[f];
  rows.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    va = va ?? -1; vb = vb ?? -1;
    return dir === 'asc' ? va - vb : vb - va;
  });

  const grid = $('#productGrid');
  grid.innerHTML = rows.length ? rows.map(r => `
    <div class="prod-card">
      <div class="prod-card-top">
        <span class="prod-name">${escapeHtml(r.nombre)}</span>
        ${estadoPill(r.estado)}
      </div>
      <div class="prod-metrics">
        <div class="pm"><span class="pm-lbl">Stock actual</span><span class="pm-val">${fmtNum(r.stockActual, 0)}</span></div>
        <div class="pm"><span class="pm-lbl">Inv. promedio</span><span class="pm-val">${fmtNum(r.invPromQty, 1)}</span></div>
        <div class="pm"><span class="pm-lbl">COGS</span><span class="pm-val">${fmtMoney(r.cogs)}</span></div>
        <div class="pm"><span class="pm-lbl">Ingresos</span><span class="pm-val">${fmtMoney(r.ingresos)}</span></div>
        <div class="pm"><span class="pm-lbl">Ganancia</span><span class="pm-val">${fmtMoney(r.ganancia)}</span></div>
        <div class="pm"><span class="pm-lbl">Rotación</span><span class="pm-val">${fmtNum(r.rotacion, 2)}×</span></div>
        <div class="pm"><span class="pm-lbl">Días cobertura</span><span class="pm-val">${r.cobertura !== null ? fmtNum(r.cobertura, 1) : '—'}</span></div>
        <div class="pm"><span class="pm-lbl">Días sin mov.</span><span class="pm-val">${r.diasSinMov !== null ? r.diasSinMov : '—'}</span></div>
      </div>
      <div class="prod-actions">
        <button class="btn btn-ghost" data-edit-prod="${r.id}"><svg class="i"><use href="#i-edit"/></svg> Editar</button>
        <button class="btn btn-danger" data-del-prod="${r.id}"><svg class="i"><use href="#i-trash"/></svg> Eliminar</button>
      </div>
    </div>`).join('') : `<div class="empty">No hay productos. Crea el primero con “Nuevo Producto”.</div>`;
}

function productForm(prod) {
  const editing = !!prod;
  openModal(editing ? 'Editar Producto' : 'Nuevo Producto', `
    <form id="prodForm" class="form-grid">
      <label><span>Nombre del Producto <span class="req">*</span></span>
        <input class="input" id="pfNombre" required value="${editing ? escapeHtml(prod.nombre) : ''}" placeholder="Ej. Teclado Mecánico" />
      </label>
      ${editing ? '' : `
      <label><span>Stock inicial (opcional)</span>
        <input class="input" id="pfStock" type="number" min="0" step="1" placeholder="Ej. 10" />
      </label>
      <label><span>Costo total del lote inicial</span>
        <input class="input" id="pfCosto" type="number" min="0" step="0.01" placeholder="Ej. 150.00" />
      </label>
      <div class="form-hint" id="pfHint" style="display:none; color: var(--red);">Si registras stock inicial, el monto comprado es obligatorio.</div>`}
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="pfCancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Guardar' : 'Crear producto'}</button>
      </div>
    </form>`);

  $('#pfCancel').onclick = closeModal;
  $('#prodForm').onsubmit = e => {
    e.preventDefault();
    const nombre = $('#pfNombre').value.trim();
    if (!nombre) return;

    if (editing) {
      prod.nombre = nombre;
      toast('Producto actualizado');
    } else {
      const stock = parseInt($('#pfStock').value, 10) || 0;
      const costo = parseFloat($('#pfCosto').value);
      if (stock > 0 && !(costo >= 0 && $('#pfCosto').value !== '')) {
        $('#pfHint').style.display = 'block'; return;
      }
      const id = uid();
      DB.productos.push({ id, nombre });
      if (stock > 0) {
        DB.movimientos.push({ id: uid(), productoId: id, tipo: 'compra',
          cantidad: stock, costoUnitario: +(costo / stock).toFixed(4), fecha: new Date().toISOString() });
      }
      toast('Producto creado');
    }
    closeModal();
    persistAndRender();
  };
}

function deleteProducto(id) {
  const p = DB.productos.find(x => x.id === id);
  if (!p) return;
  const nMov = DB.movimientos.filter(m => m.productoId === id).length;
  openConfirm(`Eliminar “${escapeHtml(p.nombre)}”`,
    `Se eliminará el producto y sus <strong>${nMov}</strong> movimiento(s) asociado(s). Esta acción recalculará todos los indicadores.`,
    () => {
      DB.productos = DB.productos.filter(x => x.id !== id);
      DB.movimientos = DB.movimientos.filter(m => m.productoId !== id);
      toast('Producto eliminado');
      persistAndRender();
    });
}

/* ================================================================== */
/* MÓDULO 3 — Movimientos                                            */
/* ================================================================== */
function renderMovimientos() {
  const prodName = id => (DB.productos.find(p => p.id === id) || {}).nombre || '(eliminado)';
  let rows = DB.movimientos.map(m => ({ ...m, producto: prodName(m.productoId) }));

  if (ui.movSearch) rows = rows.filter(r => r.producto.toLowerCase().includes(ui.movSearch.toLowerCase()));
  if (ui.movTipo) rows = rows.filter(r => r.tipo === ui.movTipo);

  const { field, dir } = ui.movSort;
  rows.sort((a, b) => {
    let va = a[field], vb = b[field];
    if (field === 'fecha') { va = new Date(a.fecha); vb = new Date(b.fecha); }
    if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return dir === 'asc' ? va - vb : vb - va;
  });

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE));
  if (ui.movPage > totalPages) ui.movPage = totalPages;
  const pageRows = rows.slice((ui.movPage - 1) * PAGE, ui.movPage * PAGE);

  const tb = $('#movTable tbody');
  tb.innerHTML = pageRows.length ? pageRows.map(m => `
    <tr>
      <td>${fmtDateTime(m.fecha)}</td>
      <td>${escapeHtml(m.producto)}</td>
      <td><span class="badge ${m.tipo}">${m.tipo === 'compra' ? 'Compra' : 'Venta'}</span></td>
      <td class="num">${fmtNum(m.cantidad, 0)}</td>
      <td class="num">${fmtMoney(m.costoUnitario)}</td>
      <td class="num">${fmtMoney(m.cantidad * m.costoUnitario)}</td>
      <td>
        <button class="icon-btn" title="Editar" aria-label="Editar" data-edit-mov="${m.id}"><svg class="i"><use href="#i-edit"/></svg></button>
        <button class="icon-btn" title="Eliminar" aria-label="Eliminar" data-del-mov="${m.id}"><svg class="i"><use href="#i-trash"/></svg></button>
      </td>
    </tr>`).join('') : `<tr><td colspan="7" class="empty">Sin movimientos registrados</td></tr>`;

  updateSortHeaders('#movTable', ui.movSort);
  renderPager('#movPager', ui.movPage, totalPages, rows.length, p => { ui.movPage = p; renderMovimientos(); });
}

function movForm(mov) {
  const editing = !!mov;
  if (!DB.productos.length) { toast('Primero registra un producto', 'err'); return; }

  const tipo = editing ? mov.tipo : 'compra';
  const prodName = id => (DB.productos.find(p => p.id === id) || {}).nombre || '';

  openModal(editing ? 'Editar Movimiento' : 'Registrar Movimiento', `
    <form id="movForm" class="form-grid">
      <label><span>Tipo de movimiento <span class="req">*</span></span>
        <select class="input" id="mfTipo">
          <option value="compra" ${tipo === 'compra' ? 'selected' : ''}>Compra (entrada)</option>
          <option value="venta" ${tipo === 'venta' ? 'selected' : ''}>Venta (salida)</option>
        </select>
      </label>
      
      <div class="form-group" style="position: relative;">
        <label><span>Producto <span class="req">*</span></span>
          <input type="text" class="input" id="movProductoName" placeholder="Escribe para buscar un producto..." autocomplete="off" required value="${editing ? escapeHtml(prodName(mov.productoId)) : ''}">
          <input type="hidden" id="mfProd" required value="${editing ? mov.productoId : ''}">
        </label>
        <div id="autocompleteList" class="autocomplete-list hidden" style="position:absolute; top: 100%; left:0; width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:var(--radius-sm); max-height:150px; overflow-y:auto; z-index:100; box-shadow:var(--shadow);"></div>
      </div>

      <label><span>Cantidad (en unidades enteras) <span class="req">*</span></span>
        <input class="input" id="mfCant" type="number" min="1" step="1" required value="${editing ? mov.cantidad : ''}" placeholder="Ej. 10" />
      </label>
      
      <label><span><span id="mfCostoLblText">Costo unitario</span> <span class="req">*</span></span>
        <input class="input" id="mfCosto" type="number" min="0" step="0.01" required value="${editing ? mov.costoUnitario : ''}" placeholder="Ej. 15.50" />
      </label>
      
      <div class="form-hint" id="mfHint" style="display:none; color: var(--red);"></div>
      
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="mfCancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Guardar cambios' : 'Registrar'}</button>
      </div>
    </form>`);

  // Lógica del autocompletado nativo y dinámico
  const searchInput = $('#movProductoName');
  const listContainer = $('#autocompleteList');
  const hiddenIdInput = $('#mfProd');

  searchInput.oninput = function() {
    const query = this.value.toLowerCase().trim();
    listContainer.innerHTML = '';
    hiddenIdInput.value = ''; // Resetea el ID si cambia el texto para obligar a seleccionar de la lista

    if (!query) {
      listContainer.classList.add('hidden');
      return;
    }

    const coincidencias = DB.productos.filter(p => p.nombre.toLowerCase().includes(query));
    if (coincidencias.length === 0) {
      listContainer.classList.add('hidden');
      return;
    }

    coincidencias.forEach(p => {
      const item = document.createElement('div');
      item.textContent = p.nombre;
      item.style.padding = '8px 12px';
      item.style.cursor = 'pointer';
      item.style.borderBottom = '1px solid var(--border)';
      
      item.onmouseenter = () => item.style.background = 'var(--primary-soft)';
      item.onmouseleave = () => item.style.background = 'transparent';
      
      item.onmousedown = (e) => { // onmousedown se ejecuta antes del blur del input
        e.preventDefault();
        searchInput.value = p.nombre;
        hiddenIdInput.value = p.id;
        listContainer.classList.add('hidden');
      };
      listContainer.appendChild(item);
    });
    listContainer.classList.remove('hidden');
  };

  searchInput.onblur = () => { setTimeout(() => listContainer.classList.add('hidden'), 100); };
  searchInput.onfocus = () => { if(searchInput.value) searchInput.dispatchEvent(new Event('input')); };

  // Control de etiqueta de costo vs precio
  const syncLbl = () => {
    $('#mfCostoLblText').textContent = ($('#mfTipo').value === 'venta') ? 'Precio de venta unitario' : 'Costo de compra unitario';
  };
  syncLbl();
  $('#mfTipo').onchange = syncLbl;
  $('#mfCancel').onclick = closeModal;

  $('#movForm').onsubmit = e => {
    e.preventDefault();
    const tipoV = $('#mfTipo').value;
    const productoId = $('#mfProd').value;
    const cantidad = parseInt($('#mfCant').value, 10); // Asegurando entero
    const costoUnitario = parseFloat($('#mfCosto').value);

    if (!productoId) {
      toast('Por favor, selecciona un producto válido de la lista desplegable.', 'err');
      return;
    }
    if (!(cantidad > 0) || !(costoUnitario >= 0)) return;

    // Validación de stock para ventas (según valoración FIFO actual)
    if (tipoV === 'venta') {
      const st = Engine._byProd[productoId];
      let disponible = st ? st.stockQty : 0;
      if (editing && mov.tipo === 'venta' && mov.productoId === productoId) disponible += mov.cantidad;
      if (editing && mov.tipo === 'compra' && mov.productoId === productoId) disponible -= mov.cantidad;
      if (cantidad > disponible + 1e-9) {
        const h = $('#mfHint'); h.style.display = 'block';
        h.textContent = `Stock insuficiente: disponible ${fmtNum(disponible, 0)} unidad(es).`;
        return;
      }
    }

    if (editing) {
      Object.assign(mov, { tipo: tipoV, productoId, cantidad, costoUnitario });
      toast('Movimiento actualizado · indicadores recalculados');
    } else {
      DB.movimientos.push({ id: uid(), tipo: tipoV, productoId, cantidad, costoUnitario, fecha: new Date().toISOString() });
      toast('Movimiento registrado');
    }
    closeModal();
    persistAndRender();
  };
}

function deleteMov(id) {
  const m = DB.movimientos.find(x => x.id === id);
  if (!m) return;
  openConfirm('Eliminar movimiento',
    'Se recalcularán automáticamente el stock y todos los indicadores financieros derivados. ¿Continuar?',
    () => {
      DB.movimientos = DB.movimientos.filter(x => x.id !== id);
      toast('Movimiento eliminado · indicadores recalculados');
      persistAndRender();
    });
}

/* ================================================================== */
/* MÓDULO 4 — Configuración                                          */
/* ================================================================== */
function renderConfig() {
  const u = DB.config.umbrales;
  $('#cfgSana').value = u.sana; 
  $('#cfgLenta').value = u.lenta;
  $('#cfgMuyLenta').value = u.muyLenta; 
}

/* ================================================================== */
/* MÓDULO 5 — Exportar                                               */
/* ================================================================== */
function renderExport() {
  $('#exportPeriodLbl').textContent = PERIOD_LABELS[$('#periodSelect').value];
}

function exportExcel() {
  const range = currentRange();
  const d = Engine.dashboard(DB, range);
  const periodLbl = PERIOD_LABELS[$('#periodSelect').value];
  const wb = XLSX.utils.book_new();

  // Hoja 1 — Resumen
  const resumen = [
    ['RotaStock — Reporte de Rotación de Inventario'],
    ['Período', periodLbl],
    ['Desde', new Date(range.start).toLocaleString('es-PE')],
    ['Hasta', new Date(range.end).toLocaleString('es-PE')],
    ['Método de costeo', DB.config.metodoCosteo],
    [],
    ['Indicador', 'Valor'],
    ['Días de Inventario', d.diasInventario !== null ? +d.diasInventario.toFixed(2) : 'N/D'],
    ['COGS del período', +d.totCogs.toFixed(2)],
    ['Ingresos Totales', +d.totIngresos.toFixed(2)],
    ['Ganancia Bruta Total', +d.totGanancia.toFixed(2)],
    ['Alertas de Rotación (Inventario Dormido)', d.alertas]
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumen), 'Resumen');

  // Hoja 2 — Productos (detalle + maestro)
  const prodHead = ['Producto', 'Stock Actual', 'Inv. Promedio', 'Rotación (veces)', 'Días Cobertura', 'Días sin Mov.', 'Estado'];
  const prodRows = d.rows.map(r => [
    r.nombre, +r.stockActual.toFixed(2), +r.invPromQty.toFixed(2), +r.rotacion.toFixed(2),
    r.cobertura !== null ? +r.cobertura.toFixed(2) : 'N/D',
    r.diasSinMov !== null ? r.diasSinMov : 'N/D',
    r.estado === 'sinDatos' ? 'Sin datos' : ESTADOS[r.estado].label
  ]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([prodHead, ...prodRows]), 'Productos');

  // Hoja 3 — Historial analítico de movimientos del período
  const movHead = ['Fecha y hora', 'Producto', 'Tipo', 'Cantidad', 'Costo/Precio Unit.', 'COGS', 'Ingreso', 'Ganancia'];
  const movRows = Engine._movs
    .filter(m => { const t = new Date(m.fecha).getTime(); return t >= range.start && t <= range.end; })
    .map(m => {
      const pName = (DB.productos.find(p => p.id === m.productoId) || {}).nombre || '(eliminado)';
      const cogs = m._cogs || 0, ing = m._ingreso || 0;
      return [fmtDateTime(m.fecha), pName, m.tipo === 'compra' ? 'Compra' : 'Venta',
        +m.cantidad, +m.costoUnitario, +cogs.toFixed(2), +ing.toFixed(2),
        m.tipo === 'venta' ? +(ing - cogs).toFixed(2) : 0];
    });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([movHead, ...movRows]), 'Movimientos');

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `RotaStock_${periodLbl.replace(/\s/g, '')}_${stamp}.xlsx`);
  toast('Reporte Excel generado');
}

/* ================================================================== */
/* Componentes compartidos: pager, sort headers, confirmación        */
/* ================================================================== */
function renderPager(sel, page, totalPages, totalItems, onGo) {
  const el = $(sel);
  if (totalPages <= 1) { el.innerHTML = totalItems ? `<span class="pinfo">${totalItems} registro(s)</span>` : ''; return; }
  let html = `<span class="pinfo">${totalItems} registro(s) · página ${page}/${totalPages}</span>`;
  html += `<button ${page === 1 ? 'disabled' : ''} data-go="${page - 1}">‹</button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - page) <= 1)
      html += `<button class="${i === page ? 'active' : ''}" data-go="${i}">${i}</button>`;
    else if (Math.abs(i - page) === 2) html += `<span class="pinfo">…</span>`;
  }
  html += `<button ${page === totalPages ? 'disabled' : ''} data-go="${page + 1}">›</button>`;
  el.innerHTML = html;
  el.querySelectorAll('button[data-go]').forEach(b => b.onclick = () => onGo(+b.dataset.go));
}

function updateSortHeaders(tableSel, sort) {
  $$(`${tableSel} thead th`).forEach(th => {
    th.classList.remove('sorted', 'desc');
    if (th.dataset.sort === sort.field) { th.classList.add('sorted'); if (sort.dir === 'desc') th.classList.add('desc'); }
  });
}

function openConfirm(title, msg, onYes) {
  openModal(title, `
    <p style="color:var(--muted);line-height:1.6">${msg}</p>
    <div class="form-actions">
      <button class="btn btn-ghost" id="cfNo">Cancelar</button>
      <button class="btn btn-danger" id="cfYes">Sí, continuar</button>
    </div>`);
  $('#cfNo').onclick = closeModal;
  $('#cfYes').onclick = () => { closeModal(); onYes(); };
}

/* ================================================================== */
/* Navegación y wiring de eventos                                    */
/* ================================================================== */
function switchView(view) {
  currentView = view;
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
  $('#sidebar').classList.remove('open');
  render();
}

function wireEvents() {
  // Navegación (Se agregó lógica para esconder el Sidebar usando la clase 'sidebar-closed')
  $$('.nav-item').forEach(b => b.onclick = () => switchView(b.dataset.view));
  $('#btnToggleSidebar').onclick = () => {
    document.body.classList.toggle('sidebar-closed');
  };

  // Botón para cerrar la alerta (X)
  const btnCloseAlert = $('#closeAlert');
  if (btnCloseAlert) {
    btnCloseAlert.onclick = () => $('#alertBanner').classList.add('hidden');
  }

  // Cabecera global
  $('#periodSelect').onchange = () => { ui.dashPage = 1; render(); };
  $('#btnRefresh').onclick = () => { render(); toast('Datos actualizados'); };
  $('#btnTheme').onclick = toggleTheme;

  // Modal genérico
  $('#modalClose').onclick = closeModal;
  $('#modalOverlay').onclick = e => { if (e.target.id === 'modalOverlay') closeModal(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // Dashboard
  $('#dashSearch').oninput = e => { ui.dashSearch = e.target.value; ui.dashPage = 1; renderDashboard(); };
  $$('#dashTable thead th').forEach(th => th.onclick = () => {
    const f = th.dataset.sort; if (!f) return;
    if (ui.dashSort.field === f) ui.dashSort.dir = ui.dashSort.dir === 'asc' ? 'desc' : 'asc';
    else ui.dashSort = { field: f, dir: 'asc' };
    renderDashboard();
  });

  // Productos
  $('#btnNuevoProducto').onclick = () => productForm(null);
  $('#prodSearch').oninput = e => { ui.prodSearch = e.target.value; renderProductos(); };
  $('#prodFilterEstado').onchange = e => { ui.prodEstado = e.target.value; renderProductos(); };
  $('#prodSortField').onchange = e => { ui.prodSortField = e.target.value; renderProductos(); };
  $('#prodSortDir').onclick = e => {
    ui.prodSortDir = ui.prodSortDir === 'asc' ? 'desc' : 'asc';
    e.target.dataset.dir = ui.prodSortDir;
    e.target.textContent = ui.prodSortDir === 'asc' ? '▲ Asc' : '▼ Desc';
    renderProductos();
  };
  $('#productGrid').onclick = e => {
    const ed = e.target.closest('[data-edit-prod]'); const dl = e.target.closest('[data-del-prod]');
    if (ed) productForm(DB.productos.find(p => p.id === ed.dataset.editProd));
    if (dl) deleteProducto(dl.dataset.delProd);
  };

  // Movimientos
  $('#btnNuevoMovimiento').onclick = () => movForm(null);
  $('#movSearch').oninput = e => { ui.movSearch = e.target.value; ui.movPage = 1; renderMovimientos(); };
  $('#movFilterTipo').onchange = e => { ui.movTipo = e.target.value; ui.movPage = 1; renderMovimientos(); };
  $$('#movTable thead th').forEach(th => th.onclick = () => {
    const f = th.dataset.sort; if (!f) return;
    if (ui.movSort.field === f) ui.movSort.dir = ui.movSort.dir === 'asc' ? 'desc' : 'asc';
    else ui.movSort = { field: f, dir: 'asc' };
    renderMovimientos();
  });
  $('#movTable').onclick = e => {
    const ed = e.target.closest('[data-edit-mov]'); const dl = e.target.closest('[data-del-mov]');
    if (ed) movForm(DB.movimientos.find(m => m.id === ed.dataset.editMov));
    if (dl) deleteMov(dl.dataset.delMov);
  };

  // Configuración
  $('#configForm').onsubmit = e => {
    e.preventDefault();
    const u = {
      sana: parseInt($('#cfgSana').value, 10), 
      lenta: parseInt($('#cfgLenta').value, 10),
      muyLenta: parseInt($('#cfgMuyLenta').value, 10)
    };
    if (!(u.sana <= u.lenta && u.lenta <= u.muyLenta)) {
      toast('Los umbrales deben ser crecientes (Sana ≤ Lenta ≤ Muy Lenta)', 'err'); return;
    }
    DB.config.umbrales = u;
    toast('Umbrales guardados');
    persistAndRender();
  };
  $('#btnResetConfig').onclick = () => {
    DB.config.umbrales = { sana: 7, lenta: 15, muyLenta: 30 };
    renderConfig(); persistAndRender(); toast('Umbrales restablecidos');
  };

  // Exportar
  $('#btnExport').onclick = exportExcel;
}

/* ================================================================== */
/* Arranque                                                          */
/* ================================================================== */
async function init() {
  initTheme();
  DB = await Store.load();
  // Saneamiento mínimo del esquema
  if (!DB.config) DB.config = Engine.defaultDB().config;
  if (!DB.config.umbrales) DB.config.umbrales = Engine.defaultDB().config.umbrales;
  if (!DB.productos) DB.productos = [];
  if (!DB.movimientos) DB.movimientos = [];
  wireEvents();
  switchView('rotacion');
}

// Arranca solo en navegador/Electron; en Node (pruebas) se exporta el motor.
if (typeof document !== 'undefined') {
  init();
} else if (typeof module !== 'undefined') {
  module.exports = { Engine };
}