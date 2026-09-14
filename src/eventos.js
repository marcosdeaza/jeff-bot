// L3 — EVENTOS (exámenes, deberes, avisos) con el mismo modelo de scope.
const { F } = require('./config');
const store = require('./store');
const log = require('./log');

let mapa = new Map();
let seq = 0;

function cargar() {
  const datos = store.leer(F.eventos, {});
  mapa = new Map(Object.entries(datos));
  // Migración: los eventos antiguos no tenían scope -> se asumen globales.
  let migrados = 0;
  for (const [id, ev] of mapa) {
    if (!ev.scope) { ev.scope = 'global'; ev.owner = null; migrados++; }
    if (!ev.seq) ev.seq = ++seq;
    seq = Math.max(seq, ev.seq);
  }
  if (migrados) { log.info(`eventos migrados a scope global: ${migrados}`); guardar(); }
  log.info(`eventos cargados: ${mapa.size}`);
}

function guardar() { return store.escribir(F.eventos, Object.fromEntries(mapa)); }

function crear({ texto, scope, owner, autor, fecha = null, asignatura = null }) {
  const id = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const ev = {
    id, seq: ++seq, texto,
    scope: scope || 'global',
    owner: scope === 'personal' ? owner : null,
    asignatura, fecha,
    autor, creado: Date.now(), activo: true,
  };
  mapa.set(id, ev);
  guardar();
  return ev;
}

function paraUsuario(jid) {
  return [...mapa.values()]
    .filter(e => e.activo !== false && (e.scope === 'global' || e.owner === jid))
    .sort((a, b) => (a.fecha || '9999').localeCompare(b.fecha || '9999') || a.seq - b.seq);
}

function personalesDe(jid) {
  return [...mapa.values()].filter(e => e.activo !== false && e.scope === 'personal' && e.owner === jid);
}

function borrar(id, porQuien) {
  const ev = mapa.get(id);
  if (!ev || ev.activo === false) return null;
  ev.activo = false; ev.borradoPor = porQuien; ev.borradoEn = Date.now();
  guardar();
  return ev;
}

function deshacerUltimo(jid) {
  const suyos = [...mapa.values()]
    .filter(e => e.activo !== false && e.autor === jid)
    .sort((a, b) => b.seq - a.seq);
  return suyos.length ? borrar(suyos[0].id, jid) : null;
}

module.exports = { cargar, guardar, crear, paraUsuario, personalesDe, borrar, deshacerUltimo, todos: () => [...mapa.values()] };
