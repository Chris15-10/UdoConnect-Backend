// src/controllers/auth.controller.js
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { JWT_SECRET } from '../config.js';

/**
 * POST /api/auth/login
 * Body: { username, password }
 */
export const login = async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ message: 'Usuario y contraseña son requeridos.' });
        }

        // Usar $1 directamente (mismo patrón que bot.model.js)
        const { rows } = await db.execute(
            'SELECT id, nombre, username, email, password_hash, rol, activo FROM usuarios WHERE username = $1',
            [username]
        );

        if (rows.length === 0) {
            return res.status(401).json({ message: 'Credenciales incorrectas.' });
        }

        const usuario = rows[0];

        if (!usuario.activo) {
            return res.status(403).json({ message: 'Cuenta desactivada. Contacta al administrador.' });
        }

        const passwordOk = await bcrypt.compare(password, usuario.password_hash);

        if (!passwordOk) {
            return res.status(401).json({ message: 'Credenciales incorrectas.' });
        }

        const token = jwt.sign(
            { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        return res.json({
            token,
            user: {
                id: usuario.id,
                nombre: usuario.nombre,
                username: usuario.username,
                email: usuario.email,
                rol: usuario.rol,
            },
        });

    } catch (error) {
        console.error('[auth.controller] Error en login:', error);
        return res.status(500).json({ message: 'Error interno del servidor.' });
    }
};

export const register = async (req, res) => {
    try {
        const { nombre, username, email, password, rol = 'cliente' } = req.body;

        if (!nombre || !username || !email || !password) {
            return res.status(400).json({ message: 'Todos los campos son requeridos.' });
        }

        const password_hash = await bcrypt.hash(password, 12);

        // Optimización: Eliminado antipatrón Select-Insert-Select.
        // Delegamos al motor de BD la validación de duplicados usando ON CONFLICT DO NOTHING
        // para las restricciones UNIQUE de 'username' y 'email'.
        const { rows: inserted } = await db.execute(
            `INSERT INTO usuarios (nombre, username, email, password_hash, rol)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING
             RETURNING id, nombre, username, email, rol`,
            [nombre, username, email, password_hash, rol]
        );

        if (inserted.length === 0) {
            // Si la base de datos no retornó nada, significa que no insertó por conflicto de UNIQUE
            return res.status(409).json({ message: 'El usuario o email ya existe.' });
        }

        return res.status(201).json({ user: inserted[0] });

    } catch (error) {
        console.error('[auth.controller] Error en register:', error);
        return res.status(500).json({ message: 'Error interno del servidor.' });
    }
};

/**
 * GET /api/auth/me
 * Header: Authorization: Bearer <token>
 */
export const me = async (req, res) => {
    return res.json({ user: req.user });
};
