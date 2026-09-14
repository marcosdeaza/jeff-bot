// Persistencia JSON atómica: escribe a .tmp y renombra, para que un corte
// a mitad de escritura no deje el fichero corrupto. Serializa por ruta.
const fs = require('fs');
const path = require('path');
const log = require('./log');

const colas = new Map();

function asegurarDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function leer(ruta, porDefecto) {
  try {
    if (!fs.existsSync(ruta)) return porDefecto;
    const txt = fs.readFileSync(ruta, 'utf8').trim();
    if (!txt) return porDefecto;
    return JSON.parse(txt);
  } catch (e) {
    log.error(`store: no pude leer ${path.basename(ruta)}: ${e.message}`);
    // Aparta el fichero corrupto en vez de perderlo en silencio
    try { fs.renameSync(ruta, `${ruta}.corrupto-${Date.now()}`); } catch (_) {}
    return porDefecto;
  }
}

function escribir(ruta, datos) {
  const previo = colas.get(ruta) || Promise.resolve();
  const siguiente = previo.then(() => {
    try {
      asegurarDir(path.dirname(ruta));
      const tmp = `${ruta}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(datos, null, 2));
      fs.renameSync(tmp, ruta);
    } catch (e) {
      log.error(`store: no pude escribir ${path.basename(ruta)}: ${e.message}`);
    }
  });
  colas.set(ruta, siguiente);
  return siguiente;
}

module.exports = { leer, escribir, asegurarDir };
