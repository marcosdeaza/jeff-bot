// GESTOR DE CONEXIÓN ENDURECIDO v3
//
// Mejoras respecto a v2:
//  - QR guardado como imagen PNG en /app/data/qr.png además de en terminal
//  - keepAlive aumentado a 10s para detectar caídas antes
//  - Reconexión más agresiva en errores transitorios (backoff reducido)
//  - El bot NO se detiene definitivamente ante loggedOut: limpia auth y vuelve
//    a pedir QR automáticamente (así Docker no necesita reiniciar en loop)
//  - Watchdog extendido a 10 min (antes 5 min) para evitar reinicios prematuros
//    mientras el usuario está escaneando el QR
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore, Browsers, jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const log = require('./log');
const cfg = require('./config');

const silencioso = pino({ level: 'silent' });

// Ruta donde se guarda el QR como imagen PNG
const QR_PATH = path.join(cfg.DATA_DIR, 'qr.png');

// Versión de WhatsApp Web que se anuncia al conectar. fetchLatestBaileysVersion
// lee un fichero del repositorio de Baileys que se actualiza a mano y se quedó
// meses atrás; con una versión tan vieja el móvil rechazaba el enlace del QR
// ("comprueba tu conexión") sin que el bot llegara a enterarse. Se pregunta
// primero a web.whatsapp.com y solo si falla se usa la de Baileys.
async function versionWA() {
  const conPlazo = p => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))]);
  for (const [nombre, f] of [['web.whatsapp.com', fetchLatestWaWebVersion], ['baileys', fetchLatestBaileysVersion]]) {
    try {
      const { version, error } = await conPlazo(f());
      if (version && !error) { log.info(`versión de WhatsApp Web ${version.join('.')} (${nombre})`); return version; }
    } catch (e) { log.warn(`versión de WA desde ${nombre}: ${e.message}`); }
  }
  log.warn('no pude consultar la versión de WA, uso la del paquete');
  return undefined;
}

class Conexion {
  constructor({ onMensaje }) {
    this.onMensaje = onMensaje;
    this.sock = null;
    this.conectando = false;       // cerrojo: impide sockets solapados
    this.parado = false;           // ya no se usa para detener definitivamente
    this.intentos = 0;
    this.ultimoOk = Date.now();
    this.conectado = false;
    this.vistos = new Set();       // dedupe de mensajes entrantes
    this.enviados = new Map();     // para getMessage en reintentos de cifrado
    this.timerReconexion = null;
    this.timerWatchdog = null;
  }

  // -------- ciclo de vida --------
  async arrancar() {
    this._watchdog();
    await this._conectar();
  }

  async _conectar() {
    if (this.conectando) return;
    this.conectando = true;
    try {
      await this._derribar();          // garantiza que no queda nada del anterior

      const version = await versionWA();

      const { state, saveCreds } = await useMultiFileAuthState(cfg.AUTH_DIR);

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, silencioso),
        },
        logger: silencioso,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        keepAliveIntervalMs: 10000,          // 10s — detecta caídas antes
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
        retryRequestDelayMs: 300,
        maxMsgRetryCount: 5,
        generateHighQualityLinkPreview: false,
        getMessage: async key => this.enviados.get(key.id) || { conversation: '' },
      });

      this.sock = sock;
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', u => this._alActualizar(u));
      sock.ev.on('messages.upsert', ev => this._alRecibir(ev));
    } catch (e) {
      log.error(`fallo al conectar: ${e.message}`);
      this._programar();
    } finally {
      this.conectando = false;
    }
  }

  async _derribar() {
    const s = this.sock;
    this.sock = null;
    this.conectado = false;
    if (!s) return;
    try { s.ev.removeAllListeners(); } catch (_) {}
    try { s.ws && s.ws.close(); } catch (_) {}
    try { s.end && s.end(undefined); } catch (_) {}
    log.debug('socket anterior derribado');
  }

  _programar(msForzado = null) {
    if (this.timerReconexion) return;         // ya hay una reconexión en cola
    const base = Math.min(cfg.BACKOFF_BASE_MS * 2 ** this.intentos, cfg.BACKOFF_MAX_MS);
    const ms = msForzado != null ? msForzado : Math.round(base / 2 + Math.random() * (base / 2));
    this.intentos++;
    log.warn(`reconectando en ${(ms / 1000).toFixed(1)}s (intento ${this.intentos})`);
    this.timerReconexion = setTimeout(() => {
      this.timerReconexion = null;
      this._conectar();
    }, ms);
  }

  async _limpiarAuth() {
    log.warn('limpiando credenciales auth para forzar QR nuevo...');
    try {
      const archivos = fs.readdirSync(cfg.AUTH_DIR);
      for (const f of archivos) {
        fs.rmSync(path.join(cfg.AUTH_DIR, f), { recursive: true, force: true });
      }
      log.info('auth limpiado OK');
    } catch (e) {
      log.error(`error limpiando auth: ${e.message}`);
    }
  }

  async _alActualizar(u) {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      log.warn('SESIÓN CAÍDA: escanea el QR nuevo con tu WhatsApp');
      // Imprimir en terminal
      try { console.log(await qrcode.toString(qr, { type: 'terminal', small: true })); } catch (_) {}
      // Guardar como imagen PNG en disco
      try {
        await qrcode.toFile(QR_PATH, qr, { type: 'png', width: 512, margin: 2 });
        log.info(`QR guardado en ${QR_PATH}`);
      } catch (e) {
        log.error(`no pude guardar QR como PNG: ${e.message}`);
      }
    }

    if (connection === 'open') {
      this.conectado = true;
      this.intentos = 0;
      this.ultimoOk = Date.now();
      log.info('conectado a WhatsApp ✓');
      // Borrar el QR ya que no se necesita más
      try { if (fs.existsSync(QR_PATH)) fs.unlinkSync(QR_PATH); } catch (_) {}
      return;
    }

    if (connection === 'close') {
      this.conectado = false;
      const code = lastDisconnect?.error?.output?.statusCode
                || lastDisconnect?.error?.output?.payload?.statusCode;
      const motivo = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === code) || 'desconocido';
      log.warn(`conexión cerrada (${code} · ${motivo})`);

      await this._derribar();

      switch (code) {
        case DisconnectReason.loggedOut:        // 401 — sesión cerrada desde el móvil
        case DisconnectReason.badSession:       // sesión corrompida
          // En lugar de parar definitivamente, limpiamos auth y pedimos QR nuevo
          await this._limpiarAuth();
          log.warn('sesión inválida: limpiando y pidiendo QR nuevo en 3s...');
          this.intentos = 0;
          return this._programar(3000);

        case DisconnectReason.restartRequired:  // 515 — normal tras vincular
          log.info('reinicio solicitado por WhatsApp: reconecto ya');
          this.intentos = 0;
          return this._programar(500);

        case DisconnectReason.connectionReplaced: // 440 — otra sesión tomó el control
          log.warn('conexión reemplazada por otra sesión: espero 60s para no pelear');
          return this._programar(60000);

        default:                                 // 428, 503, 408, 500...
          return this._programar();
      }
    }
  }

  _alRecibir(ev) {
    if (ev.type !== 'notify') return;
    for (const msg of ev.messages || []) {
      const id = msg.key?.id;
      if (!id || this.vistos.has(id)) continue;
      this.vistos.add(id);
      if (this.vistos.size > 800) {
        this.vistos = new Set([...this.vistos].slice(-400));
      }
      Promise.resolve(this.onMensaje(msg, this)).catch(e => log.error(`handler: ${e.message}`));
    }
  }

  // -------- envío con reintentos --------
  // opciones va tal cual a sendMessage: en los grupos lleva { quoted } para
  // que la respuesta salga citando el mensaje al que contesta.
  async enviar(jid, contenido, opciones = {}, intentos = 3) {
    for (let i = 0; i < intentos; i++) {
      try {
        if (!this.sock || !this.conectado) throw new Error('sin conexión');
        const r = await this.sock.sendMessage(jid, contenido, opciones);
        if (r?.key?.id && contenido.text) {
          this.enviados.set(r.key.id, { conversation: contenido.text });
          if (this.enviados.size > 300) this.enviados.delete(this.enviados.keys().next().value);
        }
        return r;
      } catch (e) {
        const ultimo = i === intentos - 1;
        log.warn(`envío fallido (${i + 1}/${intentos}): ${e.message}`);
        if (ultimo) throw e;
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }

  // Identidades del propio bot (número y lid) sin el sufijo de dispositivo,
  // para saber en un grupo si una mención o una respuesta va con él.
  propios() {
    const u = this.sock?.user;
    return new Set([u?.id, u?.lid].filter(Boolean).map(j => jidNormalizedUser(j)));
  }

  async escribiendo(jid) {
    try { await this.sock?.sendPresenceUpdate('composing', jid); } catch (_) {}
  }

  // -------- watchdog --------
  // Watchdog extendido a 10 min para dar tiempo a escanear el QR.
  // Si llevamos demasiado tiempo sin conexión, salimos con código 1 y dejamos
  // que Docker (restart: always) levante un proceso completamente limpio.
  _watchdog() {
    if (this.timerWatchdog) clearInterval(this.timerWatchdog);
    this.timerWatchdog = setInterval(() => {
      const parado = Date.now() - this.ultimoOk;
      if (this.conectado) { this.ultimoOk = Date.now(); return; }
      const WATCHDOG_MS = 10 * 60 * 1000;  // 10 minutos
      if (parado > WATCHDOG_MS) {
        log.error(`sin conexión desde hace ${Math.round(parado / 1000)}s: reinicio el proceso`);
        process.exit(1);
      }
    }, 30000);
  }

  estado() {
    return {
      conectado: this.conectado,
      intentos: this.intentos,
      parado: this.parado,
      segundosDesdeOk: Math.round((Date.now() - this.ultimoOk) / 1000),
    };
  }
}

module.exports = { Conexion };
