// FECHAS Y HORAS HABLADAS -> instante concreto, siempre en hora de España.
//
// "en 20 minutos", "mañana a las 9", "el viernes por la tarde", "a las 6 y
// media", "todos los lunes a las 8". Se resuelve en local: es lo que más se
// usa con los recordatorios y tiene que ser exacto e instantáneo.
//
// extraer() devuelve también los tramos del texto que eran tiempo, para que
// quien llama se quede con el resto ("sacar la ropa") sin tener que adivinarlo.
const { TZ } = require('./config');

const pad = n => String(n).padStart(2, '0');

// ---------- reloj en Europe/Madrid, sin depender del TZ del proceso ----------
const PARTES = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function partes(ts) {
  const o = {};
  for (const p of PARTES.formatToParts(new Date(ts))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour % 24, mm: +o.minute, ss: +o.second };
}
const isoDe = ts => { const p = partes(ts); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const horaDe = ts => { const p = partes(ts); return `${p.hh}:${pad(p.mm)}`; };
const minutosDelDia = ts => { const p = partes(ts); return p.hh * 60 + p.mm; };
function offsetDe(ts) {
  const p = partes(ts);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ts / 1000) * 1000;
}
// Hora de pared en Madrid -> instante. Se corrige dos veces por si el cambio
// de hora cae justo entre medias.
function instante(iso, hh, mm) {
  const [y, m, d] = iso.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d, hh, mm);
  let ts = base - offsetDe(base);
  ts = base - offsetDe(ts);
  return ts;
}
function sumarDias(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function diaSemana(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// ---------- vocabulario ----------
const NUMS = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14,
  quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27,
  veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50,
  sesenta: 60, noventa: 90, cien: 100,
};
const PAL = Object.keys(NUMS).sort((a, b) => b.length - a.length).join('|');
const NUM = `(?:\\d+(?:[.,]\\d+)?|(?:${PAL})(?:\\s+y\\s+(?:uno|una|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve))?)`;

function num(txt) {
  const t = (txt || '').trim();
  if (/^\d/.test(t)) return parseFloat(t.replace(',', '.'));
  const m = t.match(/^(\w+)(?:\s+y\s+(\w+))?$/);
  if (!m) return NaN;
  return (NUMS[m[1]] ?? NaN) + (m[2] ? (NUMS[m[2]] ?? NaN) : 0);
}

const DIAS = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const DIA_RE = 'lunes|martes|miercoles|jueves|viernes|sabados?|domingos?';
const diaNum = w => DIAS[w.replace(/(sabado|domingo)s$/, '$1')];
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const MES_RE = Object.keys(MESES).join('|');
const NOMBRE_DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DIA_CORTO = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

// Hora por defecto de cada franja cuando no se dice la hora exacta.
const FRANJA = { manana: 9, mediodia: 14, tarde: 17, noche: 21, madrugada: 6 };

// Minúsculas y sin tildes, CONSERVANDO la longitud: así los índices de lo que
// se encuentra aquí valen también sobre el texto original.
function plano(s) {
  let out = '';
  for (const ch of s) {
    let c = ch.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (c.length !== ch.length) c = (c + ' '.repeat(ch.length)).slice(0, ch.length);
    out += c;
  }
  return out;
}

// ---------- duraciones: "20 minutos", "hora y media", "1h30" ----------
const UNIDAD = {
  s: 1000, seg: 1000, segs: 1000, segundo: 1000, segundos: 1000,
  m: 60000, min: 60000, mins: 60000, minuto: 60000, minutos: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hora: 3600000, horas: 3600000,
  dia: 86400000, dias: 86400000, semana: 604800000, semanas: 604800000,
  mes: 2592000000, meses: 2592000000,
};
const UNI_RE = 'segundos?|segs?|minutos?|mins?|horas?|hrs?|dias?|semanas?|mes(?:es)?|s|m|h';

// Lee una duración que empieza en `desde`. Devuelve { ms, fin, dias } o null.
function duracionEn(s, desde) {
  let i = desde, ms = 0, partesLeidas = 0, soloDias = true;
  const resto = () => s.slice(i);
  for (;;) {
    let m;
    const r = resto();
    if ((m = r.match(/^(\d+)\s*h\s*(\d{1,2})\s*(?:m|min|mins|minutos)?\b/))) {
      ms += (+m[1]) * 3600000 + (+m[2]) * 60000; soloDias = false;
    } else if ((m = r.match(/^(?:un\s+)?cuarto\s+de\s+hora\b/))) {
      ms += 900000; soloDias = false;
    } else if ((m = r.match(/^(?:una\s+)?media\s+hora\b/))) {
      ms += 1800000; soloDias = false;
    } else if ((m = r.match(new RegExp(`^(${NUM}|media|medio)?\\s*(${UNI_RE})\\b`)))) {
      const u = m[2];
      // Sin número solo valen "hora", "minuto"...: "en hora y media".
      if (!m[1] && !/^(hora|minuto|dia|semana|mes)$/.test(u)) break;
      const n = !m[1] ? 1 : /^medi[ao]$/.test(m[1]) ? 0.5 : num(m[1]);
      if (!isFinite(n) || n <= 0) break;
      ms += n * UNIDAD[u];
      if (UNIDAD[u] < 86400000) soloDias = false;
      // "dos horas y media", "una hora y cuarto"
      const tras = s.slice(i + m[0].length).match(/^\s+y\s+(media|cuarto)\b/);
      if (tras && UNIDAD[u] >= 3600000) {
        ms += (tras[1] === 'media' ? 0.5 : 0.25) * UNIDAD[u];
        m[0] += tras[0];
      }
    } else break;
    i += m[0].length;
    partesLeidas++;
    const sig = s.slice(i).match(/^\s*(?:,|y)\s+(?=\d|un|una|dos|tres|cuatro|cinco|diez|quince|veinte|treinta|media)/);
    if (sig && duracionCabe(s, i + sig[0].length)) { i += sig[0].length; continue; }
    break;
  }
  return partesLeidas ? { ms: Math.round(ms), fin: i, dias: soloDias } : null;
}
function duracionCabe(s, i) {
  return new RegExp(`^(?:${NUM}|media)\\s*(?:${UNI_RE})\\b`).test(s.slice(i));
}

// Busca "en/dentro de <duración>" o, con `suelta`, una duración sin preposición
// (para los temporizadores: "temporizador de 10 minutos").
function buscarDuracion(s, { suelta = false } = {}) {
  if (!suelta) {
    for (const m of s.matchAll(/\b(?:en|dentro de)\s+/g)) {
      const d = duracionEn(s, m.index + m[0].length);
      if (d) return { ...d, ini: m.index };
    }
    return null;
  }
  for (const m of s.matchAll(/(?:^|\s)(?=\S)/g)) {
    const i = m.index + m[0].length;
    const d = duracionEn(s, i);
    if (!d) continue;
    const prev = s.slice(0, i).match(/\b(?:en|dentro de|de|durante|por)\s+$/);
    return { ...d, ini: prev ? prev.index : i };
  }
  return null;
}

// ---------- extracción completa ----------
// Devuelve null si no hay ninguna referencia temporal. Si la hay:
//   ts         instante del aviso (o null si solo se dijo un día que ya pasó)
//   dia        fecha ISO cuando se nombró un día
//   hayHora    se dijo una hora (o una franja)
//   repetir    { tipo: 'diario'|'laborables'|'semanal'|'intervalo', dias, hora, ms }
//   spans      tramos [ini, fin) del texto original que eran tiempo
function extraer(original, ahora = Date.now(), { manana = false } = {}) {
  const s = plano(original);
  const spans = [];
  const tapar = (ini, fin) => spans.push([ini, fin]);
  const libre = (ini, fin) => !spans.some(([a, b]) => ini < b && a < fin);
  // Primera coincidencia que no pise algo ya reconocido ("mañana por la mañana").
  const buscar = re => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const x of s.matchAll(g)) if (libre(x.index, x.index + x[0].length)) return x;
    return null;
  };

  const hoy = isoDe(ahora);
  let dia = null, hh = null, mm = 0, periodo = null, franja = null, relativo = null, repetir = null;

  // 1) repeticiones
  let m;
  if ((m = s.match(/\bcada\s+(?:(\S+(?:\s+y\s+\S+)?)\s+)?(minutos?|horas?)\b/)) && (!m[1] || isFinite(num(m[1])))) {
    const n = m[1] ? num(m[1]) : 1;
    const ms = n * UNIDAD[m[2]];
    if (ms >= 10 * 60000) { repetir = { tipo: 'intervalo', ms }; tapar(m.index, m.index + m[0].length); }
  }
  if (!repetir && (m = s.match(/\b(?:todos los dias|todas las (mananas|tardes|noches)|cada (dia|manana|tarde|noche)|a diario|diariamente)\b/))) {
    repetir = { tipo: 'diario' };
    const f = (m[1] || m[2] || '').replace(/s$/, '');
    if (FRANJA[f]) franja = f;
    tapar(m.index, m.index + m[0].length);
  }
  if (!repetir && (m = s.match(/\b(?:entre semana|de lunes a viernes|(?:los |cada |todos los )?dias? laborables?)\b/))) {
    repetir = { tipo: 'laborables' };
    tapar(m.index, m.index + m[0].length);
  }
  if (!repetir && (m = s.match(new RegExp(`\\b(?:todos los|cada|los)\\s+((?:${DIA_RE})(?:\\s*(?:,|y)\\s*(?:los\\s+)?(?:${DIA_RE}))*)\\b`)))) {
    const dias = [...m[1].matchAll(new RegExp(DIA_RE, 'g'))].map(x => diaNum(x[0]));
    repetir = { tipo: 'semanal', dias: [...new Set(dias)].sort() };
    tapar(m.index, m.index + m[0].length);
  }

  // 2) duración relativa: "en 20 minutos", "dentro de dos horas y media"
  const dur = buscarDuracion(s);
  if (dur && libre(dur.ini, dur.fin)) {
    relativo = dur;
    tapar(dur.ini, dur.fin);
  }

  // 3) hora del día
  const HNUM = '\\d{1,2}|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce';
  const MINS = 'media|cuarto|\\d{1,2}|cinco|diez|veinte|veinticinco';
  const reHora = new RegExp(
    `\\b(?:a|sobre|hacia|para|antes de)\\s+(?:las|la)\\s+(${HNUM})` +
    `(?:\\s*(?::|\\.|h)\\s*(\\d{2})|\\s+y\\s+(${MINS})|\\s+menos\\s+(${MINS}))?` +
    `(?:\\s*(?:h|hrs|horas)\\b)?` +
    `(?:\\s*(?:de la|por la)\\s+(manana|tarde|noche|madrugada)|\\s*(am|pm|a\\.\\s?m\\.?|p\\.\\s?m\\.?)(?![a-z])|\\s+en punto)?`);
  if ((m = buscar(reHora))) {
    hh = /^\d/.test(m[1]) ? +m[1] : NUMS[m[1]];
    const minTxt = m[3] || m[4];
    if (m[2]) mm = +m[2];
    else if (minTxt) {
      const v = minTxt === 'media' ? 30 : minTxt === 'cuarto' ? 15 : /^\d/.test(minTxt) ? +minTxt : NUMS[minTxt];
      if (m[3]) mm = v; else { hh -= 1; mm = 60 - v; if (hh < 0) hh += 24; }
    }
    if (m[5]) periodo = m[5];
    else if (m[6]) periodo = /^p/.test(m[6]) ? 'pm' : 'am';
    tapar(m.index, m.index + m[0].length);
  } else if ((m = buscar(/\b(?:a las\s+)?([01]?\d|2[0-3])(?::|h)([0-5]\d)\b/))) {
    hh = +m[1]; mm = +m[2];
    tapar(m.index, m.index + m[0].length);
  } else if ((m = buscar(/\b(?:a las\s+)?([01]?\d|2[0-3])\s?h\b/))) {
    hh = +m[1];
    tapar(m.index, m.index + m[0].length);
  } else if ((m = buscar(/\ba (?:la )?(mediodia|medianoche)\b/))) {
    if (m[1] === 'mediodia') hh = 14; else { hh = 0; dia = dia || sumarDias(hoy, 1); }
    tapar(m.index, m.index + m[0].length);
  }

  // franja suelta: "esta tarde", "por la noche", "mañana por la mañana"
  if ((m = buscar(/\b(esta|por la|de la|a la)\s+(manana|tarde|noche|madrugada)\b/))) {
    if (m[1] === 'esta') dia = dia || hoy;
    if (hh == null) franja = m[2]; else if (!periodo) periodo = m[2];
    tapar(m.index, m.index + m[0].length);
  }

  // 4) día
  if ((m = buscar(/\bpasado\s+manana\b/))) {
    dia = sumarDias(hoy, 2); tapar(m.index, m.index + m[0].length);
  } else if ((m = buscar(/\bmanana\b/))) {
    dia = sumarDias(hoy, 1); tapar(m.index, m.index + m[0].length);
  } else if ((m = buscar(/\bhoy\b/))) {
    dia = hoy; tapar(m.index, m.index + m[0].length);
  }
  if (!dia && (m = buscar(new RegExp(`\\b(?:el\\s+)?(?:dia\\s+)?(\\d{1,2})\\s+de\\s+(${MES_RE})(?:\\s+(?:de\\s+)?(\\d{4}))?\\b`)))) {
    dia = fechaFutura(hoy, +m[1], MESES[m[2]], m[3] ? +m[3] : null);
    if (dia) tapar(m.index, m.index + m[0].length);
  }
  if (!dia && (m = buscar(/\b(?:el\s+)?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    dia = fechaFutura(hoy, +m[1], +m[2], y);
    if (dia) tapar(m.index, m.index + m[0].length);
  }
  if (!dia && !(repetir && repetir.tipo === 'semanal') &&
      (m = buscar(new RegExp(`\\b(?:el\\s+)?(?:(proximo|este|siguiente)\\s+)?(${DIA_RE})(?:\\s+(que viene|proximo|siguiente))?\\b`)))) {
    const objetivo = diaNum(m[2]);
    let delta = (objetivo - diaSemana(hoy) + 7) % 7;
    if (delta === 0 && m[1] !== 'este') delta = 7;
    dia = sumarDias(hoy, delta);
    tapar(m.index, m.index + m[0].length);
  }
  if (!dia && (m = buscar(/\bel dia (\d{1,2})\b/))) {
    const [y, mo] = hoy.split('-').map(Number);
    dia = fechaFutura(hoy, +m[1], mo, null, true) || null;
    if (!dia && mo) dia = fechaFutura(hoy, +m[1], mo === 12 ? 1 : mo + 1, mo === 12 ? y + 1 : y);
    if (dia) tapar(m.index, m.index + m[0].length);
  }

  if (!spans.length) return null;

  // 5) componer el instante
  const res = { ts: null, dia, hayHora: hh != null || !!franja, repetir, spans, relativo: !!relativo };
  res.horaPorDefecto = !res.hayHora && !(relativo && !relativo.dias) && !(repetir && repetir.tipo === 'intervalo');

  if (repetir && repetir.tipo === 'intervalo') {
    res.ts = ahora + repetir.ms;
    return res;
  }

  if (relativo && !relativo.dias) {
    res.ts = ahora + relativo.ms;
    res.dia = isoDe(res.ts);
    return res;
  }
  if (relativo && relativo.dias) dia = isoDe(ahora + relativo.ms);

  // hora final, resolviendo mañana/tarde
  let H = null;
  if (hh != null) H = manana && !periodo ? hh % 24 : ajustarHora(hh, periodo, { hayDia: !!dia || !!repetir });
  else if (franja) H = FRANJA[franja];

  if (repetir) {
    const hora = H != null ? { hh: H, mm: hh != null ? mm : 0 } : { hh: 9, mm: 0 };
    repetir.hora = `${pad(hora.hh)}:${pad(hora.mm)}`;
    res.ts = siguienteRepeticion(repetir, ahora);
    res.dia = isoDe(res.ts);
    return res;
  }

  if (dia) {
    const hora = H != null ? H : 9;
    const minutos = hh != null ? mm : 0;
    const ts = instante(dia, hora, minutos);
    // Un día sin hora que ya ha pasado (decir "hoy" a las 11 de la noche): se
    // devuelve el día sin instante y quien llama decide.
    if (ts <= ahora && H == null) { res.ts = null; return res; }
    // Una hora ambigua de hoy ya pasada salta a la versión de la tarde.
    if (ts <= ahora && dia === hoy && hh != null && !periodo && hora < 12) {
      const tarde = instante(dia, hora + 12, minutos);
      res.ts = tarde > ahora ? tarde : null;
    } else res.ts = ts > ahora ? ts : null;
    res.dia = dia;
    return res;
  }

  if (H != null) {
    // Solo hora: la primera vez que llegue esa hora, hoy o mañana.
    const minutos = hh != null ? mm : 0;
    const cands = [];
    for (const d of [hoy, sumarDias(hoy, 1)]) {
      const horas = hh != null && !periodo && !manana ? candidatasHora(hh) : [H];
      for (const h of horas) cands.push(instante(d, h, minutos));
    }
    res.ts = cands.filter(t => t > ahora + 20000).sort((a, b) => a - b)[0] || null;
    res.dia = res.ts ? isoDe(res.ts) : null;
    return res;
  }

  return res;
}

// "a las 6" sin decir nada más casi nunca son las 6 de la madrugada.
function candidatasHora(h) {
  if (h === 0 || h >= 13) return [h % 24];
  if (h === 12) return [12];
  if (h <= 6) return [h + 12];
  return [h, h + 12];
}
function ajustarHora(h, periodo, { hayDia }) {
  if (periodo === 'am') return h % 12;
  if (periodo === 'pm') return (h % 12) + 12;
  if (periodo === 'manana' || periodo === 'madrugada') return h === 12 ? 12 : h % 12;
  if (periodo === 'tarde') return h < 12 ? h + 12 : h;
  if (periodo === 'noche') return h < 12 ? (h <= 4 ? h : h + 12) : (h === 12 ? 0 : h);
  if (h >= 13 || h === 0) return h % 24;
  if (hayDia) return h <= 6 ? h + 12 : h;
  return h;
}

// Día y mes sin año: el próximo que llegue.
function fechaFutura(hoy, d, mo, y, mismoMes = false) {
  if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12)) return null;
  const [ya] = hoy.split('-').map(Number);
  let anio = y || ya;
  let iso = `${anio}-${pad(mo)}-${pad(d)}`;
  if (!esFechaValida(iso)) return null;
  if (!y && iso < hoy) {
    if (mismoMes) return null;
    anio++; iso = `${anio}-${pad(mo)}-${pad(d)}`;
  }
  return esFechaValida(iso) ? iso : null;
}
function esFechaValida(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// Siguiente vez que toca un recordatorio que se repite, estrictamente después de `desde`.
function siguienteRepeticion(rep, desde) {
  if (rep.tipo === 'intervalo') return desde + rep.ms;
  const [h, mi] = (rep.hora || '09:00').split(':').map(Number);
  const hoy = isoDe(desde);
  for (let i = 0; i < 15; i++) {
    const d = sumarDias(hoy, i);
    const dow = diaSemana(d);
    if (rep.tipo === 'laborables' && (dow === 0 || dow === 6)) continue;
    if (rep.tipo === 'semanal' && !(rep.dias || []).includes(dow)) continue;
    const ts = instante(d, h, mi);
    if (ts > desde) return ts;
  }
  return desde + 86400000;
}

// ---------- formato ----------
function etiquetaDia(iso, ahora = Date.now()) {
  const hoy = isoDe(ahora);
  if (iso === hoy) return 'hoy';
  if (iso === sumarDias(hoy, 1)) return 'mañana';
  if (iso === sumarDias(hoy, -1)) return 'ayer';
  if (iso > hoy && iso <= sumarDias(hoy, 6)) return NOMBRE_DIA[diaSemana(iso)];
  const [, m, d] = iso.split('-');
  return `${+d}/${+m}`;
}

// "hoy a las 18:30", "el lunes a las 10:00", "en 25 min, a las 3:58"
function cuando(ts, ahora = Date.now()) {
  const falta = ts - ahora;
  if (falta < 90 * 60000) {
    const min = Math.max(1, Math.round(falta / 60000));
    return `en ${duracionTexto(min * 60000)}, a las ${horaDe(ts)}`;
  }
  const e = etiquetaDia(isoDe(ts), ahora);
  const pre = /^\d/.test(e) ? `el ${e}` : ['hoy', 'mañana'].includes(e) ? e : `el ${e}`;
  return `${pre} a las ${horaDe(ts)}`;
}

// Para listas: "hoy 18:30", "mañana 9:00", "lun 10:00", "15/10 10:00"
function corto(ts, ahora = Date.now()) {
  const iso = isoDe(ts);
  const hoy = isoDe(ahora);
  let e = etiquetaDia(iso, ahora);
  if (iso > sumarDias(hoy, 1) && iso <= sumarDias(hoy, 6)) e = DIA_CORTO[diaSemana(iso)];
  return `${e} ${horaDe(ts)}`;
}

function duracionTexto(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return `${Math.round(ms / 1000)} s`;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), r = min % 60;
  if (h < 24) return r ? `${h} h ${r} min` : `${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 día' : `${d} días`;
}

function repeticionTexto(rep) {
  if (!rep) return '';
  const hora = rep.hora ? rep.hora.replace(/^0(\d)/, '$1') : '';
  if (rep.tipo === 'intervalo') return `cada ${duracionTexto(rep.ms)}`;
  if (rep.tipo === 'diario') return `cada día a las ${hora}`;
  if (rep.tipo === 'laborables') return `entre semana a las ${hora}`;
  if (rep.tipo === 'semanal') {
    const nombres = (rep.dias || []).map(d => NOMBRE_DIA[d] + (d === 0 || d === 6 ? 's' : ''));
    const lista = nombres.length > 1 ? `${nombres.slice(0, -1).join(', ')} y ${nombres.at(-1)}` : nombres[0];
    return `los ${lista} a las ${hora}`;
  }
  return '';
}

module.exports = {
  extraer, buscarDuracion, duracionEn, siguienteRepeticion, plano,
  isoDe, horaDe, minutosDelDia, instante, sumarDias, diaSemana,
  cuando, corto, etiquetaDia, duracionTexto, repeticionTexto, NOMBRE_DIA,
};
