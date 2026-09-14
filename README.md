![Jeff](docs/banner.png)

# Jeff

Bot de WhatsApp que lleva el horario de una clase universitaria. Cada persona
puede ajustar el suyo sin cambiárselo a nadie.

Responde por texto y por nota de voz. Está en producción para 2º de Ingeniería
Informática de la Universidad Europea de Valencia, curso 2026/2027.

---

## La idea

Un horario de clase no es igual para todos. Hay repetidores que arrastran una
asignatura que los demás ya aprobaron, gente que no va ciertos días, cambios de
aula que afectan a un grupo y no a otro.

Los bots de horarios suelen tener un único horario global: si alguien lo
corrige, se lo cambia a todo el mundo. Jeff separa lo que es común de lo que es
de cada uno, y pregunta siempre a quién afecta un cambio.

```
Marcos ─ no curso Álgebra
Jeff   ─ He entendido: quitar Álgebra
         ¿Para quién?
         1 solo para mí
         2 para toda la clase
         0 cancelar
Marcos ─ 2
Jeff   ─ Aplicado para toda la clase: quitar Álgebra
```

Y quien sí la curse se la recupera con sus horas reales:

```
Ana    ─ ponme álgebra
Jeff   ─ Álgebra añadida a tu horario:

         lunes 10:30 VG25
         viernes 08:30 VG25

         Al resto de la clase le sigue sin aparecer.
```

---

## Cómo se ven las respuestas

El formato es una decisión de diseño, no un detalle. Se lee en el móvil, entre
clases, con prisa. Nada de emojis, iconos, marcos ni recuentos: hora, asignatura
y edificio.

```
Hoy es lunes. Estas son las clases de hoy:

10:30 *Álgebra*
VG25

14:30 *Análisis de circuitos*
VG04

16:30 *Prog. estructuras lineales*
VH09

18:30 *Intro ingeniería software*
VG12
```

Reglas que sigue todo el texto que sale del bot:

- Solo la hora de inicio. El rango completo sobra cuando las clases van seguidas.
- Solo el edificio. El aula casi nunca cambia y ocupa sitio.
- Nombres cortos: `Prog. estructuras lineales`, no
  `Programación con estructuras lineales`.
- Negrita solo en el nombre de la asignatura, con un asterisco (el de WhatsApp).
- Sin emojis, sin viñetas, sin flechas, sin títulos en mayúsculas.
- Sin saludos ni resúmenes finales.

El modelo de lenguaje recibe estas mismas reglas con un ejemplo literal, y la
salida se filtra después para quitar cualquier emoji que se le escape.

---

## Arquitectura

El horario oficial nunca se edita. Los cambios se apilan encima como capas, y se
resuelven en el momento de responder, para cada persona.

```
L0  BASE       horario oficial, en código, inmutable
L1  GLOBAL     cambios de toda la clase
L2  PERSONAL   cambios de una sola persona
L3  EVENTOS    exámenes y avisos, con el mismo alcance
               |
               v
    resolver(usuario, fecha) -> su horario efectivo
```

Consecuencias de que un cambio sea un registro y no una edición:

- Todo es reversible: `deshacer` desactiva el último, `resetear` los quita todos.
- Todo es auditable: cada cambio guarda quién, cuándo y por qué.
- Lo personal gana a lo global, así que uno puede excluirse de un cambio de la
  clase con `no me aplica` sin afectar a nadie más.

Detalle en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

---

## Qué entiende

| Quieres | Escribe |
| --- | --- |
| Las clases de hoy | `hoy` |
| Otro día | `mañana`, `el viernes` |
| Qué toca en este momento | `ahora` |
| La siguiente clase | `siguiente` |
| La semana entera | `semana` |
| Exámenes y avisos | `exámenes` |
| Días libres que vienen | `festivos` |
| Quitarte una asignatura | `no curso Álgebra` |
| Recuperarla | `ponme Álgebra` |
| Una que no está en el oficial | `ponme Redes los martes de 16:30 a 18:30 en VH09` |
| Ir solo algunos días | `solo voy martes y jueves` |
| Corregir un aula | `la VG30 no es la VG05` |
| Cambiar una hora | `Álgebra a las 16:30` |
| Anular una clase | `se cancela circuitos el lunes` |
| Excluirte de un cambio de la clase | `no me aplica` |
| Ver tus ajustes | `mis cambios` |
| Revertir el último | `deshacer` |
| Volver al horario oficial | `resetear` |

Todo funciona igual dictado por voz. Los números hablados se convierten, así que
"la VG treinta no es la VG cero cinco" se entiende igual que escrito.

---

## Instalación

Requisitos: Docker y Docker Compose. Una cuenta de WhatsApp para el bot.

```bash
git clone https://github.com/marcosdeaza/jeff-bot.git
cd jeff-bot
cp .env.example .env
$EDITOR .env            # pon tu DEEPSEEK_API_KEY
docker compose up -d --build
docker compose logs -f  # aquí sale el QR la primera vez
```

Escanea el QR desde WhatsApp (Dispositivos vinculados). La sesión queda en
`auth/` y no hay que repetirlo.

### Poner tu horario

El horario vive en [`src/horario-base.js`](src/horario-base.js), en un formato
que se lee de un vistazo:

```js
C(1, 1, '10:30', '12:30', 'Álgebra', 'VG25', 'M11'),
// semestre, día (1=lunes), inicio, fin, asignatura, edificio, aula
```

En el mismo fichero están el calendario académico, los festivos, las vacaciones
y los periodos de exámenes.

---

## Configuración

| Variable | Obligatoria | Para qué |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | sí | Preguntas libres |
| `GROQ_API_KEY` | no | Transcribir notas de voz |
| `DEEPSEEK_MODEL` | no | Por defecto `deepseek-flash` |
| `ADMIN_JIDS` | no | Números con permisos de administración |
| `TZ` | no | Por defecto `Europe/Madrid` |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, `error` |

---

## Operación

Anuncio a todos los usuarios registrados, sin reiniciar el bot:

```bash
docker exec jeff-bot node /app/anunciar.js /app/data/mensaje.txt etiqueta
```

Se encola en disco y el proceso principal lo envía con pausas entre mensajes. No
abras nunca una segunda conexión de WhatsApp para mandar anuncios: WhatsApp
cierra la primera con un `connectionReplaced` y tumba el bot.

Gasto acumulado del modelo de lenguaje:

```bash
docker exec jeff-bot cat /app/data/coste.json
```

Cambios de administración sobre `data/overrides.json`: hazlos con el bot parado,
o espera 15 segundos a que los sincronice solo.

---

## Coste

Medido en producción con `deepseek-flash`. Una consulta que llega al modelo son
unos 512 tokens de caché, 243 nuevos y 300 de salida: **0,00044 $** en hora
punta. La salida es el 83 % del coste.

Las preguntas frecuentes (`hoy`, `mañana`, `semana`, `ahora`) se resuelven en
local sin llamar al modelo, así que no cuestan nada y responden al instante.

Para 30 personas y 180 días lectivos:

| Preguntas al día por persona | Al día | Curso completo |
| --- | --- | --- |
| 3 | 0,027 $ | 4,87 $ |
| 10 | 0,090 $ | 16,24 $ |
| 20 | 0,180 $ | 32,49 $ |

---

## Decisiones de diseño

**Un solo socket, siempre.** La causa de las caídas en la primera versión era
reconectar llamando otra vez a la función de arranque sin cerrar el socket
anterior: se apilaban sockets y escritores sobre el directorio de credenciales,
que acababan corrompiéndolo. Ahora hay cerrojo de un solo vuelo, derribo
explícito, retroceso exponencial con jitter y tratamiento distinto por código de
cierre. Si pasan cinco minutos sin conexión, el proceso sale con código 1 y
Docker levanta uno limpio.

**Lo volátil, al final del prompt.** El modelo cachea por prefijo común y el
acierto de caché es unas 50 veces más barato. Poner la hora actual en medio del
prompt rompía ese prefijo cada minuto. Con el horario primero y la hora al final,
se reutilizan 512 tokens entre llamadas y entre usuarios.

**Caché por usuario.** Cachear respuestas del modelo con clave global por texto
filtraba el horario de una persona a otra. La clave incluye el identificador de
usuario y la huella de su horario resuelto.

**Escritura atómica.** El estado se escribe a un temporal y se renombra, y las
escrituras se serializan por fichero. Un corte a mitad no deja un JSON roto.

---

## Estructura

```
main.js              arranque y reparto de mensajes
healthcheck.js       latido que lee Docker
anunciar.js          encolar un anuncio
src/
  config.js          rutas, claves, constantes
  log.js             registro
  store.js           persistencia JSON atómica
  horario-base.js    L0: horario oficial y calendario
  horario.js         resolución de capas y fechas
  overrides.js       L1 y L2: cambios con alcance
  eventos.js         L3: exámenes y avisos
  usuarios.js        registro de quién usa el bot
  intent.js          interpretación local del lenguaje
  comandos.js        reparto de respuestas
  ia.js              modelo de lenguaje y transcripción
  formato.js         render limpio para WhatsApp
  difusion.js        cola de anuncios
  wa.js              conexión de WhatsApp
```

---

## Licencia

MIT. Ver [LICENSE](LICENSE).
