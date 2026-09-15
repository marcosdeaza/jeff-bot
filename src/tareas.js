// TAREAS PERSONALES. Son de cada uno, así que no se pregunta alcance: nadie
// apunta sus deberes para la clase entera.
//
// Una tarea pendiente arrastra de un día para otro, porque seguir pendiente es
// justo lo que hay que recordar. Lo que se reinicia cada día es el recuento de
// hechas: se guarda el día en que se completó, de modo que "hechas hoy" empieza
// en cero cada mañana sin borrar nada.
const { F } = require('./config');
const store = require('./store');
const log = require('./log');
const H = require('./horario');

let mapa = new Map();
let seq = 0;

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function cargar() {
  const d = store.leer(F.tareas, {});
  mapa = new Map(Object.entries(d).map(([j, v]) => [j, Array.isArray(v) ? v : []]));
  for (const lista of mapa.values()) for (const t of lista) seq = Math.max(seq, t.seq || 0);
  const todas = [...mapa.values()].flat();
  log.info(`tareas cargadas: ${todas.length} (${todas.filter(t => !t.hecha).length} pendientes)`);
}

function guardar() { return store.escribir(F.tareas, Object.fromEntries(mapa)); }

const de = jid => mapa.get(jid) || [];

function crear(jid, texto, para = null) {
  const t = {
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    seq: ++seq,
    texto: texto.trim(),
    creada: Date.now(),
    dia: H.hoyISO(),
    para,
    hecha: false,
    hechaEl: null,
  };
  mapa.set(jid, [...de(jid), t]);
  guardar();
  return t;
}

const pendientes = jid => de(jid).filter(t => !t.hecha).sort((a, b) => a.seq - b.seq);
const hechasHoy = jid => de(jid).filter(t => t.hecha && t.hechaEl === H.hoyISO()).sort((a, b) => a.seq - b.seq);

// Basta un trozo del texto, o el número que sale al listarlas.
function buscar(jid, texto) {
  const q = norm(texto);
  if (!q) return [];
  const lista = pendientes(jid);
  const num = q.match(/^(\d{1,2})$/);
  if (num) { const t = lista[+num[1] - 1]; return t ? [t] : []; }
  const exacta = lista.filter(t => norm(t.texto) === q);
  if (exacta.length) return exacta;
  if (q.length < 3) return [];
  return lista.filter(t => norm(t.texto).includes(q) || q.includes(norm(t.texto)));
}

function completar(jid, id) {
  const t = de(jid).find(x => x.id === id);
  if (!t || t.hecha) return null;
  t.hecha = true; t.hechaEl = H.hoyISO(); t.hechaEn = Date.now();
  guardar();
  return t;
}

function descartar(jid, id) {
  const lista = de(jid);
  const i = lista.findIndex(x => x.id === id);
  if (i < 0) return null;
  const [t] = lista.splice(i, 1);
  mapa.set(jid, lista);
  guardar();
  return t;
}

function reabrir(jid, id) {
  const t = de(jid).find(x => x.id === id);
  if (!t || !t.hecha) return null;
  t.hecha = false; t.hechaEl = null; t.hechaEn = null;
  guardar();
  return t;
}

const conPendientes = () => [...mapa.entries()].filter(([, l]) => l.some(t => !t.hecha)).map(([jid]) => jid);

// Recoge tareas añadidas desde fuera del proceso sin pisar las de memoria.
function sincronizar() {
  const enDisco = store.leer(F.tareas, {});
  let nuevas = 0;
  for (const [jid, lista] of Object.entries(enDisco)) {
    const mias = new Set(de(jid).map(t => t.id));
    const añadir = (Array.isArray(lista) ? lista : []).filter(t => !mias.has(t.id));
    if (añadir.length) { mapa.set(jid, [...de(jid), ...añadir]); nuevas += añadir.length; }
  }
  return nuevas;
}

module.exports = {
  cargar, guardar, crear, de, pendientes, hechasHoy, buscar,
  completar, descartar, reabrir, conPendientes, sincronizar,
};
