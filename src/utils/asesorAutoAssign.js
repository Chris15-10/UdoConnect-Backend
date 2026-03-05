// src/utils/asesorAutoAssign.js
// ─────────────────────────────────────────────────────────────────
// Helper: elige automáticamente el asesor disponible con menos
// sesiones activas. Límite: MAX_SESIONES_SIMULTANEAS por asesor.
// ─────────────────────────────────────────────────────────────────
import { db } from '../db.js';

export const MAX_SESIONES_SIMULTANEAS = 5;

/**
 * Devuelve el id del asesor con menos sesiones activas (< 5).
 * Si todos están llenos o no hay asesores, devuelve null.
 * @param {object} [clientTx] - opcional: cliente pg de transacción
 */
export async function getAvailableAsesor(clientTx = null) {
    try {
        const execute = (sql, params) =>
            clientTx
                ? clientTx.query(sql, params)
                : db.execute(sql, params);

        const { rows } = await execute(`
            SELECT u.id,
                   COUNT(s.id_sesion) FILTER (
                       WHERE s.estado IN ('activa', 'activa_bot')
                   )::int AS sesiones_activas
            FROM usuarios u
            LEFT JOIN sesiones s ON s.id_asesor = u.id
            WHERE u.rol = 'asesor'
            GROUP BY u.id
            HAVING COUNT(s.id_sesion) FILTER (
                       WHERE s.estado IN ('activa', 'activa_bot')
                   ) < $1
            ORDER BY sesiones_activas ASC
            LIMIT 1
        `, [MAX_SESIONES_SIMULTANEAS]);

        return rows.length ? rows[0].id : null;
    } catch (e) {
        console.error('[getAvailableAsesor]', e.message);
        return null;
    }
}
