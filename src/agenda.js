// AGENDA PERSONAL: tareas, notas y recordatorios de cada persona.
//
// Un fichero por persona en data/agenda/, con nombre derivado de su JID. Nada
// de una persona vive junto a lo de otra, y nada de esto llega nunca al modelo
// ni a los registros de otra conversación.
//
// Borrar es borrar de verdad: no hay papelera, marcas de "eliminado" ni copia.
// Lo que se quita desaparece del fichero, y si alguien lo borra todo,
// desaparece el fichero entero.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const store = require('./store');
const log = require('./log');
const T = require('./tiempo');

const DIR = path.join(cfg.DATA_DIR, 'agenda');
// Las tareas hechas se ven tachadas una semana; después se van solas.
const VIDA_HECHAS_MS = 7 * 86400000;

const docs = new Map();
// Último aviso mandado a cada uno, para poder posponerlo. Solo en memoria: no
// hace falta que sobreviva a un reinicio y así no queda rastro en disco.
const ultimos = new Map();

const archivo = jid => path.join(DIR, crypto.createHash('sha256').update(jid).digest('hex').slice(0, 24) + '.json');
const nuevoId = pre => pre + crypto.randomBytes(5).toString('hex');

function vacio(jid) {
  return { jid, tareas: [], notas: [], recordatorios: [], ajustes: { repaso: true }, ultimoRepaso: null };
}

function normalizar(d) {
  const v = vacio(d.jid);
  return {
    ...v, ...d,
    tareas: Array.isArray(d.tareas) ? d.tareas : [],
    notas: Array.isArray(d.notas) ? d.notas : [],
    recordatorios: Array.isArray(d.recordatorios) ? d.recordatorios : [],
    ajustes: { ...v.ajustes, ...(d.ajustes || {}) },
  };
}

function cargar() {
  store.asegurarDir(DIR);
  docs.clear();
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    const d = store.leer(path.join(DIR, f), null);
    if (d && d.jid) docs.set(d.jid, normalizar(d));
  }
  migrarTareasViejas();
  purgar();
  const n = [...docs.values()];
  log.info(`agenda: ${n.length} personas · ${n.reduce((a, d) => a + d.tareas.length, 0)} tareas · ` +
    `${n.reduce((a, d) => a + d.notas.length, 0)} notas · ${n.reduce((a, d) => a + d.recordatorios.length, 0)} recordatorios`);
}

// tasks.json era el formato anterior, todo en un fichero. Se reparte por
// persona una sola vez y el original se borra.
function migrarTareasViejas() {
  const viejo = cfg.F.tareas;
  if (!viejo || !fs.existsSync(viejo)) return;
  const d = store.leer(viejo, {});
  let n = 0;
  for (const [jid, lista] of Object.entries(d || {})) {
    if (!Array.isArray(lista) || !lista.length) continue;
    const doc = de(jid);
    for (const t of lista) {
      doc.tareas.push({
        id: t.id || nuevoId('t'), texto: t.texto, creada: t.creada || Date.now(),
        para: t.para || null, hecha: !!t.hecha, hechaEn: t.hechaEn || null,
      });
      n++;
    }
    guardar(jid);
  }
  store.borrar(viejo);
  if (n) log.info(`agenda: ${n} tareas migradas del formato anterior`);
}

function de(jid) {
  if (!docs.has(jid)) docs.set(jid, vacio(jid));
  return docs.get(jid);
}
const existe = jid => docs.has(jid);

function vacia(d) {
  return !d.tareas.length && !d.notas.length && !d.recordatorios.length && d.ajustes.repaso !== false;
}

// Si alguien se queda sin nada apuntado no se le guarda un fichero vacío.
function guardar(jid) {
  const d = docs.get(jid);
  if (!d) return;
  if (vacia(d)) { docs.delete(jid); return store.borrar(archivo(jid)); }
  return store.escribir(archivo(jid), d);
}

// ---------------- tareas ----------------
// Orden de lectura: pendientes por antigüedad, luego hechas. El número que ve
// la persona es la posición en esta lista.
function tareas(jid) {
  const d = docs.get(jid);
  if (!d) return [];
  const pend = d.tareas.filter(t => !t.hecha).sort((a, b) => a.creada - b.creada);
  const hechas = d.tareas.filter(t => t.hecha).sort((a, b) => a.hechaEn - b.hechaEn);
  return [...pend, ...hechas];
}
const pendientes = jid => tareas(jid).filter(t => !t.hecha);

function crearTarea(jid, texto, para = null) {
  const t = { id: nuevoId('t'), texto: limpiarTexto(texto), creada: Date.now(), para, hecha: false, hechaEn: null };
  de(jid).tareas.push(t);
  guardar(jid);
  return t;
}
function completar(jid, id) {
  const t = de(jid).tareas.find(x => x.id === id);
  if (!t || t.hecha) return null;
  t.hecha = true; t.hechaEn = Date.now();
  guardar(jid);
  return t;
}
function reabrir(jid, id) {
  const t = de(jid).tareas.find(x => x.id === id);
  if (!t || !t.hecha) return null;
  t.hecha = false; t.hechaEn = null;
  t.creada = Date.now();          // vuelve al final de las pendientes
  guardar(jid);
  return t;
}
function quitarDe(jid, coleccion, id) {
  const d = docs.get(jid);
  if (!d) return null;
  const i = d[coleccion].findIndex(x => x.id === id);
  if (i < 0) return null;
  const [x] = d[coleccion].splice(i, 1);
  guardar(jid);
  return x;
}
const borrarTarea = (jid, id) => quitarDe(jid, 'tareas', id);
function limpiarHechas(jid) {
  const d = docs.get(jid);
  if (!d) return 0;
  const antes = d.tareas.length;
  d.tareas = d.tareas.filter(t => !t.hecha);
  guardar(jid);
  return antes - d.tareas.length;
}
function vaciar(jid, coleccion) {
  const d = docs.get(jid);
  if (!d) return 0;
  const n = d[coleccion].length;
  d[coleccion] = [];
  guardar(jid);
  return n;
}

// ---------------- notas ----------------
function notas(jid) {
  const d = docs.get(jid);
  return d ? [...d.notas].sort((a, b) => a.creada - b.creada) : [];
}
function crearNota(jid, texto) {
  const n = { id: nuevoId('n'), texto: limpiarTexto(texto), creada: Date.now() };
  de(jid).notas.push(n);
  guardar(jid);
  return n;
}
const borrarNota = (jid, id) => quitarDe(jid, 'notas', id);

// ---------------- recordatorios ----------------
function recordatorios(jid) {
  const d = docs.get(jid);
  return d ? [...d.recordatorios].sort((a, b) => a.ts - b.ts) : [];
}
function crearRecordatorio(jid, { texto, ts, repetir = null, tipo = 'recordatorio', duracionMs = null }) {
  const r = { id: nuevoId('r'), texto: limpiarTexto(texto || ''), ts, repetir, tipo, duracionMs, creado: Date.now() };
  de(jid).recordatorios.push(r);
  guardar(jid);
  return r;
}
const borrarRecordatorio = (jid, id) => quitarDe(jid, 'recordatorios', id);
function actualizarRecordatorio(jid, id, cambios) {
  const r = de(jid).recordatorios.find(x => x.id === id);
  if (!r) return null;
  Object.assign(r, cambios);
  guardar(jid);
  return r;
}

// Los que ya toca mandar, de todo el mundo.
function vencidos(ahora = Date.now()) {
  const out = [];
  for (const d of docs.values()) for (const r of d.recordatorios) if (r.ts <= ahora) out.push({ jid: d.jid, r });
  return out.sort((a, b) => a.r.ts - b.r.ts);
}

// Tras avisar: uno que se repite pasa a su siguiente vez; el resto desaparece.
function avisado(jid, id, ahora = Date.now()) {
  const d = docs.get(jid);
  if (!d) return;
  const r = d.recordatorios.find(x => x.id === id);
  if (!r) return;
  ultimos.set(jid, { texto: r.texto, tipo: r.tipo, duracionMs: r.duracionMs, ts: ahora });
  if (r.repetir) {
    // Si el bot estuvo caído varios ciclos, se salta a la próxima futura en vez
    // de soltar todos los atrasados de golpe.
    r.ts = T.siguienteRepeticion(r.repetir, Math.max(ahora, r.ts));
  } else {
    d.recordatorios = d.recordatorios.filter(x => x.id !== id);
  }
  guardar(jid);
}

// ---------------- ajustes y repaso ----------------
function ajustar(jid, clave, valor) {
  de(jid).ajustes[clave] = valor;
  guardar(jid);
}
function marcarRepaso(jid, iso) {
  const d = docs.get(jid);
  if (!d) return;
  d.ultimoRepaso = iso;
  guardar(jid);
}

// ---------------- borrado total ----------------
function borrarTodo(jid) {
  const d = docs.get(jid);
  ultimos.delete(jid);
  const resumen = d ? { tareas: d.tareas.length, notas: d.notas.length, recordatorios: d.recordatorios.length } : null;
  docs.delete(jid);
  store.borrar(archivo(jid));
  return resumen;
}

// ---------------- mantenimiento ----------------
function purgar(ahora = Date.now()) {
  for (const d of [...docs.values()]) {
    const antes = d.tareas.length;
    d.tareas = d.tareas.filter(t => !t.hecha || ahora - (t.hechaEn || 0) < VIDA_HECHAS_MS);
    if (d.tareas.length !== antes || vacia(d)) guardar(d.jid);
  }
}

const todos = () => [...docs.values()];
const ultimoAviso = jid => ultimos.get(jid) || null;

function limpiarTexto(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

module.exports = {
  cargar, de, existe, guardar, todos, purgar,
  tareas, pendientes, crearTarea, completar, reabrir, borrarTarea, limpiarHechas, vaciar,
  notas, crearNota, borrarNota,
  recordatorios, crearRecordatorio, borrarRecordatorio, actualizarRecordatorio, vencidos, avisado,
  ajustar, marcarRepaso, borrarTodo, limpiarTexto, ultimoAviso,
  DIR,
};
