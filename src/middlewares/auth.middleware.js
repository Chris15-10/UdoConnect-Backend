// src/middlewares/auth.middleware.js
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config.js';

/**
 * Middleware que verifica el JWT enviado en el header:
 * Authorization: Bearer <token>
 *
 * Si es válido, agrega req.user = { id, rol } para que
 * los controllers sepan quién hace la petición.
 */
export const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Token de acceso requerido.' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // { id, nombre, rol, iat, exp }
        next();
    } catch (err) {
        return res.status(403).json({ message: 'Token inválido o expirado.' });
    }
};

/**
 * Middleware de autorización por rol.
 * Uso: requireRole('asesor', 'admin')
 */
export const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ message: 'No autenticado.' });
        }
        if (!roles.includes(req.user.rol)) {
            return res.status(403).json({ message: 'No tienes permiso para acceder a este recurso.' });
        }
        next();
    };
};
