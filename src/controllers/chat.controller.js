// src/controllers/chat.controller.js
import { db, pool } from '../db.js';

// ─────────────────────────────────────────────────────────────────
// Helper interno: ejecuta y delega db a tx si está disponible.
// Optimización general 5: Capacidad de utilizar DB transactions
// ─────────────────────────────────────────────────────────────────
const executeQuery = async (queryText, params, clientTx) => {
    if (clientTx) {
        return clientTx.query(queryText, params);
    }
    return db.execute(queryText, params);
};

// Logica local transaccional para pago magico
async function procesarPagoMagicoLocally(idCliente, datosTemporales, clientTx) {
    const referencia = datosTemporales.referencia || '';
    const { rows: pagoRows } = await executeQuery("SELECT id_pago, monto_pagado FROM pagos WHERE numero_referencia = $1 AND usado = false LIMIT 1",
        [referencia], clientTx);

    if (!pagoRows.length) return { exito: false };

    const pago = pagoRows[0];
    const { rows: factRows } = await executeQuery("SELECT id_factura, monto FROM facturas WHERE id_cliente = $1 AND estado IN ('pendiente', 'vencida') ORDER BY fecha_vencimiento ASC", [idCliente], clientTx);

    if (factRows.length > 0) {
        const deudaTotal = factRows.reduce((a, b) => a + Number(b.monto), 0);
        if (Number(pago.monto_pagado) >= deudaTotal) {
            await executeQuery("UPDATE facturas SET estado = 'pagada' WHERE id_cliente = $1 AND estado IN ('pendiente', 'vencida')", [idCliente], clientTx);
            await executeQuery("UPDATE pagos SET usado = true, id_factura = $1 WHERE id_pago = $2", [factRows[0].id_factura, pago.id_pago], clientTx);
            return { exito: true, monto: pago.monto_pagado };
        }
    } else {
        const fechaVencimiento = new Date();
        fechaVencimiento.setDate(fechaVencimiento.getDate() + 30);
        const { rows: newFactRows } = await executeQuery(
            "INSERT INTO facturas (id_cliente, descripcion, monto, estado, fecha_vencimiento) VALUES ($1, 'Instalacion y Primer Mes', $2, 'pagada', $3) RETURNING id_factura",
            [idCliente, pago.monto_pagado, fechaVencimiento.toISOString().split('T')[0]], clientTx
        );
        await executeQuery("UPDATE pagos SET usado = true, id_factura = $1 WHERE id_pago = $2", [newFactRows[0].id_factura, pago.id_pago], clientTx);
        return { exito: true, monto: pago.monto_pagado };
    }
    return { exito: false };
}

// ─────────────────────────────────────────────────────────────────
// Helper interno: ejecuta la lógica del bot para sesiones web.
// Optimización 5: Refactorizado para aceptar y propagar transacciones 
// ─────────────────────────────────────────────────────────────────
async function procesarRespuestaBot(idSesion, idCliente, mensajeUsuario, clientTx = null) {
    const { rows: sesRows } = await executeQuery(
        'SELECT ultimo_paso_bot, datos_temporales, estado FROM sesiones WHERE id_sesion = $1',
        [idSesion], clientTx
    );
    if (!sesRows.length) return;
    const sesion = sesRows[0];

    if (sesion.estado === 'derivada_humano' || sesion.estado === 'cerrada') return;

    const ultimoPaso = sesion.ultimo_paso_bot || 'inicio';
    let datosTemporales = typeof sesion.datos_temporales === 'string'
        ? JSON.parse(sesion.datos_temporales)
        : (sesion.datos_temporales || {});

    const { rows: pasoRows } = await executeQuery(
        'SELECT opciones_botones, es_pregunta, siguiente_paso_default FROM bot_pasos WHERE codigo_paso = $1',
        [ultimoPaso], clientTx
    );
    if (!pasoRows.length) return;
    const paso = pasoRows[0];

    let opciones = [];
    try {
        opciones = typeof paso.opciones_botones === 'string'
            ? JSON.parse(paso.opciones_botones)
            : (paso.opciones_botones || []);
    } catch (e) { }

    let siguientePasoCodigo = paso.siguiente_paso_default;

    if (paso.es_pregunta) {
        datosTemporales.ultimo_mensaje_abierto = mensajeUsuario;
        if (ultimoPaso === 'pedir_referencia') datosTemporales.referencia = mensajeUsuario;
        if (ultimoPaso === 'pedir_banco') datosTemporales.banco = mensajeUsuario;
        if (ultimoPaso === 'pedir_datos') datosTemporales.nombre_nuevo = mensajeUsuario;
        if (ultimoPaso === 'pedir_cedula_venta') datosTemporales.cedula = mensajeUsuario;
    } else {
        const opcionElegida = opciones.find((op) => {
            if (op.regex) return new RegExp(op.regex, 'i').test(mensajeUsuario);
            return op.texto.toLowerCase() === mensajeUsuario.toLowerCase();
        });

        if (!opcionElegida) {
            let textoError = 'No entendi esa respuesta. Por favor, elige una opcion:\n\n' + opciones.map(o => '- ' + o.texto).join('\n');
            await executeQuery("INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'bot', $2)", [idSesion, textoError], clientTx);
            return;
        }

        siguientePasoCodigo = opcionElegida.valor;
        if (ultimoPaso === 'generar_factura_nueva' || ultimoPaso === 'reportar_pago') {
            datosTemporales.metodo_pago = opcionElegida.texto;
        }
    }

    const { rows: npRows } = await executeQuery("SELECT * FROM bot_pasos WHERE codigo_paso = $1", [siguientePasoCodigo], clientTx);
    if (!npRows.length) return;
    const nuevoPaso = npRows[0];

    let textoEnviar = nuevoPaso.mensaje_texto;
    let opcionesNuevoPaso = [];
    try { opcionesNuevoPaso = typeof nuevoPaso.opciones_botones === 'string' ? JSON.parse(nuevoPaso.opciones_botones) : (nuevoPaso.opciones_botones || []); } catch (e) { }

    if (nuevoPaso.accion_sistema) {
        switch (nuevoPaso.accion_sistema) {
            case 'crear_ticket':
                await executeQuery(
                    "INSERT INTO tickets (id_cliente, descripcion, prioridad) VALUES ($1, $2, 'alta')",
                    [idCliente, `Reporte automatico en paso: ${siguientePasoCodigo}. Mensaje: ${mensajeUsuario}`],
                    clientTx
                );
                break;
            case 'consultar_deuda': {
                const { rows: factRows } = await executeQuery(
                    "SELECT monto, descripcion FROM facturas WHERE id_cliente = $1 AND estado IN ('pendiente', 'vencida') ORDER BY fecha_vencimiento ASC",
                    [idCliente], clientTx
                );
                if (factRows.length === 0) {
                    textoEnviar = 'Estas al dia! No tienes ninguna factura pendiente.\n\nEscribe Volver para ir al menu principal.';
                    opcionesNuevoPaso = [];
                } else {
                    const deudaTotal = factRows.reduce((a, b) => a + Number(b.monto), 0);
                    const detalle = factRows.map(f => `- ${f.descripcion} -> $${f.monto}`).join('\n');
                    textoEnviar = `ESTADO DE CUENTA\n\nActualmente tienes ${factRows.length} factura(s) pendiente(s):\n\n${detalle}\n\nSUB-TOTAL A PAGAR: $${deudaTotal}\n\n¿Deseas reportar un pago para cancelar este saldo?`;
                }
                break;
            }
            case 'verificar_pago_magico': {
                const verificacion = await procesarPagoMagicoLocally(idCliente, datosTemporales, clientTx);
                if (verificacion.exito) {
                    textoEnviar = `Excelente! Hemos verificado tu transferencia por $${verificacion.monto}.\n\nTu factura ha sido pagada y tu servicio esta procesado. ¡Gracias por preferir Calibra-Net!`;
                    opcionesNuevoPaso = [{ texto: '1. Volver al inicio', valor: 'inicio' }, { texto: '2. Cerrar chat', valor: 'despedida' }];
                } else {
                    textoEnviar = `No encontramos un pago disponible con la referencia ${datosTemporales.referencia || ''}, o ya fue procesada. Por favor verifica el numero e intenta de nuevo.`;
                    siguientePasoCodigo = 'pedir_referencia';
                    opcionesNuevoPaso = [];
                }
                break;
            }
            case 'cerrar_sesion':
                await executeQuery("UPDATE sesiones SET estado = 'cerrada' WHERE id_sesion = $1", [idSesion], clientTx);
                break;
            case 'transferir_agente':
                await executeQuery("UPDATE sesiones SET estado = 'derivada_humano' WHERE id_sesion = $1", [idSesion], clientTx);
                textoEnviar = nuevoPaso.mensaje_texto + '\n\nUn asesor se conectara contigo en breve. Por favor espera...';
                opcionesNuevoPaso = [];
                break;
        }
    }

    if (opcionesNuevoPaso.length > 0) {
        textoEnviar += '\n\nResponde con una opcion:\n' + opcionesNuevoPaso.map(o => '- ' + o.texto).join('\n');
    }

    await executeQuery("INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'bot', $2)", [idSesion, textoEnviar], clientTx);
    await executeQuery("UPDATE sesiones SET ultimo_paso_bot = $1, datos_temporales = $2 WHERE id_sesion = $3", [siguientePasoCodigo, JSON.stringify(datosTemporales), idSesion], clientTx);
}

async function enviarBienvenidaWeb(idSesion) {
    try {
        const { rows } = await db.execute("SELECT mensaje_texto, opciones_botones FROM bot_pasos WHERE codigo_paso = 'inicio'");
        if (!rows.length) return;

        const pasoInicio = rows[0];
        let texto = pasoInicio.mensaje_texto;
        let opciones = [];
        try { opciones = typeof pasoInicio.opciones_botones === 'string' ? JSON.parse(pasoInicio.opciones_botones) : (pasoInicio.opciones_botones || []); } catch (e) { }

        if (opciones.length > 0) texto += '\n\nResponde con una opcion:\n' + opciones.map(o => '- ' + o.texto).join('\n');

        // Optimización: Uso de CTE con transacciones integradas para unificarlas internamente a nivel de motor DB.
        await db.execute(`
            WITH welcome_msg AS (
                INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'bot', $2)
            )
            UPDATE sesiones SET ultimo_paso_bot = 'inicio' WHERE id_sesion = $1;
        `, [idSesion, texto]);
    } catch (e) {
        console.error('[chat] enviarBienvenidaWeb:', e);
    }
}

// ─────────────────────────────────────────────
// CLIENTE — obtener o crear sesión web
// Optimización 1: ON CONFLICT para insert seguro.
// Optimización 2: Uso de CTE (WITH) para obtener o crear sesión.
// ─────────────────────────────────────────────
export const getOrCreateSession = async (req, res) => {
    try {
        const userId = req.user.id;
        const extId = `web_${userId}`;
        const nombre = req.user.nombre;

        // 1. Obtener/Insertar de un solo paso evitando race conditions
        const { rows: clientRows } = await db.execute(`
            INSERT INTO clientes (identificador_externo, nombre) 
            VALUES ($1, $2)
            ON CONFLICT (identificador_externo) DO UPDATE 
            SET nombre = EXCLUDED.nombre
            RETURNING id_cliente`,
            [extId, nombre]
        );
        const idCliente = clientRows[0].id_cliente;

        // 2. CTE para devolver id_sesion existente o crear una en un solo trip de DB
        const query = `
            WITH existing_session AS (
                SELECT id_sesion, estado FROM sesiones
                WHERE id_cliente = $1 AND estado != 'cerrada' AND canal = 'web'
                ORDER BY fecha_inicio DESC LIMIT 1
            ),
            new_session AS (
                INSERT INTO sesiones (id_cliente, canal, estado, flujo_actual)
                SELECT $1, 'web', 'activa_bot', 'principal'
                WHERE NOT EXISTS (SELECT 1 FROM existing_session)
                RETURNING id_sesion, estado
            )
            SELECT id_sesion, estado, false as is_new FROM existing_session
            UNION ALL
            SELECT id_sesion, estado, true as is_new FROM new_session
        `;

        const { rows: resRows } = await db.execute(query, [idCliente]);
        const session = resRows[0];

        if (session.is_new) {
            await enviarBienvenidaWeb(session.id_sesion);
        }

        return res.json({ sessionId: session.id_sesion, estado: session.estado, clienteId: idCliente });
    } catch (error) {
        console.error('[chat] getOrCreateSession:', error);
        res.status(500).json({ message: 'Error al obtener la sesión.' });
    }
};

// ─────────────────────────────────────────────
// CLIENTE — enviar mensaje
// Optimización 5: Refactorizado con ACID local para proteger la operación multi-tabla
// ─────────────────────────────────────────────
export const sendMessage = async (req, res) => {
    const client = await pool.connect();
    try {
        const { sessionId, content } = req.body;
        if (!sessionId || !content?.trim()) {
            return res.status(400).json({ message: 'sessionId y content son requeridos.' });
        }
        const texto = content.trim();

        await client.query('BEGIN');

        await client.query("INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'usuario', $2)", [sessionId, texto]);

        // Aseguramos for update lock ya que se evalua despues
        const { rows: sesRows } = await client.query('SELECT id_cliente, estado FROM sesiones WHERE id_sesion = $1 FOR UPDATE', [sessionId]);

        if (sesRows.length > 0 && sesRows[0].estado === 'activa_bot') {
            await procesarRespuestaBot(sessionId, sesRows[0].id_cliente, texto, client);
        }

        await client.query('COMMIT');
        return res.status(201).json({ ok: true });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[chat] sendMessage:', error);
        res.status(500).json({ message: 'Error al enviar el mensaje.' });
    } finally {
        client.release();
    }
};

// ─────────────────────────────────────────────
// TODOS — obtener mensajes de una sesión
// ─────────────────────────────────────────────
export const getMessages = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { rows } = await db.execute(
            `SELECT id_mensaje, remitente, contenido, fecha_creacion
             FROM mensajes
             WHERE id_sesion = $1
             ORDER BY fecha_creacion ASC`,
            [sessionId]
        );
        return res.json({ messages: rows });
    } catch (error) {
        console.error('[chat] getMessages:', error);
        res.status(500).json({ message: 'Error al obtener mensajes.' });
    }
};

// ─────────────────────────────────────────────
// ASESOR — listar sesiones escaladas
// Optimización 3: Subconsultas en el SELECT eliminadas usando DISTINCT ON con JOIN.
// ─────────────────────────────────────────────
export const getActiveSessions = async (req, res) => {
    try {
        const query = `
            SELECT * FROM (
                SELECT DISTINCT ON (s.id_sesion)
                    s.id_sesion, s.estado, s.canal, s.fecha_inicio,
                    c.nombre AS nombre_cliente, c.identificador_externo,
                    m.contenido AS ultimo_mensaje,
                    m.fecha_creacion AS ultima_actividad
                FROM sesiones s
                JOIN clientes c ON c.id_cliente = s.id_cliente
                LEFT JOIN mensajes m ON m.id_sesion = s.id_sesion
                WHERE s.estado = 'derivada_humano'
                ORDER BY s.id_sesion, m.fecha_creacion DESC
            ) t
            ORDER BY t.ultima_actividad DESC NULLS LAST
        `;
        const { rows } = await db.execute(query, []);
        return res.json({ sessions: rows });
    } catch (error) {
        console.error('[chat] getActiveSessions:', error);
        res.status(500).json({ message: 'Error al obtener sesiones.' });
    }
};

// ─────────────────────────────────────────────
// ASESOR — enviar mensaje a cliente
// Optimización 2: Un solo CTE para combinar Update e Insert
// ─────────────────────────────────────────────
export const sendAdvisorMessage = async (req, res) => {
    try {
        const { sessionId, content } = req.body;
        if (!sessionId || !content?.trim()) {
            return res.status(400).json({ message: 'sessionId y content son requeridos.' });
        }

        await db.execute(`
            WITH update_sess AS (
                UPDATE sesiones SET estado = 'derivada_humano' WHERE id_sesion = $1 AND estado != 'cerrada' RETURNING id_sesion
            )
            INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'agente', $2)
        `, [sessionId, content.trim()]);

        return res.status(201).json({ ok: true });
    } catch (error) {
        console.error('[chat] sendAdvisorMessage:', error);
        res.status(500).json({ message: 'Error al enviar el mensaje.' });
    }
};

// ─────────────────────────────────────────────
// CLIENTE — comprobar si hay sesión activa
// Optimización 4: Única consulta secuencial con un JOIN en vez de 2 querys
// ─────────────────────────────────────────────
export const checkActiveSession = async (req, res) => {
    try {
        const userId = req.user.id;
        const extId = `web_${userId}`;

        const { rows: sesionRows } = await db.execute(`
            SELECT s.id_sesion 
            FROM sesiones s
            JOIN clientes c ON c.id_cliente = s.id_cliente
            WHERE c.identificador_externo = $1 AND s.estado != 'cerrada' AND s.canal = 'web' 
            LIMIT 1
        `, [extId]);

        return res.json({ hasActive: sesionRows.length > 0 });
    } catch (error) {
        console.error('[chat] checkActiveSession:', error);
        res.status(500).json({ message: 'Error al comprobar sesión.' });
    }
};

// ─────────────────────────────────────────────
// CLIENTE — iniciar flujo específico (cierra previas si existiesen)
// Optimización 1 y 2: Un solo query INSERT ON CONFLICT, cero bucles locales y manejo de transacciones.
// ─────────────────────────────────────────────
export const startFlowSession = async (req, res) => {
    const client = await pool.connect();
    try {
        const userId = req.user.id;
        const extId = `web_${userId}`;
        const { flow } = req.body;

        if (!flow) return res.status(400).json({ message: 'Se requiere el código del flujo.' });

        await client.query('BEGIN');

        // Optimización 1
        const { rows: clientRows } = await client.query(`
            INSERT INTO clientes (identificador_externo, nombre) 
            VALUES ($1, $2)
            ON CONFLICT (identificador_externo) DO UPDATE 
            SET nombre = EXCLUDED.nombre
            RETURNING id_cliente`,
            [extId, req.user.nombre]
        );
        const id_cliente = clientRows[0].id_cliente;

        // Optimización 2 (Reemplaza for loop usando CTE)
        await client.query(`
            WITH updated_sessions AS (
                UPDATE sesiones 
                SET estado = 'cerrada', ultimo_paso_bot = 'despedida' 
                WHERE id_cliente = $1 AND estado != 'cerrada' AND canal = 'web'
                RETURNING id_sesion
            )
            INSERT INTO mensajes (id_sesion, remitente, contenido)
            SELECT id_sesion, 'bot', 'Has iniciado un nuevo proceso. Esta sesión ha sido finalizada.'
            FROM updated_sessions
        `, [id_cliente]);

        // Crear nueva sesión con el flujo indicado
        const { rows: nueva } = await client.query(`
            INSERT INTO sesiones (id_cliente, canal, estado, flujo_actual, ultimo_paso_bot) 
            VALUES ($1, 'web', 'activa_bot', 'principal', $2)
            RETURNING id_sesion, estado
        `, [id_cliente, flow]);
        const nuevaSesion = nueva[0];

        // Obtener mensaje del bot
        const { rows: pasos } = await client.query("SELECT * FROM bot_pasos WHERE codigo_paso = $1", [flow]);
        if (pasos.length > 0) {
            const pasoInicio = pasos[0];
            let texto = pasoInicio.mensaje_texto;
            let opciones = [];
            try { opciones = JSON.parse(pasoInicio.opciones_botones || '[]'); } catch (e) { }
            if (opciones.length > 0) texto += '\n\nResponde con una opcion:\n' + opciones.map(o => '- ' + o.texto).join('\n');
            await client.query("INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'bot', $2)", [nuevaSesion.id_sesion, texto]);
        }

        await client.query('COMMIT');
        return res.json({ sessionId: nuevaSesion.id_sesion, estado: nuevaSesion.estado, clienteId: id_cliente });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[chat] startFlowSession:', error);
        res.status(500).json({ message: 'Error al iniciar el flujo.' });
    } finally {
        client.release();
    }
};

// ─────────────────────────────────────────────
// ASESOR — terminar sesión activa manualmente
// Optimización 2: Un CTE para cerrar y emitir un mensaje localmente.
// ─────────────────────────────────────────────
export const endSessionByAdvisor = async (req, res) => {
    try {
        const { sessionId } = req.params;

        await db.execute(`
            WITH updated_session AS (
                UPDATE sesiones SET estado = 'cerrada', ultimo_paso_bot = 'despedida' 
                WHERE id_sesion = $1 
                RETURNING id_sesion
            )
            INSERT INTO mensajes (id_sesion, remitente, contenido) 
            SELECT id_sesion, 'bot', 'El asesor ha marcado tu consulta como resuelta. ¡Gracias por contactarnos!' 
            FROM updated_session
        `, [sessionId]);

        return res.json({ ok: true });
    } catch (error) {
        console.error('[chat] endSessionByAdvisor:', error);
        res.status(500).json({ message: 'Error al terminar la sesión.' });
    }
};

// ─────────────────────────────────────────────
// ASESOR — obtener historial de clientes
// ─────────────────────────────────────────────
export const getHistoryClients = async (req, res) => {
    try {
        const query = `
            SELECT c.id_cliente, c.nombre, c.identificador_externo, MAX(s.fecha_inicio) as ultima_sesion
            FROM clientes c
            JOIN sesiones s ON s.id_cliente = c.id_cliente
            WHERE s.canal = 'web'
            GROUP BY c.id_cliente
            ORDER BY ultima_sesion DESC
        `;
        const { rows } = await db.execute(query);
        return res.json({ clients: rows });
    } catch (error) {
        console.error('[chat] getHistoryClients:', error);
        res.status(500).json({ message: 'Error al obtener el historial de clientes.' });
    }
};

// ─────────────────────────────────────────────
// ASESOR — obtener mensajes de un cliente (todas sus sesiones)
// ─────────────────────────────────────────────
export const getClientMessages = async (req, res) => {
    try {
        const { clientId } = req.params;
        const query = `
            SELECT m.id_mensaje, m.remitente, m.contenido, m.fecha_creacion, s.id_sesion
            FROM mensajes m
            JOIN sesiones s ON s.id_sesion = m.id_sesion
            WHERE s.id_cliente = $1
            ORDER BY m.fecha_creacion ASC
        `;
        const { rows } = await db.execute(query, [clientId]);
        return res.json({ messages: rows });
    } catch (error) {
        console.error('[chat] getClientMessages:', error);
        res.status(500).json({ message: 'Error al obtener mensajes del cliente.' });
    }
};
