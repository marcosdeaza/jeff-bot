const niveles = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = niveles[process.env.LOG_LEVEL || 'info'] || 20;

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emitir(nivel, ...args) {
  if (niveles[nivel] < MIN) return;
  const icono = { debug: '·', info: 'i', warn: '!', error: 'x' }[nivel];
  console.log(`${icono} ${ts()}`, ...args);
}

module.exports = {
  debug: (...a) => emitir('debug', ...a),
  info:  (...a) => emitir('info', ...a),
  warn:  (...a) => emitir('warn', ...a),
  error: (...a) => emitir('error', ...a),
};
