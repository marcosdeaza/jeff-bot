// L0 — BASE CANÓNICA. Datos oficiales del grado. No se modifica en caliente:
// todo cambio vive como override en L1 (global) o L2 (personal).
// dia: 1=lunes ... 5=viernes

const C = (semestre, dia, inicio, fin, asignatura, edificio, aula) => ({
  id: `s${semestre}-d${dia}-${inicio.replace(':', '')}-${asignatura.toLowerCase().replace(/[^a-z]/g, '').slice(0, 10)}`,
  semestre, dia, inicio, fin, asignatura, edificio, aula,
});

const clases = [
  // ---------- SEMESTRE 1 ----------
  C(1, 1, '10:30', '12:30', 'Álgebra', 'VG25', 'M11'),
  C(1, 1, '14:30', '16:30', 'Análisis de circuitos', 'VG04', 'M21'),
  C(1, 1, '16:30', '18:30', 'Programación con estructuras lineales', 'VH09', 'M21'),
  C(1, 1, '18:30', '20:30', 'Introducción a la ingeniería del software', 'VG12', 'M21'),

  C(1, 2, '14:30', '16:30', 'Análisis de circuitos', 'VH02', 'M21'),
  C(1, 2, '16:30', '18:30', 'Programación concurrente y distribuida', 'VH09', 'M21'),

  C(1, 3, '14:30', '16:30', 'Programación con estructuras lineales', 'VH09', 'M21'),
  C(1, 3, '16:30', '18:30', 'Programación concurrente y distribuida', 'VH09', 'M21'),

  C(1, 4, '14:30', '16:30', 'Proyecto de informática I', 'VH07', 'M21'),
  C(1, 4, '16:30', '18:30', 'Proyecto de informática I', 'VG08', 'M21'),

  C(1, 5, '08:30', '10:30', 'Álgebra', 'VG25', 'M11'),
  C(1, 5, '14:30', '16:30', 'Introducción a la ingeniería del software', 'VH07', 'M21'),

  // ---------- SEMESTRE 2 ----------
  C(2, 1, '14:30', '16:30', 'Impacto e influencia relacional', 'VG12', 'M21'),
  C(2, 1, '16:30', '18:30', 'Bases de datos', 'VG12', 'M21'),
  C(2, 1, '18:30', '20:30', 'Proyecto de informática II', 'VG12', 'M21'),

  C(2, 2, '14:30', '16:30', 'Bases de datos', 'VH09', 'M21'),
  C(2, 2, '16:30', '18:30', 'Técnicas de programación avanzadas', 'VH09', 'M21'),
  C(2, 2, '18:30', '20:30', 'Estadística y optimización', 'VG12', 'M21'),

  C(2, 3, '16:30', '18:30', 'Estadística y optimización', 'VG08', 'M21'),

  C(2, 4, '14:30', '16:30', 'Técnicas de programación avanzadas', 'VH09', 'M21'),
  C(2, 4, '16:30', '18:30', 'Proyecto de informática II', 'VG12', 'M21'),

  C(2, 5, '14:30', '16:30', 'Impacto e influencia relacional', 'VG02', 'M21'),
];

const calendario = {
  curso: '2026/2027',
  titulacion: '2º Ingeniería Informática',
  universidad: 'Universidad Europea de Valencia',
  semestres: [
    { n: 1, inicio: '2026-09-07', fin: '2026-12-22' },
    { n: 2, inicio: '2027-01-25', fin: '2027-05-28' },
  ],
  festivos: {
    '2026-10-09': 'Día de la Comunitat Valenciana',
    '2026-10-12': 'Fiesta Nacional de España',
    '2026-12-08': 'Inmaculada Concepción',
    '2027-05-26': 'Día libre',
  },
  vacaciones: [
    { nombre: 'Navidad',      inicio: '2026-12-23', fin: '2027-01-06' },
    { nombre: 'Fallas',       inicio: '2027-03-17', fin: '2027-03-19' },
    { nombre: 'Pascua',       inicio: '2027-03-24', fin: '2027-03-26' },
    { nombre: 'Semana Santa', inicio: '2027-03-29', fin: '2027-04-05' },
  ],
  examenes: [
    { nombre: 'Exámenes de enero',          inicio: '2027-01-07', fin: '2027-01-24' },
    { nombre: 'Finales y recuperaciones',   inicio: '2027-06-01', fin: '2027-06-30' },
  ],
};

// VH = edificio nuevo · VG = edificio antiguo
const edificios = { VH: 'edificio nuevo', VG: 'edificio antiguo' };

module.exports = { clases, calendario, edificios };
