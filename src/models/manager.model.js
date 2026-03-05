// src/models/manager.model.js
import { db } from '../db.js';
import { resolveClientPlan } from './chat.model.js';
import bcrypt from 'bcryptjs';

// ─────────────────────────────────────────────
// DASHBOARD — todas las métricas del panel
// ─────────────────────────────────────────────
export async function getDashboardDB() {
    // 1. Empleados (asesores y admins)
    const { rows: empleados } = await db.execute(`
        SELECT id, nombre, username, email, rol, activo, telefono
        FROM usuarios
        WHERE rol IN ('asesor', 'admin')
        ORDER BY rol, nombre
    `);

    // 2. Clientes con deudas acumuladas
    const { rows: clientesDeudas } = await db.execute(`
        SELECT 
            c.id_cliente, 
            c.identificador_externo, 
            c.nombre AS nombre_cliente,
            u.cedula AS cedula,
            COALESCE(SUM(f.monto), 0) AS total_deuda,
            COUNT(f.id_factura) AS cantidad_facturas_pendientes
        FROM clientes c
        LEFT JOIN usuarios u
          ON u.id::text = REPLACE(c.identificador_externo, 'web_', '')
        LEFT JOIN facturas f ON c.id_cliente = f.id_cliente AND f.estado IN ('pendiente', 'vencida')
        GROUP BY c.id_cliente, c.identificador_externo, c.nombre, u.cedula
        ORDER BY total_deuda DESC
    `);

    // 3. Finanzas globales
    const { rows: facturas } = await db.execute(`
        SELECT monto, estado 
        FROM facturas 
        WHERE estado IN ('pagada', 'pendiente', 'vencida')
    `);

    let facturasCobradaTotal = 0;
    let facturasPendientesTotal = 0;
    facturas.forEach(f => {
        const monto = Number(f.monto);
        if (f.estado === 'pagada') facturasCobradaTotal += monto;
        if (f.estado === 'pendiente' || f.estado === 'vencida') facturasPendientesTotal += monto;
    });

    // 4. Planes base y cantidad de contratos por plan
    const { rows: planesBase } = await db.execute(`
        SELECT id_plan, nombre, categoria, precio, activo
        FROM planes
        ORDER BY categoria, precio
    `);

    const { rows: contratosPlanes } = await db.execute(`
        SELECT id_plan, COUNT(*) AS cantidad
        FROM facturas
        WHERE id_plan IS NOT NULL
          AND estado IN ('pagada', 'pendiente', 'vencida')
        GROUP BY id_plan
    `);
    const contratosMap = Object.fromEntries(
        contratosPlanes.map(p => [String(p.id_plan), Number(p.cantidad)])
    );

    const planesMasContratados = planesBase
        .map(p => ({
            id_plan: p.id_plan,
            nombre: p.nombre,
            categoria: p.categoria,
            precio: Number(p.precio),
            activo: p.activo,
            cantidad: contratosMap[String(p.id_plan)] || 0,
        }))
        .sort((a, b) => b.cantidad - a.cantidad);

    // 5. Clientes registrados con vínculo a usuario web
    const { rows: clientesRegistrados } = await db.execute(`
        SELECT
            c.id_cliente,
            c.nombre              AS nombre_cliente,
            c.identificador_externo,
            u.id                  AS id_usuario,
            u.username,
            u.email,
            u.cedula,
            u.telefono,
            u.rol
        FROM clientes c
        LEFT JOIN usuarios u
          ON u.id::text = REPLACE(c.identificador_externo, 'web_', '')
        ORDER BY c.id_cliente
    `);

    // 6. Nuevas contrataciones (últimos 30 días)
    const { rows: nuevasContrataciones } = await db.execute(`
        SELECT
            DATE(fecha_emision)::text AS dia,
            COUNT(*) AS nuevas_contrataciones
        FROM facturas
        WHERE fecha_emision >= NOW() - INTERVAL '30 days'
          AND id_plan IS NOT NULL
        GROUP BY dia
        ORDER BY dia DESC
    `);

    return {
        financiero: { totalRecaudado: facturasCobradaTotal, totalPorCobrar: facturasPendientesTotal },
        planesMasContratados,
        planesBase,
        empleados,
        clientesDeudas,
        clientesRegistrados,
        nuevasContrataciones,
    };
}

// ─────────────────────────────────────────────
// PLANES — consultas
// ─────────────────────────────────────────────
export async function getPlanesDB() {
    const { rows } = await db.execute(`
        SELECT id_plan, nombre, categoria, precio, activo
        FROM planes
        ORDER BY categoria, precio
    `);
    return rows;
}

export async function updatePlanDB(idPlan, { precio, activo, nombre, categoria }) {
    const { rows } = await db.execute(`
        UPDATE planes
        SET precio    = COALESCE($1, precio),
            activo    = COALESCE($2, activo),
            nombre    = COALESCE($3, nombre),
            categoria = COALESCE($4, categoria)
        WHERE id_plan = $5
        RETURNING id_plan, nombre, categoria, precio, activo
    `, [
        precio != null ? Number(precio) : null,
        activo != null ? activo : null,
        nombre || null,
        categoria || null,
        idPlan
    ]);
    return rows[0] || null;
}

export async function createPlanDB({ nombre, categoria, precio, activo }) {
    const { rows } = await db.execute(
        `INSERT INTO planes (nombre, categoria, precio, activo) VALUES ($1, $2, $3, $4) RETURNING *`,
        [nombre, categoria || 'internet', Number(precio), activo ?? true]
    );
    return rows[0];
}

// ─────────────────────────────────────────────
// CLIENTE — perfil completo por id_cliente
// ─────────────────────────────────────────────
export async function getClientProfileByIdDB(idCliente) {
    const { rows } = await db.execute(`
        SELECT
            c.id_cliente,
            c.nombre              AS nombre_cliente,
            c.identificador_externo,
            u.id                  AS id_usuario,
            u.nombre,
            u.username,
            u.email,
            u.cedula,
            u.telefono,
            u.rol,
            CASE WHEN c.identificador_externo LIKE 'web_%' THEN 'web' ELSE 'telegram' END AS canal
        FROM clientes c
        LEFT JOIN usuarios u
            ON u.id::text = REPLACE(c.identificador_externo, 'web_', '')
        WHERE c.id_cliente = $1
        LIMIT 1
    `, [idCliente]);

    if (!rows.length) return null;
    const plan = await resolveClientPlan(Number(idCliente));
    return { ...rows[0], plan };
}

// ─────────────────────────────────────────────
// ASESORES — CRUD
// ─────────────────────────────────────────────
export async function getAsesoresDB() {
    const { rows } = await db.execute(`
        SELECT id, nombre, username, email, cedula, telefono, rol
        FROM usuarios
        WHERE rol = 'asesor'
        ORDER BY nombre ASC
    `);
    return rows;
}

export async function updateAsesorDB(id, { email, password, cedula, telefono }) {
    let hash = null;
    if (password) hash = await bcrypt.hash(password, 12);

    await db.execute(`
        UPDATE usuarios SET
            email         = COALESCE($1, email),
            password_hash = COALESCE($2, password_hash),
            cedula        = COALESCE($3, cedula),
            telefono      = COALESCE($4, telefono)
        WHERE id = $5
    `, [email || null, hash, cedula || null, telefono || null, id]);
}

export async function checkExistingUserDB(username, email) {
    const { rows } = await db.execute(
        'SELECT id FROM usuarios WHERE username = $1 OR email = $2 LIMIT 1',
        [username, email]
    );
    return rows.length > 0;
}

export async function createAsesorDB({ nombre, username, email, password, cedula, telefono }) {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.execute(
        `INSERT INTO usuarios (nombre, username, email, password_hash, cedula, telefono, rol)
         VALUES ($1, $2, $3, $4, $5, $6, 'asesor') RETURNING id, nombre, username, email`,
        [nombre, username, email, hash, cedula || null, telefono || null]
    );
    return rows[0];
}

export async function deleteAsesorDB(id) {
    await db.execute('UPDATE sesiones SET id_asesor = NULL WHERE id_asesor = $1', [id]);
    await db.execute('UPDATE clientes SET id_asesor = NULL WHERE id_asesor = $1', [id]);
    const { rowCount } = await db.execute('DELETE FROM usuarios WHERE id = $1 AND rol = $2', [id, 'asesor']);
    return rowCount;
}

// ─────────────────────────────────────────────
// ASIGNACIÓN DE CLIENTES A ASESORES
// ─────────────────────────────────────────────
export async function getAsesoresConClientesDB() {
    const { rows } = await db.execute(`
        SELECT a.id_asesor, a.nombre, a.email, a.especialidad, a.activo,
               COUNT(c.id_cliente)::int AS clientes_count
        FROM asesores a
        LEFT JOIN clientes c ON c.id_asesor = a.id_asesor
        WHERE a.activo = true
        GROUP BY a.id_asesor
        ORDER BY a.nombre ASC
    `);
    return rows;
}

export async function getAsesorClientesDB(idAsesor) {
    const { rows } = await db.execute(`
        SELECT c.id_cliente, c.nombre,
               u.email, u.username, u.cedula
        FROM clientes c
        LEFT JOIN usuarios u ON u.id::text = REPLACE(c.identificador_externo, 'web_', '')
        WHERE c.id_asesor = $1
        ORDER BY c.nombre ASC
    `, [idAsesor]);
    return rows;
}

export async function checkAsesorCapacidadDB(idAsesor) {
    const { rows } = await db.execute(
        'SELECT COUNT(*)::int AS cnt FROM clientes WHERE id_asesor = $1',
        [idAsesor]
    );
    return rows[0].cnt;
}

export async function assignClienteToAsesorDB(idCliente, idAsesor) {
    await db.execute(
        'UPDATE clientes SET id_asesor = $1 WHERE id_cliente = $2',
        [idAsesor || null, idCliente]
    );
}

export async function getAllClientesDB() {
    const { rows } = await db.execute(`
        SELECT c.id_cliente, c.nombre, c.identificador_externo, c.id_asesor,
               u.email, u.username, u.cedula
        FROM clientes c
        LEFT JOIN usuarios u ON u.id::text = REPLACE(c.identificador_externo, 'web_', '')
        ORDER BY c.nombre ASC
    `);
    return rows;
}
