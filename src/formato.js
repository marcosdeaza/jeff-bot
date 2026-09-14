// Render para WhatsApp. Estilo limpio: hora de inicio, nombre corto en negrita
// y edificio debajo. Sin iconos, sin rangos, sin aula, sin contadores.
const { DIAS } = require('./horario');

// Nombres cortos: los oficiales son larguísimos para leerlos en el móvil.
const CORTO = {
  'Álgebra': 'Álgebra',
  'Análisis de circuitos': 'Análisis de circuitos',
  'Programación con estructuras lineales': 'Prog. estructuras lineales',
  'Introducción a la ingeniería del software': 'Intro ingeniería software',
  'Programación concurrente y distribuida': 'Prog. concurrente',
  'Proyecto de informática I': 'Proyecto informática I',
  'Proyecto de informática II': 'Proyecto informática II',
  'Impacto e influencia relacional': 'Impacto e influencia',
  'Bases de datos': 'Bases de datos',
  'Técnicas de programación avanzadas': 'Técnicas prog. avanzadas',
  'Estadística y optimización': 'Estadística y optimización',
};
const nombre = a => CORTO[a] || a;

function clase(c) {
  let l = `${c.inicio} *${nombre(c.asignatura)}*\n${c.edificio}`;
  if (c.cancelada) l += ' (anulada)';
  else if (c._cambiado === 'aula') l += ` (antes ${(c._antes || '').split(' ')[0]})`;
  return l;
}

function lista(clases) {
  return clases.map(clase).join('\n\n');
}

function dia(fechaISO, estado, clases, cabecera, sufijo) {
  const d = DIAS[new Date(fechaISO + 'T00:00:00Z').getUTCDay()];
  const cab = cabecera || `Hoy es ${d}.`;
  if (estado.tipo === 'festivo')    return `${cab} Es festivo (${estado.nombre}), no hay clase.`;
  if (estado.tipo === 'vacaciones') return `${cab} Estás de ${estado.nombre}, no hay clase.`;
  if (estado.tipo === 'finde')      return `${cab} Es fin de semana, no hay clase.`;
  if (estado.tipo === 'examenes')   return `${cab} Estás en ${estado.nombre}, no hay clases normales. Escribe exámenes para ver lo que tienes apuntado.`;
  if (estado.tipo === 'fuera')      return `${cab} Estamos fuera del período lectivo.`;
  if (!clases.length)               return `${cab} No tienes clase.`;
  return `${cab}${sufijo ? ' ' + sufijo : ''}\n\n${lista(clases)}`;
}

function semana(clasesPorDia) {
  const bloques = [];
  for (let d = 1; d <= 5; d++) {
    const cs = clasesPorDia[d] || [];
    const cab = `*${DIAS[d].charAt(0).toUpperCase() + DIAS[d].slice(1)}*`;
    if (!cs.length) { bloques.push(`${cab}\nsin clase`); continue; }
    bloques.push(cab + '\n' + cs.map(c =>
      `${c.inicio} ${nombre(c.asignatura)}${c.cancelada ? ' (anulada)' : ''} · ${c.edificio}`).join('\n'));
  }
  return bloques.join('\n\n');
}

// Endurece lo que devuelve el LLM: un solo asterisco, sin encabezados markdown,
// línea en blanco antes de cada hora, y fuera los iconos que se le escapen.
function limpiarLLM(texto) {
  if (!texto) return texto;
  let t = texto
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '');
  const out = [];
  for (const linea of t.split('\n')) {
    if (/^\d{1,2}[:.]\d{2}/.test(linea.trim()) && out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(linea.replace(/[ \t]+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { clase, lista, dia, semana, limpiarLLM, nombre, CORTO };
