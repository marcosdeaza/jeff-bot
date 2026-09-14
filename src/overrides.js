// L1 (global) y L2 (personal) — almacén de modificaciones sobre la base.
// Un override NUNCA edita L0: se aplica encima al resolver. Por eso todo
// cambio es reversible y auditable (quién, cuándo, por qué).
const { F } = require('./config');
const store = require('./store');
const log = require('./log');

let lista = [];
let seq = 0;   // contador monótono: desempata cambios creados en el mismo ms

function cargar() {
  lista = store.leer(F.overrides, []);
  if (!Array.isArray(lista)) lista = [];
  seq = lista.reduce((m, o) => Math.max(m, o.seq || 0), 0);
  log.info(`overrides cargados: ${lista.length} (${lista.filter(o => o.scope === 'global').length} globales)`);
}

function guardar() {
  return store.escribir(F.overrides, lista);
}

function crear({ scope, owner, tipo, match, set, fecha = null, motivo = '', creadoPor }) {
  const ov = {
    id: `ov_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    seq: ++seq,
    scope,                       // 'global' | 'personal'
    owner: scope === 'personal' ? owner : null,
    tipo,                        // aula | hora | quitar | anadir | cancelar | mover
    match: match || {},
    set: set || {},
    fecha,                       // null = permanente | 'YYYY-MM-DD' = solo ese día
    motivo,
    creadoPor,
    creadoEn: Date.now(),
    activo: true,
  };
  lista.push(ov);
  guardar();
  return ov;
}

// Overrides que aplican a un usuario: los globales activos + los suyos propios.
// Orden: globales primero, personales después (lo personal manda sobre lo global).
function paraUsuario(jid) {
  return lista
    .filter(o => o.activo && (o.scope === 'global' || o.owner === jid))
    .sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === 'global' ? -1 : 1;
      return (a.seq || 0) - (b.seq || 0);
    });
}

function personalesDe(jid) {
  return lista.filter(o => o.activo && o.scope === 'personal' && o.owner === jid);
}

function globales() {
  return lista.filter(o => o.activo && o.scope === 'global');
}

function desactivar(id, porQuien) {
  const ov = lista.find(o => o.id === id && o.activo);
  if (!ov) return null;
  ov.activo = false;
  ov.revertidoPor = porQuien;
  ov.revertidoEn = Date.now();
  guardar();
  return ov;
}

// Deshace el último cambio que hizo esa persona (personal o global suyo).
function deshacerUltimo(jid) {
  const suyos = lista
    .filter(o => o.activo && o.creadoPor === jid)
    .sort((a, b) => (b.seq || 0) - (a.seq || 0));
  if (!suyos.length) return null;
  return desactivar(suyos[0].id, jid);
}

// "Esto a mí no me aplica": convierte un global en exclusión personal,
// sin tocar el global de los demás.
function excluirseDeGlobal(jid, overrideGlobalId) {
  const g = lista.find(o => o.id === overrideGlobalId && o.scope === 'global' && o.activo);
  if (!g) return null;
  return crear({
    scope: 'personal',
    owner: jid,
    tipo: 'ignorar-global',
    match: { overrideId: overrideGlobalId },
    set: {},
    motivo: 'No me aplica',
    creadoPor: jid,
  });
}

function ignoradosPor(jid) {
  return new Set(
    lista
      .filter(o => o.activo && o.scope === 'personal' && o.owner === jid && o.tipo === 'ignorar-global')
      .map(o => o.match.overrideId)
  );
}

function todos() { return lista; }

// Recoge overrides añadidos desde fuera del proceso (un docker exec de
// administración) sin pisar los que ya hay en memoria. Sin esto, el siguiente
// guardado del bot sobrescribiría esos cambios externos.
function sincronizar() {
  const enDisco = store.leer(F.overrides, []);
  if (!Array.isArray(enDisco)) return 0;
  const conocidos = new Set(lista.map(o => o.id));
  let nuevos = 0;
  for (const o of enDisco) if (!conocidos.has(o.id)) { lista.push(o); nuevos++; }
  if (nuevos) {
    seq = lista.reduce((m, o) => Math.max(m, o.seq || 0), 0);
    log.info(`overrides externos detectados: ${nuevos}`);
  }
  return nuevos;
}

module.exports = {
  cargar, guardar, crear, paraUsuario, personalesDe, globales,
  desactivar, deshacerUltimo, excluirseDeGlobal, ignoradosPor, todos, sincronizar,
};
