const { TZ } = require('./config');

const niveles = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = niveles[process.env.LOG_LEVEL || 'info'] || 20;

// En hora local, no UTC: este bot vive de horarios locales y depurar con dos
// husos distintos a la vez se presta a errores.
const RELOJ = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, dateStyle: 'short', timeStyle: 'medium',
});

function emitir(nivel, ...args) {
  if (niveles[nivel] < MIN) return;
  const icono = { debug: '·', info: 'i', warn: '!', error: 'x' }[nivel];
  console.log(`${icono} ${RELOJ.format(new Date())}`, ...args);
}

module.exports = {
  debug: (...a) => emitir('debug', ...a),
  info:  (...a) => emitir('info', ...a),
  warn:  (...a) => emitir('warn', ...a),
  error: (...a) => emitir('error', ...a),
};
