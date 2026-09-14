// RESOLVER DE CAPAS: base -> globales -> personales -> vista del usuario.
const fs = require('fs');
const path = require('path');
const incorporado = require('./horario-base');
const overrides = require('./overrides');
const { TZ, DATA_DIR } = require('./config');

// El horario de src/horario-base.js es el que viene de fábrica. Si existe
// data/horario.json, manda ese: así se cambia el horario en caliente, sin tocar
// el código ni reconstruir la imagen. Si el fichero está mal, se avisa y se
// sigue con el incorporado en vez de dejar el bot sin horario.
let BASE = incorporado.clases;
let calendario = incorporado.calendario;
let origenHorario = 'incorporado';

function validar(d) {
  if (!d || typeof d !== 'object') throw new Error('no es un objeto');
  if (!Array.isArray(d.clases) || !d.clases.length) throw new Error('falta "clases"');
  d.clases.forEach((c, i) => {
    for (const campo of ['semestre', 'dia', 'inicio', 'fin', 'asignatura']) {
      if (c[campo] === undefined) throw new Error(`clase ${i}: falta "${campo}"`);
    }
    if (!/^\d{1,2}:\d{2}$/.test(c.inicio) || !/^\d{1,2}:\d{2}$/.test(c.fin)) {
      throw new Error(`clase ${i}: hora con formato inválido`);
    }
    if (c.dia < 0 || c.dia > 6) throw new Error(`clase ${i}: "dia" fuera de 0-6`);
    if (!c.id) c.id = `x-s${c.semestre}-d${c.dia}-${c.inicio.replace(':', '')}-${i}`;
  });
  if (d.calendario && !Array.isArray(d.calendario.semestres)) {
    throw new Error('"calendario.semestres" debe ser una lista');
  }
  return d;
}

function cargarPersonalizado(logger) {
  const f = path.join(DATA_DIR, 'horario.json');
  try {
    if (!fs.existsSync(f)) return false;
    const d = validar(JSON.parse(fs.readFileSync(f, 'utf8')));
    BASE = d.clases;
    if (d.calendario) calendario = { ...incorporado.calendario, ...d.calendario };
    origenHorario = 'data/horario.json';
    logger && logger.info(`horario cargado de data/horario.json: ${BASE.length} clases`);
    return true;
  } catch (e) {
    logger && logger.error(`data/horario.json inválido (${e.message}); sigo con el horario incorporado`);
    return false;
  }
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// ---------- fechas ----------
function hoyISO(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, dateStyle: 'short' }).format(d);
}
function horaAhora(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, timeStyle: 'short' }).format(d).slice(0, 5);
}
function diaSemana(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=domingo
}
function sumarDias(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function entre(iso, a, b) { return iso >= a && iso <= b; }
const aMin = h => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };

// ---------- calendario ----------
function semestreDe(iso) {
  return calendario.semestres.find(s => entre(iso, s.inicio, s.fin)) || null;
}
function vacacionesDe(iso) {
  return calendario.vacaciones.find(v => entre(iso, v.inicio, v.fin)) || null;
}
function examenesDe(iso) {
  return calendario.examenes.find(v => entre(iso, v.inicio, v.fin)) || null;
}
function semanaDe(iso) {
  const s = semestreDe(iso);
  if (!s) return null;
  const [y1, m1, d1] = s.inicio.split('-').map(Number);
  const [y2, m2, d2] = iso.split('-').map(Number);
  const dias = (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000;
  return { semestre: s.n, semana: Math.floor(dias / 7) + 1 };
}

// ---------- matching ----------
const normaliza = s => (s || '')
  .toString().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9 ]/g, '').trim();

const ALIAS = {
  'algebra': 'algebra',
  'circuitos': 'analisis de circuitos',
  'analisis': 'analisis de circuitos',
  'lineales': 'programacion con estructuras lineales',
  'estructuras': 'programacion con estructuras lineales',
  'pel': 'programacion con estructuras lineales',
  'software': 'introduccion a la ingenieria del software',
  'iis': 'introduccion a la ingenieria del software',
  'concurrente': 'programacion concurrente y distribuida',
  'pcd': 'programacion concurrente y distribuida',
  'proyecto': 'proyecto de informatica',
  'bd': 'bases de datos',
  'bbdd': 'bases de datos',
  'datos': 'bases de datos',
  'impacto': 'impacto e influencia relacional',
  'tpa': 'tecnicas de programacion avanzadas',
  'tecnicas': 'tecnicas de programacion avanzadas',
  'estadistica': 'estadistica y optimizacion',
};

function canon(texto) {
  const n = normaliza(texto);
  if (ALIAS[n]) return ALIAS[n];
  for (const [k, v] of Object.entries(ALIAS)) if (n.includes(k)) return v;
  return n;
}

function mismaAsignatura(a, b) {
  const na = normaliza(a), nb = canon(b);
  return na.includes(nb) || nb.includes(na) || canon(a) === nb;
}

function coincide(clase, match) {
  if (!match || !Object.keys(match).length) return false;
  if (match.id && clase.id !== match.id) return false;
  if (match.asignatura && !mismaAsignatura(clase.asignatura, match.asignatura)) return false;
  if (match.dia != null && clase.dia !== match.dia) return false;
  if (match.inicio && clase.inicio !== match.inicio) return false;
  if (match.semestre != null && clase.semestre !== match.semestre) return false;
  if (match.aula && normaliza(clase.aula) !== normaliza(match.aula)) return false;
  if (match.edificio && normaliza(clase.edificio) !== normaliza(match.edificio)) return false;
  return true;
}

// ---------- aplicación de una capa ----------
function aplicarOverride(ov, clases) {
  switch (ov.tipo) {
    case 'quitar':
      return clases.filter(c => !coincide(c, ov.match));

    case 'cancelar':
      return clases.map(c => coincide(c, ov.match)
        ? { ...c, cancelada: true, motivo: ov.motivo, _ov: ov.id, _scope: ov.scope } : c);

    case 'aula':
      return clases.map(c => coincide(c, ov.match)
        ? { ...c,
            edificio: ov.set.edificio ?? c.edificio,
            aula: ov.set.aula ?? c.aula,
            _cambiado: 'aula', _ov: ov.id, _scope: ov.scope, _antes: `${c.edificio} ${c.aula}` } : c);

    case 'hora':
      return clases.map(c => coincide(c, ov.match)
        ? { ...c,
            inicio: ov.set.inicio ?? c.inicio,
            fin: ov.set.fin ?? c.fin,
            _cambiado: 'hora', _ov: ov.id, _scope: ov.scope, _antes: `${c.inicio}-${c.fin}` } : c);

    case 'mover':
      return clases.map(c => coincide(c, ov.match)
        ? { ...c,
            dia: ov.set.dia ?? c.dia,
            inicio: ov.set.inicio ?? c.inicio,
            fin: ov.set.fin ?? c.fin,
            _cambiado: 'movida', _ov: ov.id, _scope: ov.scope } : c);

    case 'anadir':
      return [...clases, {
        id: `extra_${ov.id}`,
        semestre: ov.set.semestre,
        dia: ov.set.dia,
        inicio: ov.set.inicio,
        fin: ov.set.fin,
        asignatura: ov.set.asignatura,
        edificio: ov.set.edificio || '—',
        aula: ov.set.aula || '—',
        _cambiado: 'añadida', _ov: ov.id, _scope: ov.scope,
      }];

    default:
      return clases;
  }
}

// ---------- resolución ----------
// Devuelve TODAS las clases del semestre ya resueltas para ese usuario.
function resolverSemestre(jid, iso) {
  const sem = semestreDe(iso);
  if (!sem) return { sem: null, clases: [] };

  let clases = BASE.filter(c => c.semestre === sem.n).map(c => ({ ...c }));
  const ignorados = overrides.ignoradosPor(jid);

  for (const ov of overrides.paraUsuario(jid)) {
    if (ov.tipo === 'ignorar-global') continue;
    if (ov.scope === 'global' && ignorados.has(ov.id)) continue;
    if (ov.fecha && ov.fecha !== iso) continue;   // cambio puntual de otro día
    clases = aplicarOverride(ov, clases);
  }

  clases.sort((a, b) => a.dia - b.dia || aMin(a.inicio) - aMin(b.inicio));
  return { sem, clases };
}

function estadoDelDia(iso) {
  const festivo = calendario.festivos[iso];
  if (festivo) return { tipo: 'festivo', nombre: festivo };
  const vac = vacacionesDe(iso);
  if (vac) return { tipo: 'vacaciones', nombre: vac.nombre };
  const dow = diaSemana(iso);
  if (dow === 0 || dow === 6) return { tipo: 'finde', nombre: DIAS[dow] };
  if (!semestreDe(iso)) return { tipo: 'fuera', nombre: 'fuera de período lectivo' };
  return { tipo: 'lectivo', nombre: DIAS[dow] };
}

function clasesDeDia(jid, iso) {
  const estado = estadoDelDia(iso);
  if (estado.tipo !== 'lectivo') return { estado, clases: [] };
  const { clases } = resolverSemestre(jid, iso);
  const dow = diaSemana(iso);
  return { estado, clases: clases.filter(c => c.dia === dow) };
}

function proximaClase(jid, iso, hhmm) {
  for (let i = 0; i < 10; i++) {
    const f = sumarDias(iso, i);
    const { clases } = clasesDeDia(jid, f);
    const activas = clases.filter(c => !c.cancelada);
    for (const c of activas) {
      if (i > 0 || aMin(c.inicio) > aMin(hhmm)) return { clase: c, fecha: f, hoy: i === 0 };
    }
  }
  return null;
}

function claseAhora(jid, iso, hhmm) {
  const { clases } = clasesDeDia(jid, iso);
  const m = aMin(hhmm);
  return clases.find(c => !c.cancelada && aMin(c.inicio) <= m && m < aMin(c.fin)) || null;
}

module.exports = {
  DIAS,
  get calendario() { return calendario; },
  get BASE() { return BASE; },
  get origenHorario() { return origenHorario; },
  cargarPersonalizado,
  hoyISO, horaAhora, diaSemana, sumarDias, aMin,
  semestreDe, semanaDe, vacacionesDe, examenesDe, estadoDelDia,
  normaliza, canon, mismaAsignatura, coincide,
  resolverSemestre, clasesDeDia, proximaClase, claseAhora,
};
