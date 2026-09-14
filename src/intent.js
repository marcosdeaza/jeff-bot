// Detección local de intención. Dos objetivos:
//  1) responder al instante lo frecuente (sin llamar al LLM) -> más rápido
//  2) detectar PROPUESTAS DE CAMBIO para preguntar el alcance (yo / todos)
const H = require('./horario');

const n = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

// El audio transcrito escribe los números en letra: "VG treinta" -> "VG30"
const NUM = {
  cero: '0', uno: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6',
  siete: '7', ocho: '8', nueve: '9', diez: '10', once: '11', doce: '12',
  trece: '13', catorce: '14', quince: '15', dieciseis: '16', diecisiete: '17',
  dieciocho: '18', diecinueve: '19', veinte: '20', veinticinco: '25', treinta: '30',
};
function digitalizar(t) {
  let s = t;
  // "VG cero cinco" -> "VG05"
  s = s.replace(/\b(vg|vh)\s*((?:(?:cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veinticinco|treinta)\s*)+)/gi,
    (_, pre, pal) => pre + pal.trim().split(/\s+/).map(p => NUM[n(p)] ?? '').join('') + ' ');
  return s;
}

const DIA_NOMBRE = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 0 };

function diasMencionados(t) {
  const out = [];
  for (const [nom, num] of Object.entries(DIA_NOMBRE)) if (new RegExp(`\\b${nom}`).test(t)) out.push(num);
  return [...new Set(out)];
}

function asignaturaMencionada(t) {
  const cands = [...new Set(H.BASE.map(c => c.asignatura))];
  // primero por nombre completo/parcial
  for (const a of cands) {
    const na = n(a);
    if (t.includes(na)) return a;
    const primera = na.split(' ')[0];
    if (primera.length > 4 && t.includes(primera)) return a;
  }
  // luego por alias (algebra, bd, tpa, circuitos...)
  const c = H.canon(t);
  for (const a of cands) if (H.mismaAsignatura(a, c) && c.length > 2) return a;
  return null;
}

// ---------- 1. INTENCIONES DE CONSULTA (respuesta local) ----------
function consulta(texto) {
  const t = n(texto);
  if (!t) return null;

  if (/^(\/?ayuda|\/?help|\/?start|menu|que sabes hacer|que puedes hacer|comandos)\b/.test(t)) return { tipo: 'ayuda' };
  if (/^(mis cambios|mis ajustes|que he cambiado|mi config|mis overrides)\b/.test(t)) return { tipo: 'miscambios' };
  if (/^(deshacer|undo|revertir|quitar ultimo)\b/.test(t)) return { tipo: 'deshacer' };
  if (/^(resetear|reset|restaurar|volver al horario oficial)\b/.test(t)) return { tipo: 'reset' };

  if (/\b(ahora|en este momento|que toca ahora)\b/.test(t)) return { tipo: 'ahora' };
  if (/\b(siguiente|proxima clase|proxima|que toca luego|luego)\b/.test(t)) return { tipo: 'siguiente' };
  if (/\b(pasado manana)\b/.test(t)) return { tipo: 'fecha', offset: 2 };
  if (/\b(manana)\b/.test(t)) return { tipo: 'fecha', offset: 1 };
  if (/\b(ayer)\b/.test(t)) return { tipo: 'fecha', offset: -1 };
  if (/\b(hoy|que tengo|que clases tengo|clases de hoy)\b/.test(t) && !/manana|semana/.test(t)) return { tipo: 'fecha', offset: 0 };
  if (/\b(semana|esta semana|toda la semana)\b/.test(t)) return { tipo: 'semana' };
  if (/\b(horario completo|todo el horario|mi horario)\b/.test(t)) return { tipo: 'semana' };
  if (/\b(examenes|examen|eventos|deberes|entregas|avisos)\b/.test(t)) return { tipo: 'eventos' };
  if (/\b(que semana|en que semana)\b/.test(t)) return { tipo: 'semananum' };
  if (/\b(festivos|vacaciones|puente)\b/.test(t)) return { tipo: 'festivos' };

  return null;
}

// Consulta DÉBIL: ambigua con una propuesta de cambio ("... el lunes"), así que
// el router la evalúa DESPUÉS de intentar interpretar el mensaje como cambio.
function consultaDebil(texto) {
  const t = n(texto);
  const dias = diasMencionados(t);
  if (dias.length === 1 && /\b(que hay|que tengo|clases|horario|el|los)\b/.test(t)) return { tipo: 'diasemana', dia: dias[0] };
  if (dias.length === 1 && t.split(/\s+/).length <= 3) return { tipo: 'diasemana', dia: dias[0] };
  return null;
}

// ---------- 2. PROPUESTAS DE CAMBIO ----------
// Devuelve { tipo, match, set, resumen } o null.
function cambio(texto) {
  const raw = digitalizar(texto);
  const t = n(raw);
  const EDIF = /\b(v[gh]\s?\d{1,2})\b/gi;
  const edificios = (raw.match(EDIF) || []).map(e => e.replace(/\s+/g, '').toUpperCase());
  const asig = asignaturaMencionada(t);
  const dias = diasMencionados(t);

  // "la VG30 no es la VG05"  /  "no es VG05, es VG30"
  if (edificios.length === 2) {
    let correcto, incorrecto;
    if (/\bno es\b/.test(t)) {
      const i = t.indexOf('no es');
      const antes = n(raw.slice(0, i)), despues = n(raw.slice(i));
      const eA = (antes.match(/v[gh]\s?\d{1,2}/g) || []).map(x => x.replace(/\s/g, '').toUpperCase());
      const eD = (despues.match(/v[gh]\s?\d{1,2}/g) || []).map(x => x.replace(/\s/g, '').toUpperCase());
      if (eA.length && eD.length) { correcto = eA[0]; incorrecto = eD[0]; }
      else { correcto = edificios[0]; incorrecto = edificios[1]; }
    } else { incorrecto = edificios[0]; correcto = edificios[1]; }
    if (correcto && incorrecto && correcto !== incorrecto) {
      return {
        tipo: 'aula',
        match: { edificio: incorrecto, ...(asig ? { asignatura: asig } : {}), ...(dias.length === 1 ? { dia: dias[0] } : {}) },
        set: { edificio: correcto },
        resumen: `${asig ? asig + ': ' : ''}aula ${incorrecto} → *${correcto}*`,
      };
    }
  }

  // "álgebra es en VG30" / "álgebra pasa a VG30" / "álgebra en el VH09"
  if (asig && edificios.length === 1 && /\b(es en|esta en|pasa a|cambia a|se hace en|en el|es la|va a|ahora en)\b/.test(t)) {
    return {
      tipo: 'aula',
      match: { asignatura: asig, ...(dias.length === 1 ? { dia: dias[0] } : {}) },
      set: { edificio: edificios[0] },
      resumen: `${asig}${dias.length === 1 ? ' (' + H.DIAS[dias[0]] + ')' : ''} → aula *${edificios[0]}*`,
    };
  }

  // "no curso álgebra" / "me quito álgebra" / "quítame bases de datos"
  if (asig && /\b(no curso|no tengo|no hago|no voy a|me quito|quitame|quitar|borrar|elimina|saca)\b/.test(t)) {
    return { tipo: 'quitar', match: { asignatura: asig }, set: {}, resumen: `quitar *${asig}*` };
  }

  // "solo voy martes y jueves" / "solo asisto los lunes"
  if (/\b(solo voy|solo asisto|unicamente voy|solo tengo clase)\b/.test(t) && dias.length) {
    const quitar = [1, 2, 3, 4, 5].filter(d => !dias.includes(d));
    return {
      tipo: 'solodias', dias, quitar, match: {}, set: {},
      resumen: `ir solo ${dias.map(d => H.DIAS[d]).join(', ')} (se quitan ${quitar.map(d => H.DIAS[d]).join(', ')})`,
    };
  }

  // "se cancela álgebra" / "no hay clase de bases de datos"
  if (asig && /\b(se cancela|se suspende|no hay clase|anulada|cancelada|se anula)\b/.test(t)) {
    return { tipo: 'cancelar', match: { asignatura: asig, ...(dias.length === 1 ? { dia: dias[0] } : {}) }, set: {}, resumen: `marcar *${asig}* como anulada` };
  }

  // "álgebra a las 16:30"
  const mh = t.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (asig && mh && /\b(a las|empieza|pasa a las|cambia a las|es a las)\b/.test(t)) {
    const hora = `${mh[1].padStart(2, '0')}:${mh[2]}`;
    return { tipo: 'hora', match: { asignatura: asig, ...(dias.length === 1 ? { dia: dias[0] } : {}) }, set: { inicio: hora }, resumen: `*${asig}* empieza a las *${hora}*` };
  }

  return null;
}


// ---------- 2.bis AÑADIR / RECUPERAR UNA ASIGNATURA ----------
// Dos casos:
//   a) "ponme álgebra"  -> la asignatura existe en el horario oficial y se la
//      quitaron a la clase: basta con devolvérsela con sus horas reales.
//   b) "ponme Redes los martes de 16:30 a 18:30 en VH09" -> asignatura que no
//      está en el horario oficial (repetidor de otro curso): hace falta horario.
const VERBOS_ANADIR = /\b(ponme|pon|ponedme|anade|anademe|anadir|agrega|agregame|dame|meteme|mete|yo si|si tengo|si curso|si la tengo|la tengo yo|yo la tengo)\b/;
const RELLENO = /\b(los|las|el|la|de|del|a|al|en|y|un|una|clase|asignatura|horas?|aula|edificio|por|para)\b/g;

function anadir(texto) {
  const raw = digitalizar(texto);
  const t = n(raw);
  if (!VERBOS_ANADIR.test(t)) return null;

  const dias = diasMencionados(t);
  const horas = [...t.matchAll(/\b(\d{1,2})[:.](\d{2})\b/g)]
    .map(m => `${m[1].padStart(2, '0')}:${m[2]}`);
  const aulaM = raw.match(/\b(v[gh]\s?\d{1,2})\b/i);
  const edificio = aulaM ? aulaM[0].replace(/\s+/g, '').toUpperCase() : null;

  const deBase = asignaturaMencionada(t);

  // Nombre libre: se extrae del texto ORIGINAL para conservar tildes y mayúsculas
  let libre = raw
    .replace(/\b(ponme|pon|ponedme|a[ñn]ade|a[ñn][aá]deme|a[ñn]adir|agrega|agr[ée]game|dame|m[ée]teme|mete|yo s[ií]|s[ií] tengo|s[ií] curso|s[ií] la tengo|la tengo yo|yo la tengo)\b/gi, ' ')
    .replace(/\b(lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo)\b/gi, ' ')
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, ' ')
    .replace(/\bv[gh]\s?\d{1,2}\b/gi, ' ')
    .replace(/\b(los|las|el|la|de|del|a|al|en|y|un|una|clase|asignatura|horas?|aula|edificio|por|para)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  if (libre) libre = libre[0].toUpperCase() + libre.slice(1);

  const asignatura = deBase || (libre.length > 2 ? libre : null);
  if (!asignatura) return null;

  // Caso (a): está en el oficial y no se dan horas -> recuperarla tal cual
  if (deBase && !horas.length && !dias.length) {
    return { tipo: 'recuperar', asignatura: deBase, resumen: `recuperar *${deBase}* con su horario oficial` };
  }

  // Caso (b): alta manual, necesita día y hora de inicio
  if (!dias.length || !horas.length) {
    return {
      tipo: 'anadir-incompleto', asignatura,
      falta: !dias.length && !horas.length ? 'el día y la hora' : (!dias.length ? 'el día' : 'la hora'),
    };
  }

  const inicio = horas[0];
  const fin = horas[1] || sumarDosHoras(inicio);
  return {
    tipo: 'anadir', asignatura, dia: dias[0], inicio, fin, edificio,
    resumen: `añadir *${asignatura}* los ${['domingo','lunes','martes','miércoles','jueves','viernes','sábado'][dias[0]]} de ${inicio} a ${fin}${edificio ? ` en ${edificio}` : ''}`,
  };
}

function sumarDosHoras(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${String((h + 2) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ---------- 3. RESPUESTA AL ALCANCE ----------
function alcance(texto) {
  const t = n(texto);
  if (/^(1|1⃣|solo yo|solo para mi|para mi|mio|yo|personal|solo a mi)\b/.test(t)) return 'personal';
  if (/^(2|2⃣|todos|para todos|toda la clase|global|a todos)\b/.test(t)) return 'global';
  if (/^(0|no|cancelar|nada|dejalo|olvidalo)\b/.test(t)) return 'cancelar';
  return null;
}

module.exports = { consulta, consultaDebil, cambio, anadir, alcance, asignaturaMencionada, diasMencionados, digitalizar, n };
