// Sano = el proceso ha tocado /app/data/.alive hace menos de 3 minutos.
// Si no, Docker lo marca unhealthy y el watchdog interno ya habrá reiniciado.
const fs = require('fs');
try {
  const m = fs.statSync('/app/data/.alive').mtimeMs;
  const edad = (Date.now() - m) / 1000;
  if (edad > 180) { console.error(`latido viejo: ${Math.round(edad)}s`); process.exit(1); }
  process.exit(0);
} catch (e) { console.error('sin latido'); process.exit(1); }
