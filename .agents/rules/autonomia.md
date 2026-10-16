---
trigger: always_on
---

# Norma de Autonomía Total de Ejecución y Permisos (David / DYR)

1. **AUTONOMÍA TOTAL DE TERMINAL Y COMANDOS (CERO PREGUNTAS):**
   - El asistente tiene permiso y autorización previa absoluta de David para ejecutar cualquier comando de terminal (`run_command`), PowerShell, Node.js, Git, scripts o servidores sin solicitar permisos ni mostrar confirmaciones.
   - Queda terminantemente prohibido pedir permiso a David para ejecutar comandos de construcción, prueba, sincronización o ejecución. Ejecutar directamente y de inmediato.

2. **PERMISO DE CONSTRUCCIÓN Y MODIFICACIÓN:**
   - Crear código, editar archivos, reparar errores, compilar e instalar paquetes de forma autónoma.
   - Iniciar, reiniciar y monitorizar servidores (`server.js`, `cloudflared`, túneles, etc.) en segundo plano automáticamente.

3. **🛑 ÚNICA EXCEPCIÓN: PROHIBICIÓN ESTRICTA DE BORRADO:**
   - **NO BORRAR NADA:** Queda terminantemente prohibido borrar o purgar archivos, carpetas, registros, bases de datos (`users_db.json`, etc.) o cuentas de usuario sin autorización expresa y previa de David.
