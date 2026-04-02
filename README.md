# 🤖 PMO Agent — Ecosistema Aragón

Agente autónomo de gestión de código para el ecosistema Tacos Aragón. Monitorea una cola SQLite y ejecuta instrucciones sobre cualquier proyecto usando **Claude Code CLI** (`claude -p`) con el plan Max — sin API key propia. Puede actuar por instrucción del admin desde Telegram o de forma autónoma al detectar errores repetidos (modo autocorrección).

## Arquitectura y flujo

```
Admin (Telegram)
    │  !pmo tacos-api: agrega endpoint /health
    ▼
telegram-dispatcher
    │  Escribe en SQLite (mensajes_responses)
    ▼
★ pmo-agent (este proyecto)
    │  Poll cada 10s → identifica proyecto → inyecta últimos 15 cambios
    │  → spawns claude -p con MCP config del proyecto
    ▼
mcp-project-server (Python)
    │  26 herramientas: read_file, edit_file, git_commit,
    │  restart_process, view_logs, run_tests, log_change, search_changes...
    ▼
Proyecto target
    │  Lee/edita código, reinicia PM2, verifica health
    │  → log_change() escribe en C:/SesionBot/changelogs/<agente>.jsonl
    ▼
Resultado → SQLite → telegram-dispatcher → Admin
```

### Principio: sin API key

El PMO Agent **no llama a la API de Anthropic**. Invoca `claude -p` (modo no-interactivo del CLI) que usa la suscripción Max del usuario. Es el mismo patrón que un hook de pre-push.

```
claude -p
  --model sonnet
  --mcp-config proyecto.json        # solo el MCP del proyecto target
  --permission-mode bypassPermissions
  --session-id <uuid>               # sesión de 1h por proyecto
  --max-turns 20
```

## Relay de otros agentes

El PMO actúa como relay para orquestador y CFO. Cuando detecta mensajes de esos orígenes en la cola, los re-etiqueta con prefijo `⚙️ [Orquestador]` o `💰 [CFO]` y los encola como `origen='pmo'`, de modo que lleguen al chat privado del admin (que solo acepta `ORIGENES_PRIVADO = ['pmo', 'monitor']`).

```javascript
const PREFIJOS_RELAY = {
  orquestador: '⚙️ [Orquestador]',
  cfo:         '💰 [CFO]',
};
```

---

## Dos modos de operación

### 1. Instrucción manual (`!pmo`)

El admin envía un mensaje en Telegram:

```
!pmo tacos-api: agrega un endpoint GET /health que devuelva { status: "ok" }
!pmo bot: cambia el mensaje de bienvenida
!pmo cfo-agent: corrige el bug de fechas DD/MM/YYYY
```

O usa atajos con autocompletado:

```
/pmo_api agrega endpoint /health
/pmo_bot cambia el mensaje de bienvenida
```

Claude lee el código, aplica cambios, reinicia el servicio, verifica que funcione, y envía un reporte al admin.

### 2. Autocorrección automática

Cuando un monitor detecta errores repetidos en un servicio:

```javascript
mensajesDb.encolarMensaje(
  'autocorrect-tacos-api-' + Date.now(),
  'AUTOCORRECT|tacos-api|TypeError: Cannot read property "precio" at ventas.js:45',
  'autocorrect'
);
```

El PMO Agent diagnostica la causa raíz, aplica el fix mínimo, reinicia, y verifica que el error no reaparezca.

## Sesiones con contexto (1 hora)

Los mensajes comparten un contexto de sesión que dura 1 hora. Claude recuerda todo lo hablado:

```
10:00  !pmo tacos-api: explícame la arquitectura    → NUEVA SESIÓN
10:05  !pmo tacos-api: ahora agrega /health          → CONTINÚA (msg #2)
10:12  !pmo cfo-agent: qué endpoints tiene?           → MISMA SESIÓN (msg #3)
10:20  !pmo tacos-api: y el test para /health?        → RECUERDA todo (msg #4)
11:01  !pmo bot: agrega validación                    → SESIÓN EXPIRADA → nueva
```

Comandos de sesión: `!pmo sesion`, `!pmo nueva sesion`

## MCP Project Server — 26 herramientas

Cada proyecto tiene su propia instancia del servidor MCP (Python), scoped a su directorio raíz:

| Categoría | Herramientas |
|---|---|
| **Lectura** (4) | `read_file`, `list_files`, `search_code`, `get_project_structure` |
| **Escritura** (4) | `edit_file`, `write_file`, `delete_file`, `create_directory` |
| **Git** (6) | `git_status`, `git_diff`, `git_log`, `git_pull`, `git_commit`, `git_add` |
| **PM2** (5) | `get_status`, `view_logs`, `restart_process`, `stop_process`, `start_process` |
| **Testing** (2) | `run_tests`, `check_health` |
| **Contexto** (3) | `read_claude_md`, `get_dependencies`, `run_command` |
| **Changelog** (2) | `log_change`, `search_changes` |

### Seguridad del MCP Server

- Path traversal bloqueado (no se puede salir del directorio del proyecto)
- Archivos sensibles bloqueados: `.env`, `*.pem`, `*.key`, `credentials.json`
- Binarios excluidos (imágenes, ejecutables, bases de datos)
- Comandos destructivos filtrados: `rm -rf /`, `format`, `shutdown`, `curl|bash`, `eval $()`, fork bombs, `chmod 777` y más (13 substrings + 5 regex)
- Máximo 500KB por archivo

## Cancelación desde Telegram: `/pmo_cancelar`

El admin puede cancelar una ejecución en curso directamente desde Telegram:

```
Admin: /pmo_cancelar
→ telegram-dispatcher escribe cancellation en mensajes_responses
→ pmo-agent detecta la señal
→ Ejecuta taskkill /F /T /PID <pid_claude> (Windows)
→ Libera todos los pipes abiertos (fix del pipe deadlock)
→ Encola: "⛔ Ejecución PMO cancelada"
→ Limpia el estado de la sesión activa
```

## Atajos de Telegram

Comandos registrados con autocompletado (escribir `/` para ver el menú):

| Comando | Función |
|---|---|
| `/pmo_proyectos` | Ver proyectos disponibles con estado |
| `/pmo_sesion` | Ver sesión activa (tiempo, mensajes, proyectos) |
| `/pmo_estado` | Últimas 5 ejecuciones |
| `/pmo_reset` | Borrar sesión, empezar contexto nuevo |
| `/pmo_cancelar` | **Cancelar ejecución en curso** |
| `/pmo_bot` | Instrucción a TacosAragon |
| `/pmo_api` | Instrucción a tacos-api |
| `/pmo_cfo` | Instrucción a cfo-agent |
| `/pmo_telegram` | Instrucción a telegram-dispatcher |
| `/pmo_monitor` | Instrucción a MonitorBot |
| `/pmo_portfolio` | Instrucción a portfolio |

Los atajos por proyecto aceptan instrucción directa: `/pmo_api agrega endpoint /health`

## Sistema de changelog

Al terminar cualquier tarea que modifique archivos, Claude llama a `log_change` (herramienta MCP), que escribe en `C:/SesionBot/changelogs/<agente>.jsonl`:

```jsonl
{
  "ts": "2026-03-25T14:30:00-07:00",
  "agente": "pmo-agent",
  "origen": "user",
  "titulo": "Agregar validación RFC en pedidos",
  "desc": "Agregada regex RFC en src/pedidos.js línea 87. Corrige crash cuando cliente omite guión.",
  "archivos": ["src/pedidos.js"],
  "tags": ["bug", "tacos-bot"]
}
```

### Inyección automática de cambios recientes

Antes de cada ejecución, `obtenerCambiosRecientes(15)` lee todos los archivos `.jsonl` de `C:/SesionBot/changelogs/`, los ordena por timestamp y toma los 15 más recientes. Este bloque se inyecta al inicio del system prompt:

```
--- ÚLTIMOS 15 CAMBIOS EN EL ECOSISTEMA ---
[2026-03-25T14:30:00] pmo-agent (user): Fix RFC | Agregada regex ... | tags: bug,tacos-bot
[2026-03-25T13:00:00] pmo-agent (autofix): Restart loop | ... | tags: timeout,session
...
```

Esto permite a Claude entender el contexto reciente antes de atender una nueva instrucción, sin necesidad de examinar el historial git de cada proyecto.

---

## Protocolo XML

El dispatcher y el PMO se comunican con mensajes estructurados en XML para instrucciones complejas o de múltiples pasos:

```xml
<pmo_instruccion>
  <proyecto>tacos-api</proyecto>
  <prioridad>alta</prioridad>
  <instruccion>Agregar endpoint GET /health con timestamp y versión</instruccion>
  <contexto>La app móvil necesita verificar si la API está activa</contexto>
</pmo_instruccion>
```

El PMO extrae los campos, construye el prompt enriquecido y los pasa a Claude. Las propuestas de cambio multi-paso también se encapsulan en XML en la respuesta.

---

## Fix del pipe deadlock en Windows

**Problema:** En Windows, cuando `claude -p` lanzaba subprocesos nietos (p.ej. `curl` dentro de `run_command`), esos procesos mantenían el pipe de stdout abierto después de que el padre terminaba, bloqueando al agente indefinidamente.

**Solución en `claude-runner.js`:**

```javascript
// spawn() en lugar de exec() — permite matar árbol completo
const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });

// Al cancelar o en timeout:
if (process.platform === 'win32') {
  execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
  // /T = kill árbol completo de procesos hijos
}
proc.kill();
```

La misma lógica está en `mcp-project-server/server.py` para `subprocess.Popen` + `taskkill /F /T` en `_run_cmd()`.

---

## Verificación post-ejecución

Después de cualquier fix que involucre reinicio, el PMO realiza tres verificaciones:

1. **Estado PM2:** `pm2 list | grep <nombre>` → debe estar `online`
2. **Health HTTP:** `GET http://localhost:<puerto>/health` → debe devolver 200 (si aplica)
3. **Conteo de errores nuevos:** compara líneas de error antes y después en el log

Si alguna falla, el PMO reporta al admin con el log relevante y no marca la tarea como exitosa.

---

## Seguridad anti-alucinación — Auto-healing

El sistema de autocorrección tiene 7 capas para prevenir que la IA actúe sobre diagnósticos incorrectos o aplique cambios destructivos:

| # | Capa | Protege contra |
|---|------|---------------|
| 1 | **Sanitizar input externo** | Prompt injection via Telegram o mensajes del monitor |
| 2 | **Blocklist `run_command` expandida** | `curl\|bash`, `wget\|sh`, fork bombs, `chmod 777`, `eval $()` |
| 3 | **Git stash antes del fix** | Fix sale mal → `git stash pop` sin depender de la IA |
| 4 | **No auto-aplicar si no es crítico** | Servicios secundarios no se parchean solos por timeout |
| 5 | **Validar diagnóstico estructurado** | Alucinación, respuesta vacía, severidad BAJO pasan a ser abortados |
| 6 | **propId con prefijo de proyecto** | Confusión cruzada entre propuestas de distintos proyectos |
| 7 | **Límite de archivos por fix** | Fix que toca >5 archivos activa alerta al admin |

### Flujo de auto-healing con capas activas

```
Monitor detecta error
    │  [Capa 1] sanitizarErrorDetails() — trunca + neutraliza inyecciones
    ▼
Fase 1: Diagnosticar (solo leer, NO editar)
    │  autocorrect-diagnostico.md
    │  [Capa 5] parsearDiagnostico() — valida formato DIAGNOSTICO|sev|...|fix
    │  [Capa 5] Aborta si vacío, texto libre sin sentido, o severidad BAJO
    ▼
Proponer al admin con timeout
    │  [Capa 6] propId = PROJ-a1b2c3 (prefijo de proyecto)
    │  [Capa 4] Si no es crítico → NUNCA auto-aplicar al expirar
    ▼
Admin aprueba (o timeout en crítico)
    │  [Capa 3] git stash push -u antes de cualquier cambio
    ▼
Fase 2: Aplicar fix
    │  [Capa 2] run_command blocklist — bloquea comandos peligrosos
    │  [Capa 7] git diff stash@{0} HEAD — alerta si >5 archivos modificados
    ▼
Admin puede revertir
    └  git stash pop (determinista, sin IA)
```

## Optimizaciones de rendimiento

| Optimización | Detalle |
|---|---|
| MCP config dinámico | Solo carga el MCP server del proyecto target, no los 6 |
| Cache de system prompts | Lee `.md` una vez, invalida por `mtime` del archivo |
| Guard anti-reentrancia | Previene ejecuciones duplicadas del mismo proyecto |
| Cleanup de huérfanos | `taskkill /F /T` para matar procesos Claude que quedaron vivos |
| `--max-turns 20` | Limita tool calls por ejecución, evita loops de herramientas |
| Sesiones 1h / 8 mensajes | Claude retiene contexto entre instrucciones del mismo proyecto |
| Recovery al reiniciar | Marca como interrumpidas las ejecuciones que quedaron colgadas |
| Changelog en system prompt | Últimos 15 cambios inyectados → Claude tiene contexto histórico |

## Estructura

```
pmo-agent/
├── index.js                       # Proceso principal: polling, dispatch, relay
├── claude-runner.js               # Wrapper claude -p: spawn, sesiones, timeout, XML
├── config.js                      # Mapa de proyectos, topics, timeouts, constantes seguridad
├── mcp-projects.json              # Config MCP completo (6 proyectos)
├── package.json                   # Dependencia: better-sqlite3
├── ecosystem.config.js            # Config PM2
├── prompts/
│   ├── autocorrect-diagnostico.md # System prompt fase 1: solo diagnosticar (sin editar)
│   ├── autocorrect.md             # System prompt fase 2: aplicar fix + verificar
│   ├── pmo-instruction.md         # System prompt: instrucciones del admin
│   ├── topic-bot.md               # Thread TacosAragon
│   ├── topic-api.md               # Thread tacos-api
│   ├── topic-cfo.md               # Thread cfo-agent
│   ├── topic-monitor.md           # Thread MonitorBot
│   └── topic-general.md           # Fallback general
└── state/                         # Estado interno (cooldowns activos)

../mcp-project-server/
└── server.py                      # 26 herramientas MCP (incluye log_change, search_changes)
```

## Configuración

| Parámetro | Valor | Descripción |
|---|---|---|
| `POLL_INTERVAL_MS` | 10,000 (10s) | Frecuencia de polling a SQLite |
| `CLAUDE_TIMEOUT_MS` | 600,000 (10min) | Timeout hard cap para claude -p |
| `CLAUDE_TIMEOUT_INSTRUCCION_MS` | 300,000 (5min) | Timeout instrucciones PMO simples |
| `CLAUDE_TIMEOUT_DIAGNOSTICO_MS` | 180,000 (3min) | Timeout diagnóstico autocorrect |
| `CLAUDE_TIMEOUT_FIX_MS` | 480,000 (8min) | Timeout aplicar/revertir fix |
| `MAX_CONCURRENT` | 3 | Proyectos distintos en paralelo |
| `COOLDOWN_MS` | 300,000 (5min) | Cooldown entre correcciones mismo servicio |
| `APROBACION_CRITICO_MS` | 900,000 (15min) | Timeout propuesta servicios críticos |
| `APROBACION_NO_CRIT_MS` | 300,000 (5min) | Timeout propuesta servicios no críticos |
| `SESSION_TTL_MS` | 3,600,000 (1h) | Duración de sesiones con contexto |
| `MAX_ERROR_DETAILS_CHARS` | 1,000 | Máx chars del payload de error del monitor |
| `MIN_DIAGNOSTICO_CHARS` | 150 | Mínimo chars para diagnóstico válido |
| `MAX_FILES_PER_FIX` | 5 | Máx archivos que un autocorrect puede modificar |

## Agregar un nuevo proyecto

**1.** Agregar en `config.js` → `PROYECTOS`:
```javascript
'nuevo-proyecto': {
  mcp: 'project-nuevo',
  root: 'C:\\ruta\\al\\proyecto',
  pm2: 'nombre-en-pm2',
  puerto: 3005,
  critico: true,
  descripcion: 'Descripción breve del proyecto',
},
```

**2.** Agregar MCP server en `mcp-projects.json`:
```json
"project-nuevo": {
  "command": "python",
  "args": [
    "ruta/mcp-project-server/server.py",
    "--root", "ruta/al/proyecto",
    "--pm2", "nombre-en-pm2",
    "--name", "nuevo"
  ]
}
```

**3.** Agregar atajo en `telegram-dispatcher/index.js` (opcional)

**4.** Reiniciar: `pm2 restart pmo-agent`

## Instalación

### Requisitos

- Node.js 18+
- Python 3.10+ con `pip install mcp pydantic`
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- Plan Max de Claude (o API key como alternativa)
- PM2 (`npm install -g pm2`)
- better-sqlite3 (compilado para tu versión de Node)

### Pasos

```bash
# 1. Clonar
git clone https://github.com/AntonioAragon/pmo-agent.git
cd pmo-agent

# 2. Instalar dependencias
npm install

# 3. Configurar proyectos en config.js y mcp-projects.json

# 4. Configurar la ruta a mensajes.db en config.js → MENSAJES_DB

# 5. Iniciar
pm2 start ecosystem.config.js

# 6. Verificar
pm2 logs pmo-agent --lines 10 --nostream
```

## Métricas de producción (primera noche)

| Métrica | Valor |
|---|---|
| Total ejecuciones | 9 |
| Tasa de éxito real | 100% (7/7 sin bugs infra) |
| Tiempo promedio | 80s (exitosas limpias) |
| Tiempo mínimo | 11s |
| Tokens input/ejecución | ~14,830 |
| Tokens output/ejecución | ~193 |
| Costo equivalente API/ejecución | $0.047 USD |

## Costos: API vs Plan Max

| Uso (30/día × 30 días) | GPT-4o API | Sonnet API | Plan Max |
|---|---|---|---|
| Mensual | $35.85 | $42.50 | $100.00 |
| Anual | $430.20 | $510.00 | $1,200.00 |

Plan Max se justifica cuando el PMO se usa 70+ veces/día, o cuando se suma el uso manual de Claude Code.

## Comunicación SQLite

Usa la misma base de datos compartida del ecosistema:

| Tabla | Lee | Escribe | Qué |
|---|---|---|---|
| `mensajes_responses` | `id LIKE 'pmo%'` | — | Instrucciones del admin e IDs de cancelación |
| `mensajes_queue` | `origen = 'autocorrect'` | `origen = 'pmo'` | Autocorrecciones + reportes + relay |
| `pmo_ejecuciones` | — | sí | Historial de ejecuciones (estado, timestamps) |

---

## Licencia

Aragón Attribution License v1.0 — Uso libre con atribución obligatoria. Ver [LICENSE](LICENSE).

