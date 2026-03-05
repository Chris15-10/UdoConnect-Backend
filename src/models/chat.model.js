// src/models/chat.model.js
import { db, pool } from '../db.js';
import { getAvailableAsesor } from '../utils/asesorAutoAssign.js';

// ─────────────────────────────────────────────────────────────────
// Helper interno: ejecuta y delega db a tx si está disponible.
// ─────────────────────────────────────────────────────────────────
export const executeQuery = async (queryText, params, clientTx) => {
    if (clientTx) {
        return clientTx.query(queryText, params);
    }
    return db.execute(queryText, params);
};

// ─────────────────────────────────────────────────────────────────
// Lógica transaccional para verificar y aplicar un pago mágico
// ─────────────────────────────────────────────────────────────────
export async function procesarPagoMagicoLocally(idCliente, datosTemporales, clientTx) {
    const referencia = datosTemporales.referencia || '';
    const { rows: pagoRows } = await executeQuery(
        "SELECT id_pago, monto_pagado FROM pagos WHERE numero_referencia = $1 AND usado = false LIMIT 1",
        [referencia], clientTx
    );

    if (!pagoRows.length) return { exito: false };

    const pago = pagoRows[0];

    let idPlanEncontrado = null;
    if (datosTemporales.plan_elegido) {
        const { rows: planRows } = await executeQuery(
            "SELECT id_plan FROM planes WHERE nombre = $1 OR nombre ILIKE $2 LIMIT 1",
            [datosTemporales.plan_elegido, `%${datosTemporales.plan_elegido.replace(/^\d+\.\s*/, '')}%`],
            clientTx
        );
        if (planRows.length) idPlanEncontrado = planRows[0].id_plan;
    }

    const { rows: factRows } = await executeQuery(
        "SELECT id_factura, monto FROM facturas WHERE id_cliente = $1 AND estado IN ('pendiente', 'vencida') ORDER BY fecha_vencimiento ASC",
        [idCliente], clientTx
    );

    if (factRows.length > 0) {
        const deudaTotal = factRows.reduce((a, b) => a + Number(b.monto), 0);
        if (Number(pago.monto_pagado) >= deudaTotal) {
            if (idPlanEncontrado) {
                await executeQuery(
                    "UPDATE facturas SET estado = 'pagada', id_plan = $3 WHERE id_cliente = $1 AND estado IN ('pendiente', 'vencida')",
                    [idCliente, null, idPlanEncontrado], clientTx
                );
            } else {
                await executeQuery(
                    "UPDATE facturas SET estado = 'pagada' WHERE id_cliente = $1 AND estado IN ('pendiente', 'vencida')",
                    [idCliente], clientTx
                );
            }
            await executeQuery(
                "UPDATE pagos SET usado = true, id_factura = $1 WHERE id_pago = $2",
                [factRows[0].id_factura, pago.id_pago], clientTx
            );
            return { exito: true, monto: pago.monto_pagado };
        }
    } else {
        const fechaVencimiento = new Date();
        fechaVencimiento.setDate(fechaVencimiento.getDate() + 30);
        const { rows: newFactRows } = await executeQuery(
            "INSERT INTO facturas (id_cliente, id_plan, descripcion, monto, estado, fecha_vencimiento) VALUES ($1, $2, 'Instalacion y Primer Mes', $3, 'pagada', $4) RETURNING id_factura",
            [idCliente, idPlanEncontrado, pago.monto_pagado, fechaVencimiento.toISOString().split('T')[0]],
            clientTx
        );
        await executeQuery(
            "UPDATE pagos SET usado = true, id_factura = $1 WHERE id_pago = $2",
            [newFactRows[0].id_factura, pago.id_pago], clientTx
        );
        return { exito: true, monto: pago.monto_pagado };
    }
    return { exito: false };
}

// ─────────────────────────────────────────────────────────────────
// Motor del bot para sesiones web.
// Procesa el mensaje del usuario y genera la respuesta del bot.
// ─────────────────────────────────────────────────────────────────
export async function procesarRespuestaBot(idSesion, idCliente, mensajeUsuario, clientTx = null) {
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
            const textoError = 'No entendi esa respuesta. Por favor, elige una opcion:\n\n' + opciones.map(o => '- ' + o.texto).join('\n');
            await executeQuery(
                "INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'bot', $2)",
                [idSesion, textoError], clientTx
            );
            return;
        }

        siguientePasoCodigo = opcionElegida.valor;
        if (ultimoPaso === 'generar_factura_nueva' || ultimoPaso === 'reportar_pago') {
            datosTemporales.metodo_pago = opcionElegida.texto;
        }

        if (['servicios_tv', 'servicios_internet', 'servicios_movil'].includes(ultimoPaso) && siguientePasoCodigo === 'pedir_datos') {
            datosTemporales.plan_elegido = opcionElegida.texto;
            const nombreLimpio = opcionElegida.texto.replace(/^\d+\.\s*/, '').trim();
            const { rows: planPrecioRows } = await executeQuery(
                `SELECT precio FROM planes WHERE nombre ILIKE $1 AND activo = true LIMIT 1`,
                [`%${nombreLimpio}%`],
                clientTx
            );
            datosTemporales.monto = planPrecioRows.length ? Number(planPrecioRows[0].precio) : 0;
        }
    }

    const { rows: npRows } = await executeQuery(
        "SELECT * FROM bot_pasos WHERE codigo_paso = $1",
        [siguientePasoCodigo], clientTx
    );
    if (!npRows.length) return;
    const nuevoPaso = npRows[0];

    let textoEnviar = nuevoPaso.mensaje_texto;
    let opcionesNuevoPaso = [];
    try {
        opcionesNuevoPaso = typeof nuevoPaso.opciones_botones === 'string'
            ? JSON.parse(nuevoPaso.opciones_botones)
            : (nuevoPaso.opciones_botones || []);
    } catch (e) { }

    // Inyección dinámica de precios desde la tabla planes
    const PASOS_PLANES = ['servicios_tv', 'servicios_internet', 'servicios_movil'];
    if (PASOS_PLANES.includes(siguientePasoCodigo) && textoEnviar) {
        try {
            const catMap = { servicios_tv: 'tv', servicios_internet: 'internet', servicios_movil: 'movil' };
            const categoria = catMap[siguientePasoCodigo];
            const { rows: planesDB } = await executeQuery(
                `SELECT nombre, precio FROM planes WHERE categoria = $1 AND activo = true ORDER BY precio ASC`,
                [categoria], clientTx
            );
            if (planesDB.length) {
                let lineCount = 0;
                textoEnviar = textoEnviar.replace(/\(\$[\d.,]+\/mes\)|\$[\d.,]+\/mes/g, () => {
                    const plan = planesDB[lineCount];
                    lineCount++;
                    return plan ? `($${Number(plan.precio).toFixed(2)}/mes)` : '$?.??/mes';
                });
            }
        } catch (e) {
            console.error('[bot] inyección precios:', e.message);
        }
    }

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
                    textoEnviar = `Excelente! Hemos verificado tu transferencia por $${verificacion.monto}.\n\nTu factura ha sido pagada y tu servicio esta procesado. ¡Gracias por preferir UdoConnect!`;
                    opcionesNuevoPaso = [{ texto: '1. Volver al inicio', valor: 'inicio' }, { texto: '2. Cerrar chat', valor: 'despedida' }];
                } else {
                    textoEnviar = `No encontramos un pago disponible con la referencia ${datosTemporales.referencia || ''}, o ya fue procesada. Por favor verifica el numero e intenta de nuevo.`;
                    siguientePasoCodigo = 'pedir_referencia';
                    opcionesNuevoPaso = [];
                }
                break;
            }
            case 'cerrar_sesion':
                await executeQuery(
                    "UPDATE sesiones SET estado = 'cerrada' WHERE id_sesion = $1",
                    [idSesion], clientTx
                );
                break;
            case 'transferir_agente':
                await executeQuery(
                    "UPDATE sesiones SET estado = 'derivada_humano' WHERE id_sesion = $1",
                    [idSesion], clientTx
                );
                textoEnviar = nuevoPaso.mensaje_texto + '\n\nUn asesor se conectara contigo en breve. Por favor espera...';
                opcionesNuevoPaso = [];
                break;
        }
    }

    if (opcionesNuevoPaso.length > 0) {
        textoEnviar += '\n\nResponde con una opcion:\n' + opcionesNuevoPaso.map(o => '- ' + o.texto).join('\n');
    }

    await executeQuery(
        "INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'bot', $2)",
        [idSesion, textoEnviar], clientTx
    );
    await executeQuery(
        "UPDATE sesiones SET ultimo_paso_bot = $1, datos_temporales = $2 WHERE id_sesion = $3",
        [siguientePasoCodigo, JSON.stringify(datosTemporales), idSesion], clientTx
    );
}

// ─────────────────────────────────────────────────────────────────
// Inserta el mensaje de bienvenida al crear una sesión web nueva
// ─────────────────────────────────────────────────────────────────
export async function enviarBienvenidaWeb(idSesion) {
    try {
        const { rows } = await db.execute(
            "SELECT mensaje_texto, opciones_botones FROM bot_pasos WHERE codigo_paso = 'inicio'"
        );
        if (!rows.length) return;

        const pasoInicio = rows[0];
        let texto = pasoInicio.mensaje_texto;
        let opciones = [];
        try {
            opciones = typeof pasoInicio.opciones_botones === 'string'
                ? JSON.parse(pasoInicio.opciones_botones)
                : (pasoInicio.opciones_botones || []);
        } catch (e) { }

        if (opciones.length > 0) {
            texto += '\n\nResponde con una opcion:\n' + opciones.map(o => '- ' + o.texto).join('\n');
        }

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

// ─────────────────────────────────────────────────────────────────
// CLIENTE — obtener o crear sesión web
// ─────────────────────────────────────────────────────────────────
export async function getOrCreateSessionDB(userId, nombre) {
    const extId = `web_${userId}`;

    const { rows: clientRows } = await db.execute(`
        INSERT INTO clientes (identificador_externo, nombre) 
        VALUES ($1, $2)
        ON CONFLICT (identificador_externo) DO UPDATE 
        SET nombre = EXCLUDED.nombre
        RETURNING id_cliente`,
        [extId, nombre]
    );
    const idCliente = clientRows[0].id_cliente;

    const existingRes = await db.execute(
        `SELECT id_sesion, estado FROM sesiones
         WHERE id_cliente = $1 AND estado != 'cerrada' AND canal = 'web'
         ORDER BY fecha_inicio DESC LIMIT 1`,
        [idCliente]
    );

    let session;
    if (existingRes.rows.length > 0) {
        session = { ...existingRes.rows[0], is_new: false };
    } else {
        const idAsesor = await getAvailableAsesor();
        const newRes = await db.execute(
            `INSERT INTO sesiones (id_cliente, canal, estado, flujo_actual, id_asesor)
             VALUES ($1, 'web', 'activa_bot', 'principal', $2)
             RETURNING id_sesion, estado`,
            [idCliente, idAsesor]
        );
        session = { ...newRes.rows[0], is_new: true };
    }

    return { session, idCliente };
}

// ─────────────────────────────────────────────────────────────────
// CLIENTE — guardar mensaje de usuario e invocar bot si corresponde
// ─────────────────────────────────────────────────────────────────
export async function sendMessageDB(sessionId, texto) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            "INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'usuario', $2)",
            [sessionId, texto]
        );
        const { rows: sesRows } = await client.query(
            'SELECT id_cliente, estado FROM sesiones WHERE id_sesion = $1 FOR UPDATE',
            [sessionId]
        );
        if (sesRows.length > 0 && sesRows[0].estado === 'activa_bot') {
            await procesarRespuestaBot(sessionId, sesRows[0].id_cliente, texto, client);
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// ─────────────────────────────────────────────────────────────────
// TODOS — obtener mensajes de una sesión
// ─────────────────────────────────────────────────────────────────
export async function getMessagesDB(sessionId) {
    const { rows } = await db.execute(
        `SELECT id_mensaje, remitente, contenido, fecha_creacion
         FROM mensajes
         WHERE id_sesion = $1
         ORDER BY fecha_creacion ASC`,
        [sessionId]
    );
    return rows;
}

// ─────────────────────────────────────────────────────────────────
// ASESOR — listar sesiones derivadas a humano
// ─────────────────────────────────────────────────────────────────
export async function getActiveSessionsDB() {
    const { rows } = await db.execute(`
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
    `, []);
    return rows;
}

// ─────────────────────────────────────────────────────────────────
// ASESOR — enviar mensaje a cliente
// ─────────────────────────────────────────────────────────────────
export async function sendAdvisorMessageDB(sessionId, content) {
    await db.execute(`
        WITH update_sess AS (
            UPDATE sesiones SET estado = 'derivada_humano' WHERE id_sesion = $1 AND estado != 'cerrada' RETURNING id_sesion
        )
        INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'agente', $2)
    `, [sessionId, content]);
}

// ─────────────────────────────────────────────────────────────────
// CLIENTE — comprobar si hay sesión activa
// ─────────────────────────────────────────────────────────────────
export async function checkActiveSessionDB(userId) {
    const extId = `web_${userId}`;
    const { rows } = await db.execute(`
        SELECT s.id_sesion 
        FROM sesiones s
        JOIN clientes c ON c.id_cliente = s.id_cliente
        WHERE c.identificador_externo = $1 AND s.estado != 'cerrada' AND s.canal = 'web' 
        LIMIT 1
    `, [extId]);
    return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────
// CLIENTE — iniciar flujo específico (cierra previas si existiesen)
// ─────────────────────────────────────────────────────────────────
export async function startFlowSessionDB(userId, nombre, flow) {
    const extId = `web_${userId}`;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: clientRows } = await client.query(`
            INSERT INTO clientes (identificador_externo, nombre) 
            VALUES ($1, $2)
            ON CONFLICT (identificador_externo) DO UPDATE 
            SET nombre = EXCLUDED.nombre
            RETURNING id_cliente`,
            [extId, nombre]
        );
        const id_cliente = clientRows[0].id_cliente;

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

        const idAsesorNuevo = await getAvailableAsesor(client);
        const { rows: nueva } = await client.query(`
            INSERT INTO sesiones (id_cliente, canal, estado, flujo_actual, ultimo_paso_bot, id_asesor) 
            VALUES ($1, 'web', 'activa_bot', 'principal', $2, $3)
            RETURNING id_sesion, estado
        `, [id_cliente, flow, idAsesorNuevo]);
        const nuevaSesion = nueva[0];

        const { rows: pasos } = await client.query(
            "SELECT * FROM bot_pasos WHERE codigo_paso = $1", [flow]
        );
        if (pasos.length > 0) {
            const pasoInicio = pasos[0];
            let texto = pasoInicio.mensaje_texto;
            let opciones = [];
            try { opciones = JSON.parse(pasoInicio.opciones_botones || '[]'); } catch (e) { }
            if (opciones.length > 0) {
                texto += '\n\nResponde con una opcion:\n' + opciones.map(o => '- ' + o.texto).join('\n');
            }
            await client.query(
                "INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'bot', $2)",
                [nuevaSesion.id_sesion, texto]
            );
        }

        await client.query('COMMIT');
        return { nuevaSesion, id_cliente };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// ─────────────────────────────────────────────────────────────────
// ASESOR — terminar sesión activa manualmente
// ─────────────────────────────────────────────────────────────────
export async function endSessionByAdvisorDB(sessionId) {
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
}

// ─────────────────────────────────────────────────────────────────
// ASESOR — obtener historial de clientes
// ─────────────────────────────────────────────────────────────────
export async function getHistoryClientsDB() {
    const { rows } = await db.execute(`
        SELECT c.id_cliente, c.nombre, c.identificador_externo, MAX(s.fecha_inicio) as ultima_sesion
        FROM clientes c
        JOIN sesiones s ON s.id_cliente = c.id_cliente
        WHERE s.canal = 'web'
        GROUP BY c.id_cliente
        ORDER BY ultima_sesion DESC
    `);
    return rows;
}

// ─────────────────────────────────────────────────────────────────
// ASESOR — obtener mensajes de un cliente (todas sus sesiones)
// ─────────────────────────────────────────────────────────────────
export async function getClientMessagesDB(clientId) {
    const { rows } = await db.execute(`
        SELECT m.id_mensaje, m.remitente, m.contenido, m.fecha_creacion, s.id_sesion
        FROM mensajes m
        JOIN sesiones s ON s.id_sesion = m.id_sesion
        WHERE s.id_cliente = $1
        ORDER BY m.fecha_creacion ASC
    `, [clientId]);
    return rows;
}

// ─────────────────────────────────────────────────────────────────
// ASESOR — perfil completo del cliente de una sesión
// ─────────────────────────────────────────────────────────────────
export async function getClientProfileDB(sessionId) {
    const { rows } = await db.execute(`
        SELECT
            u.id          AS id_usuario,
            u.nombre,
            u.username,
            u.email,
            u.cedula,
            u.telefono,
            c.identificador_externo,
            c.id_cliente,
            s.canal,
            s.estado
        FROM sesiones s
        JOIN clientes c ON c.id_cliente = s.id_cliente
        LEFT JOIN usuarios u
               ON u.id::text = REPLACE(c.identificador_externo, 'web_', '')
        WHERE s.id_sesion = $1
        LIMIT 1
    `, [sessionId]);
    return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────
// ASESOR — perfil por id_cliente (para historial de Bots)
// ─────────────────────────────────────────────────────────────────
export async function getClientProfileByClientIdDB(clientId) {
    const { rows } = await db.execute(`
        SELECT
            u.id          AS id_usuario,
            u.nombre,
            u.username,
            u.email,
            u.cedula,
            u.telefono,
            c.identificador_externo,
            c.id_cliente
        FROM clientes c
        LEFT JOIN usuarios u
               ON u.id::text = REPLACE(c.identificador_externo, 'web_', '')
        WHERE c.id_cliente = $1
        LIMIT 1
    `, [clientId]);
    return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────
// HELPER COMPARTIDO — Resolver el plan activo de un cliente
// Precedencia: 1) factura.id_plan → 2) datos_temporales.plan_elegido → 3) precio coincidente
// ─────────────────────────────────────────────────────────────────
export async function resolveClientPlan(idCliente) {
    try {
        const { rows } = await db.execute(`
            SELECT
                pf.nombre      AS plan_nombre,
                pf.categoria   AS plan_categoria,
                pf.precio      AS plan_precio,
                (
                    SELECT ses.datos_temporales::jsonb->>'plan_elegido'
                    FROM sesiones ses
                    WHERE ses.id_cliente = $1
                      AND ses.datos_temporales IS NOT NULL
                      AND ses.datos_temporales != '{}'
                      AND ses.datos_temporales::jsonb->>'plan_elegido' IS NOT NULL
                    ORDER BY ses.fecha_inicio DESC
                    LIMIT 1
                ) AS plan_elegido_bot,
                plan_monto.p_nombre    AS plan_monto_nombre,
                plan_monto.p_categoria AS plan_monto_categoria,
                plan_monto.p_precio    AS plan_monto_precio
            FROM (SELECT $1::int AS c_id) dummy
            LEFT JOIN LATERAL (
                SELECT f.id_plan, f.monto AS factura_monto
                FROM facturas f
                WHERE f.id_cliente = $1
                ORDER BY f.fecha_emision DESC
                LIMIT 1
            ) ultima_f ON true
            LEFT JOIN planes pf ON pf.id_plan = ultima_f.id_plan
            LEFT JOIN LATERAL (
                SELECT p.nombre AS p_nombre, p.categoria AS p_categoria, p.precio AS p_precio
                FROM planes p
                WHERE ultima_f.factura_monto IS NOT NULL
                  AND ultima_f.id_plan IS NULL
                  AND p.precio::numeric = ultima_f.factura_monto::numeric
                LIMIT 1
            ) plan_monto ON true
            LIMIT 1
        `, [idCliente]);

        if (!rows.length) return null;
        const r = rows[0];

        if (r.plan_nombre) {
            return { nombre: r.plan_nombre, categoria: r.plan_categoria, precio: Number(r.plan_precio) };
        }
        if (r.plan_elegido_bot) {
            return { nombre: r.plan_elegido_bot, categoria: null, precio: null };
        }
        if (r.plan_monto_nombre) {
            return { nombre: r.plan_monto_nombre, categoria: r.plan_monto_categoria, precio: Number(r.plan_monto_precio) };
        }
        return null;
    } catch (e) {
        console.error('[resolveClientPlan]', e.message);
        return null;
    }
}
