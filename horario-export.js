// Vuelca el horario incorporado a data/horario.json para poder editarlo sin
// tocar el código ni reconstruir la imagen:
//   docker exec jeff-bot node /app/horario-export.js
//   (edita data/horario.json)
//   docker compose restart
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./src/config');
const base = require('./src/horario-base');

const destino = path.join(DATA_DIR, 'horario.json');
if (fs.existsSync(destino) && !process.argv.includes('--forzar')) {
  console.error(`${destino} ya existe. Usa --forzar para sobrescribirlo.`);
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(destino, JSON.stringify({ clases: base.clases, calendario: base.calendario }, null, 2));
console.log(`escrito ${destino}`);
console.log(`${base.clases.length} clases. Edítalo y reinicia el bot para aplicarlo.`);
console.log('Cada clase: { semestre, dia (1=lunes), inicio, fin, asignatura, edificio, aula }');
