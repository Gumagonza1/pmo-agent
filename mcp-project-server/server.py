"""
MCP Project Server — Ecosistema Aragón
Expone herramientas de gestión de código y procesos para un proyecto específico.

Uso:
    python server.py --root C:\\ruta\\proyecto --pm2 nombre-proceso
    python server.py --root C:\\ruta\\proyecto --pm2 nombre-proceso --transport sse --port 8081
"""

import argparse
import asyncio
import fnmatch
import os
import re
import subprocess
import sys
from pathlib import Path

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

# ── Configuración global ────────────────────────────────────────────────────

PROJECT_ROOT: Path = Path(".")
PM2_NAME: str = ""
PROJECT_NAME: str = ""
PM2_LOGS_DIR: Path | None = None  # Directorio de logs PM2 (leído directo del disco)

# Archivos/carpetas que NUNCA se deben exponer ni modificar
BLOCKED_PATTERNS = [
    ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx",
    "credentials.json", "service-account*.json",
    "node_modules/**", ".git/objects/**", "__pycache__/**",
]

# Extensiones que se consideran binarias (no leer/editar)
BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
    ".mp3", ".mp4", ".wav", ".avi", ".mov",
    ".zip", ".tar", ".gz", ".rar", ".7z",
    ".exe", ".dll", ".so", ".dylib",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx",
    ".sqlite", ".db", ".sqlite3",
}

MAX_FILE_SIZE = 500_000  # 500 KB máximo para lectura
MAX_LINES_OUTPUT = 500   # Máximo de líneas en salida


def _is_blocked(rel_path: str) -> bool:
    """Verifica si un path relativo está en la lista de bloqueados."""
    rel_path = rel_path.replace("\\", "/")
    for pattern in BLOCKED_PATTERNS:
        if fnmatch.fnmatch(rel_path, pattern):
            return True
        if fnmatch.fnmatch(os.path.basename(rel_path), pattern):
            return True
    return False


def _is_binary(path: Path) -> bool:
    """Verifica si un archivo es binario por extensión."""
    return path.suffix.lower() in BINARY_EXTENSIONS


def _resolve_path(relative_path: str) -> Path:
    """Resuelve un path relativo al proyecto, validando seguridad."""
    # Normalizar separadores
    relative_path = relative_path.replace("\\", "/").lstrip("/")

    # Prevenir path traversal
    if ".." in relative_path.split("/"):
        raise ValueError("Path traversal no permitido (..)")

    full_path = (PROJECT_ROOT / relative_path).resolve()

    # Verificar que queda dentro del proyecto
    try:
        full_path.relative_to(PROJECT_ROOT.resolve())
    except ValueError:
        raise ValueError(f"Path fuera del proyecto: {relative_path}")

    # Verificar que no está bloqueado
    rel = str(full_path.relative_to(PROJECT_ROOT.resolve())).replace("\\", "/")
    if _is_blocked(rel):
        raise ValueError(f"Archivo bloqueado por seguridad: {relative_path}")

    return full_path


def _run_cmd(cmd: list[str], cwd: Path | None = None, timeout: int = 30) -> str:
    """Ejecuta un comando y devuelve stdout+stderr.
    En Windows mata el árbol de procesos al hacer timeout (subprocess.TimeoutExpired
    no mata los hijos por defecto en Windows).
    """
    proc = None
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd or PROJECT_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            shell=(sys.platform == "win32"),
        )
        stdout, stderr = proc.communicate(timeout=timeout)
        output = stdout
        if stderr:
            output += "\n--- stderr ---\n" + stderr
        return output.strip() or "(sin salida)"
    except subprocess.TimeoutExpired:
        # Matar árbol de procesos en Windows
        if proc:
            try:
                subprocess.run(
                    ["/bin/kill", "-9", str(proc.pid)],
                    capture_output=True, timeout=5
                )
            except Exception:
                pass
            try:
                proc.kill()
            except Exception:
                pass
        return f"ERROR: Comando excedió timeout de {timeout}s"
    except Exception as e:
        return f"ERROR: {e}"


# ── Definición de herramientas ──────────────────────────────────────────────


TOOLS = {
    # ═══════════════════════════════════════════════════════════════════════
    #  CÓDIGO — Lectura
    # ═══════════════════════════════════════════════════════════════════════
    "read_file": Tool(
        name="read_file",
        description=(
            "Lee el contenido de un archivo del proyecto. "
            "Devuelve el contenido con números de línea. "
            "Para archivos grandes, usar offset y limit."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Ruta relativa al archivo (ej: src/index.js)",
                },
                "offset": {
                    "type": "integer",
                    "description": "Línea desde la cual empezar a leer (1-based). Default: 1",
                    "default": 1,
                },
                "limit": {
                    "type": "integer",
                    "description": "Máximo de líneas a devolver. Default: 200",
                    "default": 200,
                },
            },
            "required": ["path"],
        },
    ),
    "list_files": Tool(
        name="list_files",
        description=(
            "Lista archivos del proyecto que coinciden con un patrón glob. "
            "Devuelve rutas relativas ordenadas. "
            "Ejemplo: '**/*.js', 'src/**/*.py', '*.json'"
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Patrón glob (ej: **/*.js, src/*.py)",
                    "default": "**/*",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Máximo de resultados. Default: 100",
                    "default": 100,
                },
            },
        },
    ),
    "search_code": Tool(
        name="search_code",
        description=(
            "Busca texto o regex en los archivos del proyecto. "
            "Devuelve archivo:línea:contenido para cada coincidencia. "
            "Usa ripgrep si está disponible, si no grep recursivo."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Texto o regex a buscar",
                },
                "glob": {
                    "type": "string",
                    "description": "Filtro de archivos (ej: *.js, *.py). Default: todos",
                    "default": "",
                },
                "case_insensitive": {
                    "type": "boolean",
                    "description": "Ignorar mayúsculas/minúsculas. Default: false",
                    "default": False,
                },
                "max_results": {
                    "type": "integer",
                    "description": "Máximo de coincidencias. Default: 50",
                    "default": 50,
                },
            },
            "required": ["pattern"],
        },
    ),
    "get_project_structure": Tool(
        name="get_project_structure",
        description=(
            "Devuelve el árbol de directorios del proyecto. "
            "Excluye node_modules, .git, __pycache__, etc. "
            "Útil para entender la arquitectura antes de hacer cambios."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "max_depth": {
                    "type": "integer",
                    "description": "Profundidad máxima del árbol. Default: 4",
                    "default": 4,
                },
            },
        },
    ),

    # ═══════════════════════════════════════════════════════════════════════
    #  CÓDIGO — Escritura (★ la más importante)
    # ═══════════════════════════════════════════════════════════════════════
    "write_file": Tool(
        name="write_file",
        description=(
            "Crea o sobreescribe un archivo en el proyecto. "
            "CUIDADO: reemplaza todo el contenido. "
            "Para cambios parciales, usar edit_file. "
            "Crea directorios intermedios automáticamente."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Ruta relativa del archivo a crear/sobreescribir",
                },
                "content": {
                    "type": "string",
                    "description": "Contenido completo del archivo",
                },
            },
            "required": ["path", "content"],
        },
    ),
    "edit_file": Tool(
        name="edit_file",
        description=(
            "★ HERRAMIENTA PRINCIPAL — Edita un archivo reemplazando texto. "
            "Busca old_text exacto y lo reemplaza por new_text. "
            "El old_text debe ser único en el archivo para evitar cambios no deseados. "
            "Si necesitas reemplazar todas las ocurrencias, usa replace_all=true. "
            "SIEMPRE leer el archivo primero con read_file antes de editar."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Ruta relativa del archivo a editar",
                },
                "old_text": {
                    "type": "string",
                    "description": "Texto exacto a buscar (incluyendo indentación y saltos de línea)",
                },
                "new_text": {
                    "type": "string",
                    "description": "Texto de reemplazo",
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "Reemplazar todas las ocurrencias. Default: false",
                    "default": False,
                },
            },
            "required": ["path", "old_text", "new_text"],
        },
    ),
    "delete_file": Tool(
        name="delete_file",
        description=(
            "Elimina un archivo del proyecto. "
            "Requiere confirmación explícita — no elimina directorios. "
            "No se puede deshacer (excepto con git checkout)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Ruta relativa del archivo a eliminar",
                },
            },
            "required": ["path"],
        },
    ),
    "create_directory": Tool(
        name="create_directory",
        description="Crea un directorio (y sus padres) en el proyecto.",
        inputSchema={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Ruta relativa del directorio a crear",
                },
            },
            "required": ["path"],
        },
    ),

    # ═══════════════════════════════════════════════════════════════════════
    #  PROCESO PM2
    # ═══════════════════════════════════════════════════════════════════════
    "get_status": Tool(
        name="get_status",
        description=(
            "Obtiene el estado actual del proceso PM2: "
            "status, CPU, memoria, uptime, restarts."
        ),
        inputSchema={"type": "object", "properties": {}},
    ),
    "view_logs": Tool(
        name="view_logs",
        description=(
            "Muestra las últimas líneas del log de PM2. "
            "Incluye stdout y stderr."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "lines": {
                    "type": "integer",
                    "description": "Número de líneas a mostrar. Default: 50",
                    "default": 50,
                },
                "err_only": {
                    "type": "boolean",
                    "description": "Solo mostrar stderr. Default: false",
                    "default": False,
                },
            },
        },
    ),
    "restart_process": Tool(
        name="restart_process",
        description=(
            "Reinicia el proceso PM2 del proyecto. "
            "Equivale a 'pm2 restart <nombre>'."
        ),
        inputSchema={"type": "object", "properties": {}},
    ),
    "stop_process": Tool(
        name="stop_process",
        description="Detiene el proceso PM2 del proyecto.",
        inputSchema={"type": "object", "properties": {}},
    ),
    "start_process": Tool(
        name="start_process",
        description="Inicia el proceso PM2 del proyecto (si está detenido).",
        inputSchema={"type": "object", "properties": {}},
    ),

    # ═══════════════════════════════════════════════════════════════════════
    #  GIT
    # ═══════════════════════════════════════════════════════════════════════
    "git_status": Tool(
        name="git_status",
        description="Muestra el estado de git: archivos modificados, staged, untracked.",
        inputSchema={"type": "object", "properties": {}},
    ),
    "git_diff": Tool(
        name="git_diff",
        description=(
            "Muestra los cambios (diff) en el proyecto. "
            "Sin argumentos muestra todos los cambios no-staged. "
            "Con --staged muestra los cambios staged."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "description": "Archivo específico para el diff (opcional)",
                    "default": "",
                },
                "staged": {
                    "type": "boolean",
                    "description": "Mostrar solo cambios staged. Default: false",
                    "default": False,
                },
            },
        },
    ),
    "git_log": Tool(
        name="git_log",
        description="Muestra los últimos commits del proyecto.",
        inputSchema={
            "type": "object",
            "properties": {
                "count": {
                    "type": "integer",
                    "description": "Número de commits a mostrar. Default: 10",
                    "default": 10,
                },
                "file": {
                    "type": "string",
                    "description": "Filtrar por archivo específico (opcional)",
                    "default": "",
                },
            },
        },
    ),
    "git_pull": Tool(
        name="git_pull",
        description=(
            "Ejecuta git pull en el proyecto. "
            "Solo funciona si no hay cambios locales sin commitear."
        ),
        inputSchema={"type": "object", "properties": {}},
    ),
    "git_commit": Tool(
        name="git_commit",
        description=(
            "Crea un commit con los cambios staged. "
            "Si no hay cambios staged, agrega los archivos modificados tracked."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "Mensaje del commit",
                },
                "files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Archivos específicos a incluir (opcional, default: todos los modificados)",
                    "default": [],
                },
            },
            "required": ["message"],
        },
    ),
    "git_add": Tool(
        name="git_add",
        description="Agrega archivos al staging area de git.",
        inputSchema={
            "type": "object",
            "properties": {
                "files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Lista de archivos a agregar. Usar ['.'] para todos.",
                },
            },
            "required": ["files"],
        },
    ),

    # ═══════════════════════════════════════════════════════════════════════
    #  TESTING Y VALIDACIÓN
    # ═══════════════════════════════════════════════════════════════════════
    "run_tests": Tool(
        name="run_tests",
        description=(
            "Ejecuta los tests del proyecto. "
            "Detecta automáticamente: node --test, pytest, npm test."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "description": "Archivo de test específico (opcional)",
                    "default": "",
                },
            },
        },
    ),
    "check_health": Tool(
        name="check_health",
        description=(
            "Verifica la salud del servicio HTTP. "
            "Hace un request al endpoint de health y devuelve status code + body."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "URL completa a verificar (ej: http://localhost:3001/health)",
                },
            },
            "required": ["url"],
        },
    ),

    # ═══════════════════════════════════════════════════════════════════════
    #  CONTEXTO DEL PROYECTO
    # ═══════════════════════════════════════════════════════════════════════
    "read_claude_md": Tool(
        name="read_claude_md",
        description=(
            "Lee el CLAUDE.md del proyecto — contiene la documentación técnica, "
            "reglas y contexto necesarios para trabajar en este proyecto."
        ),
        inputSchema={"type": "object", "properties": {}},
    ),
    "get_dependencies": Tool(
        name="get_dependencies",
        description=(
            "Lee las dependencias del proyecto: "
            "package.json (Node) o requirements.txt (Python)."
        ),
        inputSchema={"type": "object", "properties": {}},
    ),
    "run_command": Tool(
        name="run_command",
        description=(
            "Ejecuta un comando shell arbitrario en el directorio del proyecto. "
            "Timeout: 60 segundos. "
            "PRECAUCIÓN: No ejecutar comandos destructivos sin verificar."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Comando a ejecutar (ej: 'npm install', 'pip freeze')",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout en segundos. Default: 60",
                    "default": 60,
                },
            },
            "required": ["command"],
        },
    ),
}


# ── Implementación de herramientas ──────────────────────────────────────────


async def handle_read_file(args: dict) -> str:
    path = _resolve_path(args["path"])
    if not path.exists():
        return f"ERROR: Archivo no encontrado: {args['path']}"
    if not path.is_file():
        return f"ERROR: No es un archivo: {args['path']}"
    if _is_binary(path):
        return f"ERROR: Archivo binario ({path.suffix}) — no se puede leer como texto"
    if path.stat().st_size > MAX_FILE_SIZE:
        return f"ERROR: Archivo muy grande ({path.stat().st_size:,} bytes > {MAX_FILE_SIZE:,})"

    offset = max(1, args.get("offset", 1))
    limit = min(args.get("limit", 200), MAX_LINES_OUTPUT)

    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    total = len(lines)
    selected = lines[offset - 1: offset - 1 + limit]

    result = f"# {args['path']} ({total} líneas total, mostrando {offset}-{offset + len(selected) - 1})\n\n"
    for i, line in enumerate(selected, start=offset):
        result += f"{i:>5}│ {line}\n"

    if offset + limit - 1 < total:
        result += f"\n... {total - (offset + limit - 1)} líneas más (usar offset={offset + limit})"

    return result


async def handle_list_files(args: dict) -> str:
    pattern = args.get("pattern", "**/*")
    max_results = min(args.get("max_results", 100), 500)

    matches = []
    for p in sorted(PROJECT_ROOT.glob(pattern)):
        rel = str(p.relative_to(PROJECT_ROOT)).replace("\\", "/")
        # Excluir directorios internos
        if any(part in rel.split("/") for part in ["node_modules", ".git", "__pycache__", ".next", "dist"]):
            continue
        if _is_blocked(rel):
            continue
        tipo = "D" if p.is_dir() else "F"
        size = ""
        if p.is_file():
            s = p.stat().st_size
            size = f" ({s:,} bytes)" if s > 1024 else f" ({s} bytes)"
        matches.append(f"  {tipo} {rel}{size}")
        if len(matches) >= max_results:
            break

    if not matches:
        return f"Sin coincidencias para el patrón: {pattern}"

    return f"# Archivos ({len(matches)} resultados, patrón: {pattern})\n\n" + "\n".join(matches)


async def handle_search_code(args: dict) -> str:
    pattern = args["pattern"]
    glob_filter = args.get("glob", "")
    case_i = args.get("case_insensitive", False)
    max_results = min(args.get("max_results", 50), 200)

    # Intentar con rg (ripgrep) primero, luego grep
    cmd = ["rg", "--no-heading", "--line-number", f"--max-count={max_results}"]
    if case_i:
        cmd.append("-i")
    if glob_filter:
        cmd.extend(["--glob", glob_filter])
    cmd.extend([
        "--glob", "!node_modules",
        "--glob", "!.git",
        "--glob", "!__pycache__",
        "--glob", "!*.min.js",
        "--glob", "!package-lock.json",
        pattern,
    ])

    output = _run_cmd(cmd, PROJECT_ROOT, timeout=15)

    # Si rg no está disponible, fallback a grep
    if "ERROR" in output and ("not found" in output or "not recognized" in output):
        cmd = ["grep", "-rn", "--include", glob_filter or "*", pattern, "."]
        if case_i:
            cmd.insert(1, "-i")
        output = _run_cmd(cmd, PROJECT_ROOT, timeout=15)

    lines = output.splitlines()[:max_results]
    return f"# Búsqueda: '{pattern}' ({len(lines)} resultados)\n\n" + "\n".join(lines)


async def handle_get_project_structure(args: dict) -> str:
    max_depth = min(args.get("max_depth", 4), 6)
    skip_dirs = {"node_modules", ".git", "__pycache__", ".next", "dist", ".cache", "venv", ".venv"}
    lines = [f"# Estructura: {PROJECT_NAME}\n"]

    def _walk(directory: Path, prefix: str, depth: int):
        if depth > max_depth:
            return
        try:
            entries = sorted(directory.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
        except PermissionError:
            return
        dirs = [e for e in entries if e.is_dir() and e.name not in skip_dirs and not e.name.startswith(".")]
        files = [e for e in entries if e.is_file() and not _is_blocked(e.name)]

        for f in files:
            lines.append(f"{prefix}├── {f.name}")
        for i, d in enumerate(dirs):
            connector = "└── " if i == len(dirs) - 1 and not files else "├── "
            lines.append(f"{prefix}{connector}{d.name}/")
            extension = "    " if i == len(dirs) - 1 else "│   "
            _walk(d, prefix + extension, depth + 1)

    _walk(PROJECT_ROOT, "", 0)
    return "\n".join(lines[:300])


async def handle_write_file(args: dict) -> str:
    path = _resolve_path(args["path"])
    content = args["content"]

    # Crear directorios intermedios
    path.parent.mkdir(parents=True, exist_ok=True)

    existed = path.exists()
    old_size = path.stat().st_size if existed else 0

    path.write_text(content, encoding="utf-8")
    new_size = path.stat().st_size

    action = "Actualizado" if existed else "Creado"
    return f"✓ {action}: {args['path']} ({new_size:,} bytes)"


async def handle_edit_file(args: dict) -> str:
    path = _resolve_path(args["path"])
    if not path.exists():
        return f"ERROR: Archivo no encontrado: {args['path']}"
    if not path.is_file():
        return f"ERROR: No es un archivo: {args['path']}"

    old_text = args["old_text"]
    new_text = args["new_text"]
    replace_all = args.get("replace_all", False)

    content = path.read_text(encoding="utf-8", errors="replace")

    if old_text not in content:
        # Dar contexto para ayudar a encontrar el texto correcto
        return (
            f"ERROR: old_text no encontrado en {args['path']}.\n"
            f"Texto buscado ({len(old_text)} chars):\n"
            f"  '{old_text[:200]}...'\n\n"
            f"Sugerencia: Usa read_file primero para ver el contenido exacto."
        )

    if not replace_all:
        count = content.count(old_text)
        if count > 1:
            return (
                f"ERROR: old_text aparece {count} veces en {args['path']}. "
                f"Incluye más contexto para hacerlo único, o usa replace_all=true."
            )

    if replace_all:
        count = content.count(old_text)
        new_content = content.replace(old_text, new_text)
    else:
        count = 1
        new_content = content.replace(old_text, new_text, 1)

    path.write_text(new_content, encoding="utf-8")

    return f"✓ Editado: {args['path']} ({count} reemplazo{'s' if count > 1 else ''})"


async def handle_delete_file(args: dict) -> str:
    path = _resolve_path(args["path"])
    if not path.exists():
        return f"ERROR: Archivo no encontrado: {args['path']}"
    if not path.is_file():
        return f"ERROR: No es un archivo (¿es un directorio?): {args['path']}"

    path.unlink()
    return f"✓ Eliminado: {args['path']}"


async def handle_create_directory(args: dict) -> str:
    path = _resolve_path(args["path"])
    path.mkdir(parents=True, exist_ok=True)
    return f"✓ Directorio creado: {args['path']}"


async def handle_get_status(args: dict) -> str:
    if not PM2_NAME:
        return "ERROR: No se configuró nombre de proceso PM2"
    output = _run_cmd(["pm2", "show", PM2_NAME])
    return f"# Estado de {PM2_NAME}\n\n{output}"


async def handle_view_logs(args: dict) -> str:
    if not PM2_NAME:
        return "ERROR: No se configuró nombre de proceso PM2"
    lines_count = min(args.get("lines", 50), 200)
    err_only = args.get("err_only", False)

    # ── Leer directo del archivo de log en disco (evita IPC con PM2 daemon) ──
    import glob as _glob

    def _leer_log_disco(suffix: str) -> str | None:
        """Busca archivos de log PM2 en el directorio de logs y devuelve últimas N líneas."""
        candidatos = []
        # Directorio configurado vía --logs-dir
        if PM2_LOGS_DIR and PM2_LOGS_DIR.is_dir():
            candidatos += list(PM2_LOGS_DIR.glob(f"{PM2_NAME}-{suffix}-*.log"))
            candidatos += list(PM2_LOGS_DIR.glob(f"{PM2_NAME}-{suffix}.log"))
        # Fallback: directorio estándar del ecosistema
        ecosistema_logs = Path(os.environ.get("LOGS_DIR", "/app/logs"))
        if ecosistema_logs.is_dir():
            candidatos += list(ecosistema_logs.glob(f"{PM2_NAME}-{suffix}-*.log"))
        # Fallback: ~/.pm2/logs/
        pm2_home = Path.home() / ".pm2" / "logs"
        if pm2_home.is_dir():
            candidatos += list(pm2_home.glob(f"{PM2_NAME}-{suffix}.log"))
            candidatos += list(pm2_home.glob(f"{PM2_NAME}-out.log"))

        if not candidatos:
            return None

        # El más reciente
        log_file = max(candidatos, key=lambda p: p.stat().st_mtime)
        try:
            content = log_file.read_text(encoding="utf-8", errors="replace")
            tail = content.splitlines()[-lines_count:]
            return f"# {log_file.name}\n\n" + "\n".join(tail)
        except Exception as e:
            return f"ERROR leyendo {log_file}: {e}"

    if not err_only:
        out_content = _leer_log_disco("out")
        if out_content:
            err_content = _leer_log_disco("error") or ""
            combined = out_content
            if err_content and "error" in err_content.lower():
                combined += f"\n\n{err_content}"
            return f"# Logs de {PM2_NAME} (últimas {lines_count} líneas)\n\n{combined}"
    else:
        err_content = _leer_log_disco("error")
        if err_content:
            return f"# Logs [stderr] de {PM2_NAME}\n\n{err_content}"

    # ── Fallback: pm2 logs con timeout corto ─────────────────────────────────
    cmd = ["pm2", "logs", PM2_NAME, "--lines", str(lines_count), "--nostream"]
    if err_only:
        cmd.append("--err")
    output = _run_cmd(cmd, timeout=12)
    return f"# Logs de {PM2_NAME} (últimas {lines_count} líneas)\n\n{output}"


async def handle_restart_process(args: dict) -> str:
    if not PM2_NAME:
        return "ERROR: No se configuró nombre de proceso PM2"
    output = _run_cmd(["pm2", "restart", PM2_NAME])
    return f"✓ Reiniciado: {PM2_NAME}\n\n{output}"


async def handle_stop_process(args: dict) -> str:
    if not PM2_NAME:
        return "ERROR: No se configuró nombre de proceso PM2"
    output = _run_cmd(["pm2", "stop", PM2_NAME])
    return f"✓ Detenido: {PM2_NAME}\n\n{output}"


async def handle_start_process(args: dict) -> str:
    if not PM2_NAME:
        return "ERROR: No se configuró nombre de proceso PM2"
    output = _run_cmd(["pm2", "start", PM2_NAME])
    return f"✓ Iniciado: {PM2_NAME}\n\n{output}"


async def handle_git_status(args: dict) -> str:
    output = _run_cmd(["git", "status", "--short"], PROJECT_ROOT)
    branch = _run_cmd(["git", "branch", "--show-current"], PROJECT_ROOT)
    return f"# Git Status — rama: {branch}\n\n{output}"


async def handle_git_diff(args: dict) -> str:
    cmd = ["git", "diff"]
    if args.get("staged", False):
        cmd.append("--staged")
    if args.get("file", ""):
        cmd.append(args["file"])
    output = _run_cmd(cmd, PROJECT_ROOT, timeout=15)
    lines = output.splitlines()[:MAX_LINES_OUTPUT]
    return "# Git Diff\n\n" + "\n".join(lines)


async def handle_git_log(args: dict) -> str:
    count = min(args.get("count", 10), 50)
    cmd = ["git", "log", f"-{count}", "--oneline", "--graph", "--date=short",
           "--format=%h %ad %s"]
    if args.get("file", ""):
        cmd.extend(["--", args["file"]])
    output = _run_cmd(cmd, PROJECT_ROOT)
    return f"# Git Log (últimos {count} commits)\n\n{output}"


async def handle_git_pull(args: dict) -> str:
    # Verificar que no hay cambios sin commitear
    status = _run_cmd(["git", "status", "--porcelain"], PROJECT_ROOT)
    if status and status != "(sin salida)":
        modified = [l for l in status.splitlines() if l.strip() and not l.startswith("?")]
        if modified:
            return (
                "ERROR: Hay cambios sin commitear. Commitea o stashea antes de pull.\n\n"
                + "\n".join(modified)
            )

    output = _run_cmd(["git", "pull", "--ff-only"], PROJECT_ROOT, timeout=60)
    return f"# Git Pull\n\n{output}"


async def handle_git_commit(args: dict) -> str:
    message = args["message"]
    files = args.get("files", [])

    if files:
        for f in files:
            _run_cmd(["git", "add", f], PROJECT_ROOT)
    else:
        # Verificar si hay algo staged
        staged = _run_cmd(["git", "diff", "--staged", "--name-only"], PROJECT_ROOT)
        if not staged or staged == "(sin salida)":
            # Stage todos los archivos modificados (tracked)
            _run_cmd(["git", "add", "-u"], PROJECT_ROOT)

    output = _run_cmd(["git", "commit", "-m", message], PROJECT_ROOT)
    return f"# Git Commit\n\n{output}"


async def handle_git_add(args: dict) -> str:
    files = args["files"]
    results = []
    for f in files:
        output = _run_cmd(["git", "add", f], PROJECT_ROOT)
        results.append(f"  + {f}")
    return "✓ Archivos agregados al staging:\n" + "\n".join(results)


async def handle_run_tests(args: dict) -> str:
    test_file = args.get("file", "")

    # Detectar tipo de proyecto
    has_package_json = (PROJECT_ROOT / "package.json").exists()
    has_requirements = (PROJECT_ROOT / "requirements.txt").exists()
    has_pytest = (PROJECT_ROOT / "tests").is_dir() or (PROJECT_ROOT / "test").is_dir()

    if has_package_json:
        # Node.js
        tests_dir = PROJECT_ROOT / "tests"
        if test_file:
            cmd = ["node", "--test", test_file]
        elif tests_dir.is_dir():
            test_files = list(tests_dir.glob("*.test.js")) + list(tests_dir.glob("*.test.mjs"))
            if test_files:
                cmd = ["node", "--test"] + [str(f.relative_to(PROJECT_ROOT)) for f in test_files[:10]]
            else:
                cmd = ["npm", "test"]
        else:
            cmd = ["npm", "test"]
    elif has_requirements or has_pytest:
        # Python
        if test_file:
            cmd = ["python", "-m", "pytest", test_file, "-v"]
        else:
            cmd = ["python", "-m", "pytest", "-v"]
    else:
        return "ERROR: No se detectó framework de testing (no hay package.json ni requirements.txt)"

    output = _run_cmd(cmd, PROJECT_ROOT, timeout=120)
    return f"# Tests — {PROJECT_NAME}\n\n{output}"


async def handle_check_health(args: dict) -> str:
    url = args["url"]
    cmd = ["curl", "-s", "-o", "-", "-w", "\n---HTTP_CODE:%{http_code}---", url]
    output = _run_cmd(cmd, timeout=10)
    return f"# Health Check: {url}\n\n{output}"


async def handle_read_claude_md(args: dict) -> str:
    # Buscar CLAUDE.md en el proyecto
    candidates = [
        PROJECT_ROOT / "CLAUDE.md",
        PROJECT_ROOT / "claude.md",
        PROJECT_ROOT / "web" / "CLAUDE.md",
    ]
    for c in candidates:
        if c.exists():
            content = c.read_text(encoding="utf-8", errors="replace")
            return f"# CLAUDE.md — {PROJECT_NAME}\n\n{content}"

    return f"No se encontró CLAUDE.md en {PROJECT_NAME}"


async def handle_get_dependencies(args: dict) -> str:
    result = []

    pkg = PROJECT_ROOT / "package.json"
    if pkg.exists():
        content = pkg.read_text(encoding="utf-8", errors="replace")
        result.append(f"# package.json\n\n{content}")

    req = PROJECT_ROOT / "requirements.txt"
    if req.exists():
        content = req.read_text(encoding="utf-8", errors="replace")
        result.append(f"# requirements.txt\n\n{content}")

    if not result:
        return "No se encontró package.json ni requirements.txt"

    return "\n\n---\n\n".join(result)


async def handle_run_command(args: dict) -> str:
    command = args["command"]
    timeout = min(args.get("timeout", 60), 120)

    # ── Capa 2: Blocklist expandida ────────────────────────────────────────
    # Substrings que se bloquean directamente
    BLOCKED_SUBSTRINGS = [
        "rm -rf /", "rm -rf ~", "rm -fr /", "rm -fr ~",
        "format ", "mkformat ",
        "del /s /q", "rmdir /s /q",
        "shutdown", "reboot", "halt", "poweroff",
        ":(){:|:&};:",          # fork bomb
        "DROP TABLE", "DROP DATABASE", "TRUNCATE TABLE",
        "chmod 777",            # permisos inseguros en producción
        "chown -R",             # cambio masivo de propietario
        "npm install -g",       # instalación global no supervisada
        "> /etc/",              # sobreescribir archivos del sistema
        "mkfs",                 # formatear partición
    ]

    # Patrones regex para comportamientos de pipeline peligrosos
    BLOCKED_PATTERNS_RE = [
        r"curl\s+.*\|\s*(bash|sh|python\d*|node)",   # descargar y ejecutar
        r"wget\s+.*\|\s*(bash|sh|python\d*|node)",
        r"(bash|sh)\s+<\s*\(",                        # process substitution
        r"eval\s+['\"`]?\$[\(\{]",                   # eval dinámico
        r"\.\./\.\./\.\./",                           # path traversal profundo
    ]

    cmd_lower = command.lower()

    for blocked in BLOCKED_SUBSTRINGS:
        if blocked.lower() in cmd_lower:
            return f"ERROR: Comando bloqueado por seguridad: contiene '{blocked}'"

    for pattern in BLOCKED_PATTERNS_RE:
        if re.search(pattern, command, re.IGNORECASE):
            return f"ERROR: Comando bloqueado por seguridad: patrón peligroso detectado"

    cmd = ["bash", "-c", command]
    output = _run_cmd(cmd, PROJECT_ROOT, timeout=timeout)
    return f"# Comando: {command}\n\n{output}"


# ── Mapa de handlers ────────────────────────────────────────────────────────

HANDLERS = {
    "read_file": handle_read_file,
    "list_files": handle_list_files,
    "search_code": handle_search_code,
    "get_project_structure": handle_get_project_structure,
    "write_file": handle_write_file,
    "edit_file": handle_edit_file,
    "delete_file": handle_delete_file,
    "create_directory": handle_create_directory,
    "get_status": handle_get_status,
    "view_logs": handle_view_logs,
    "restart_process": handle_restart_process,
    "stop_process": handle_stop_process,
    "start_process": handle_start_process,
    "git_status": handle_git_status,
    "git_diff": handle_git_diff,
    "git_log": handle_git_log,
    "git_pull": handle_git_pull,
    "git_commit": handle_git_commit,
    "git_add": handle_git_add,
    "run_tests": handle_run_tests,
    "check_health": handle_check_health,
    "read_claude_md": handle_read_claude_md,
    "get_dependencies": handle_get_dependencies,
    "run_command": handle_run_command,
}


# ── Servidor MCP ─────────────────────────────────────────────────────────────

app = Server("aragon-project")


@app.list_tools()
async def list_tools() -> list[Tool]:
    """Devuelve todas las herramientas disponibles."""
    return list(TOOLS.values())


@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Ejecuta una herramienta por nombre."""
    handler = HANDLERS.get(name)
    if not handler:
        return [TextContent(
            type="text",
            text=f"ERROR: Herramienta '{name}' no encontrada. "
                 f"Disponibles: {list(HANDLERS.keys())}",
        )]

    try:
        result = await handler(arguments or {})
    except ValueError as e:
        result = f"ERROR de validación: {e}"
    except Exception as e:
        result = f"ERROR inesperado en {name}: {type(e).__name__}: {e}"

    return [TextContent(type="text", text=result)]


# ── Main ─────────────────────────────────────────────────────────────────────


async def main_stdio():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


async def main_sse(port: int):
    from mcp.server.sse import SseServerTransport
    from starlette.applications import Starlette
    from starlette.routing import Route
    import uvicorn

    sse = SseServerTransport("/messages")

    async def handle_sse(request):
        async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
            await app.run(streams[0], streams[1], app.create_initialization_options())

    starlette_app = Starlette(
        routes=[
            Route("/sse", endpoint=handle_sse),
            Route("/messages", endpoint=sse.handle_post_message, methods=["POST"]),
        ]
    )
    config = uvicorn.Config(starlette_app, host="0.0.0.0", port=port)
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MCP Project Server — Ecosistema Aragón")
    parser.add_argument("--root", required=True, help="Ruta raíz del proyecto")
    parser.add_argument("--pm2", default="", help="Nombre del proceso PM2")
    parser.add_argument("--name", default="", help="Nombre descriptivo del proyecto")
    parser.add_argument("--logs-dir", default="", help="Directorio de logs PM2 (para leer sin IPC)")
    parser.add_argument("--transport", choices=["stdio", "sse"], default="stdio")
    parser.add_argument("--port", type=int, default=8081)
    args = parser.parse_args()

    PROJECT_ROOT = Path(args.root).resolve()
    PM2_NAME = args.pm2
    PROJECT_NAME = args.name or PM2_NAME or PROJECT_ROOT.name
    PM2_LOGS_DIR = Path(args.logs_dir).resolve() if args.logs_dir else None

    if not PROJECT_ROOT.is_dir():
        print(f"ERROR: Directorio no encontrado: {args.root}", file=sys.stderr)
        sys.exit(1)

    app.name = f"aragon-project-{PROJECT_NAME}"

    print(f"[{app.name}] Root: {PROJECT_ROOT}", file=sys.stderr)
    print(f"[{app.name}] PM2: {PM2_NAME or '(ninguno)'}", file=sys.stderr)
    print(f"[{app.name}] {len(TOOLS)} herramientas disponibles", file=sys.stderr)
    print(f"[{app.name}] Transporte: {args.transport}", file=sys.stderr)

    if args.transport == "sse":
        asyncio.run(main_sse(args.port))
    else:
        asyncio.run(main_stdio())
