// Registro de quién habla con Jeff. Necesario para difusiones y para saber
// a quién avisar cuando alguien hace un cambio global.
const { F } = require('./config');
const store = require('./store');
const log = require('./log');

let mapa = new Map();

function cargar() {
  mapa = new Map(Object.entries(store.leer(F.usuarios, {})));
  log.info(`usuarios registrados: ${mapa.size}`);
}
function guardar() { return store.escribir(F.usuarios, Object.fromEntries(mapa)); }

function ver(jid, nombre) {
  let u = mapa.get(jid);
  if (!u) {
    u = { jid, nombre: nombre || null, alta: Date.now(), mensajes: 0, ultimoVisto: 0, activo: true };
    mapa.set(jid, u);
    log.info(`usuario nuevo: ${jid}`);
  }
  if (nombre && !u.nombre) u.nombre = nombre;
  u.mensajes++;
  u.ultimoVisto = Date.now();
  guardar();
  return u;
}

function get(jid) { return mapa.get(jid) || null; }
function nombreDe(jid) {
  if (jid === 'sistema') return 'configuración inicial';
  const u = mapa.get(jid);
  return (u && u.nombre) || jid.split('@')[0].slice(-6);
}
function todos() { return [...mapa.values()]; }
function activos() { return [...mapa.values()].filter(u => u.activo !== false); }

// Importa JIDs desde la memoria de conversaciones (para no perder a nadie
// que ya hablaba con el bot antes de existir este registro).
function importarDesdeMemoria(sesiones) {
  let nuevos = 0;
  for (const [jid, s] of Object.entries(sesiones || {})) {
    if (mapa.has(jid)) continue;
    const h = s.historial || [];
    mapa.set(jid, {
      jid, nombre: null,
      alta: h.length ? h[0].ts : Date.now(),
      mensajes: Math.ceil(h.length / 2),
      ultimoVisto: h.length ? h[h.length - 1].ts : 0,
      activo: true, importado: true,
    });
    nuevos++;
  }
  if (nuevos) { guardar(); log.info(`usuarios importados desde memoria: ${nuevos}`); }
  return nuevos;
}

function marcar(jid, campo, valor) {
  const u = mapa.get(jid);
  if (u) { u[campo] = valor; guardar(); }
}

module.exports = { cargar, guardar, ver, get, nombreDe, todos, activos, importarDesdeMemoria, marcar };
