// src/routes/auth.routes.js
import { Router } from 'express';
import { login, register, me } from '../controllers/auth.controller.js';
import { verifyToken } from '../middlewares/auth.middleware.js';

const router = Router();

// POST /api/auth/login    → Iniciar sesión
router.post('/login', login);

// POST /api/auth/register → Crear usuario (usa verifyToken + requireRole('admin') en producción)
router.post('/register', register);

// GET  /api/auth/me       → Verificar token vigente y obtener datos del usuario
router.get('/me', verifyToken, me);

export default router;
