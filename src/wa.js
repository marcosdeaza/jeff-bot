// GESTOR DE CONEXIÓN ENDURECIDO
//
// Invariante: existe como mucho UN socket vivo.
//
// Reconectar llamando otra vez a la función de arranque sin cerrar el socket
// anterior los va apilando, junto con sus escuchadores y sus temporizadores, y
// deja dos escritores concurrentes sobre el directorio de credenciales, que
// acaba corrompiéndose. Cada mensaje entrante se procesa entonces tantas veces
// como sockets haya: respuestas duplicadas y coste multiplicado.
//
// Aquí: cerrojo de un solo vuelo, derribo explícito del anterior, retroceso
// exponencial con jitter, tratamiento por código de cierre y un vigilante que
// reinicia el proceso si pasan 5 minutos sin conexión (Docker restart: always).
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore, Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const log = require('./log');
const cfg = require('./config');

const silencioso = pino({ level: 'silent' });

class Conexion {
  constructor({ onMensaje }) {
    this.onMensaje = onMensaje;
    this.sock = null;
    this.conectando = false;       // cerrojo: impide sockets solapados
    this.parado = false;           // fin definitivo (logout) -> requiere QR
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
    if (this.conectando || this.parado) return;
    this.conectando = true;
    try {
      await this._derribar();          // garantiza que no queda nada del anterior

      let version;
      try { ({ version } = await fetchLatestBaileysVersion()); }
      catch (e) { log.warn(`no pude consultar versión de WA, uso la del paquete: ${e.message}`); }

      const { state, saveCreds } = await useMultiFileAuthState(cfg.AUTH_DIR);

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          // Cachea las claves en memoria: menos escrituras a disco = menos
          // corrupción y menos latencia al descifrar.
          keys: makeCacheableSignalKeyStore(state.keys, silencioso),
        },
        logger: silencioso,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,      // que el móvil siga notificando
        syncFullHistory: false,
        keepAliveIntervalMs: cfg.KEEPALIVE_MS,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined, // evita timeouts espurios
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
    if (this.parado) return;
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

  async _alActualizar(u) {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      log.warn('SESIÓN CAÍDA: hace falta escanear un QR nuevo');
      try { console.log(await qrcode.toString(qr, { type: 'terminal', small: true })); } catch (_) {}
    }

    if (connection === 'open') {
      this.conectado = true;
      this.intentos = 0;                 // reset del backoff
      this.ultimoOk = Date.now();
      log.info('conectado a WhatsApp');
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
        case DisconnectReason.badSession:
          this.parado = true;
          log.error('sesión inválida: hay que volver a vincular el bot (QR). No reintento.');
          return;

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
      if (!id || this.vistos.has(id)) continue;   // dedupe: nunca responder dos veces
      this.vistos.add(id);
      if (this.vistos.size > 800) {
        this.vistos = new Set([...this.vistos].slice(-400));
      }
      Promise.resolve(this.onMensaje(msg, this)).catch(e => log.error(`handler: ${e.message}`));
    }
  }

  // -------- envío con reintentos --------
  async enviar(jid, contenido, intentos = 3) {
    for (let i = 0; i < intentos; i++) {
      try {
        if (!this.sock || !this.conectado) throw new Error('sin conexión');
        const r = await this.sock.sendMessage(jid, contenido);
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

  async escribiendo(jid) {
    try { await this.sock?.sendPresenceUpdate('composing', jid); } catch (_) {}
  }

  // -------- watchdog --------
  // Si llevamos demasiado tiempo sin conexión, salimos con código 1 y dejamos
  // que Docker (restart: always) levante un proceso completamente limpio.
  _watchdog() {
    if (this.timerWatchdog) clearInterval(this.timerWatchdog);
    this.timerWatchdog = setInterval(() => {
      const parado = Date.now() - this.ultimoOk;
      if (this.conectado) { this.ultimoOk = Date.now(); return; }
      if (this.parado) {
        log.error('sesión cerrada definitivamente; reinicio para forzar QR limpio');
        return process.exit(1);
      }
      if (parado > cfg.WATCHDOG_MS) {
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
