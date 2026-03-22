# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es este proyecto

PMO Agent es un proceso PM2 (Node.js) que ejecuta instrucciones de gestión de código y autocorrecciones automáticas usando `claude -p` (CLI, plan Max — sin API key). Recibe instrucciones del admin vía Telegram (`!pmo`) o del monitor cuando detecta errores repetidos, y opera sobre los proyectos del ecosistema a través de MCP Project Servers.

## Arquitectura

```
Admin (Telegram) → telegram-dispatcher → SQLite mensajes.db
                                              ↓
                                         pmo-agent (este proceso)
                                              ↓ spawns
                                    claude -p --mcp-config mcp-projects.json
                                              ↓ MCP stdio
                                    mcp-project-server/server.py (Python, 1 por proyecto)
                                              ↓
                                    Lee/edita código, reinicia PM2, git, tests
```

- **index.js** — Ciclo principal: poll cada 10s a SQLite, identifica proyecto, despacha a `ejecutarClaude()`, envía resultado de vuelta a la cola
- **claude-runner.js** — Wrapper que escribe prompt a archivo temporal, genera .bat, ejecuta `cmd.exe /c bat` con `windowsHide: true`, emite callbacks de progreso
- **config.js** — Mapa de 6 proyectos PM2 con rutas, puertos, nombres MCP, y tiempos (poll, cooldown, timeout)
- **mcp-projects.json** — Configuración MCP que `claude -p --mcp-config` consume; cada entrada apunta a `server.py --root <dir> --pm2 <name>`
- **prompts/** — System prompts: `autocorrect.md` (diagnóstico + fix automático) y `pmo-instruction.md` (instrucciones del admin)

## Comunicación con SQLite

Usa la misma DB que el resto del ecosistema: `C:\Users\gumaro_gonzalez\Desktop\bot-tacos\datos\mensajes.db`

| Tabla | Lee | Escribe | Qué |
|---|---|---|---|
| `mensajes_responses` | `id LIKE 'pmo%'` | — | Instrucciones del admin vía `!pmo` |
| `mensajes_queue` | `origen = 'autocorrect'` | `origen = 'pmo'` | Autocorrections (entrada) y reportes (salida) |
| `pmo_ejecuciones` | — | sí | Historial de ejecuciones (tipo, proyecto, estado, timestamps) |

## Dos modos de operación

1. **Instrucción PMO** (`!pmo proyecto: texto`) — admin pide un cambio, se usa `pmo-instruction.md`
2. **Autocorrect** (monitor escribe `AUTOCORRECT|proyecto|error`) — corrección automática, se usa `autocorrect.md`

Comandos internos sin spawn de Claude: `!pmo proyectos`, `!pmo estado`, `!pmo ayuda`

## Cómo se ejecuta Claude

```bat
type prompt.txt | claude -p --output-format text --model sonnet
  --mcp-config mcp-projects.json --strict-mcp-config
  --permission-mode bypassPermissions --no-session-persistence
  --max-budget-usd 0.50
```

El prompt.txt combina system prompt (.md) + contexto del usuario. Se ejecuta via `cmd.exe /c archivo.bat` con `windowsHide: true` para no abrir ventana.

## Límites y protecciones

- 1 ejecución concurrente (`MAX_CONCURRENT`)
- Cooldown 5 min entre correcciones del mismo servicio
- Timeout 3 min por ejecución de Claude
- Budget $0.50 por ejecución
- MCP server bloquea: `.env`, `*.pem`, `*.key`, `credentials.json`, path traversal, binarios, comandos destructivos

## Comandos de desarrollo

```bash
# Instalar dependencias (mejor-sqlite3 se copia de bot-tacos por Node 24)
cp -r ../bot-tacos/node_modules/better-sqlite3 node_modules/
cp -r ../bot-tacos/node_modules/bindings node_modules/

# Probar que carga sin errores
node -e "require('./config'); require('./claude-runner'); console.log('OK')"

# Probar ejecución de Claude (test rápido)
node -e "require('./claude-runner').ejecutarClaude({promptFile:'pmo-instruction.md', userPrompt:'Solo responde OK', projectName:'test', cwd:require('./config').PROYECTOS.TacosAragon.root, timeout:30000}).then(r=>console.log(r))"

# PM2
pm2 start ecosystem.config.js
pm2 restart pmo-agent
pm2 logs pmo-agent --lines 30 --nostream
```

## Agregar un nuevo proyecto

1. Agregar en `config.js` → `PROYECTOS` (con mcp, root, pm2, puerto, critico, descripcion)
2. Agregar MCP server en `mcp-projects.json`
3. `pm2 restart pmo-agent`

## Dependencia crítica: mcp-project-server

El servidor MCP está en `../mcp-project-server/server.py` (Python). Expone 24 herramientas: `read_file`, `edit_file`, `write_file`, `search_code`, `list_files`, `get_project_structure`, `git_*`, `restart_process`, `view_logs`, `run_tests`, `check_health`, `run_command`, etc. Cada instancia está scoped a un directorio raíz específico.
