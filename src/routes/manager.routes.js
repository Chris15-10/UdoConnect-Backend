// src/routes/manager.routes.js
import { Router } from 'express';
import { verifyToken, requireRole } from '../middlewares/auth.middleware.js';
import {
    getDashboardData, getPlanes, updatePlanPrecio, createPlan, getClientProfileById,
    getAsesores, updateAsesor, createAsesor, deleteAsesor,
    getAsesoresConClientes, getAsesorClientes, assignClienteToAsesor, getAllClientes
} from '../controllers/manager.controller.js';

const router = Router();

// Panel gerencial: solo rol admin
router.get('/dashboard', verifyToken, requireRole('admin'), getDashboardData);

// Gestión de planes (listar y actualizar precio)
router.get('/planes', verifyToken, requireRole('admin'), getPlanes);
router.put('/planes/:idPlan', verifyToken, requireRole('admin'), updatePlanPrecio);
router.post('/planes', verifyToken, requireRole('admin'), createPlan);

// Perfil de cliente por id_cliente
router.get('/client/:idCliente/profile', verifyToken, requireRole('admin'), getClientProfileById);

// Gestión de Asesores (tabla usuarios con rol 'asesor')
router.get('/asesores', verifyToken, requireRole('admin'), getAsesores);
router.put('/asesores/:id', verifyToken, requireRole('admin'), updateAsesor);
router.post('/asesores', verifyToken, requireRole('admin'), createAsesor);
router.delete('/asesores/:id', verifyToken, requireRole('admin'), deleteAsesor);

// Asesores de la tabla asesores con conteo/asignación de clientes
router.get('/asesores-con-clientes', verifyToken, requireRole('admin'), getAsesoresConClientes);
router.get('/asesores/:idAsesor/clientes', verifyToken, requireRole('admin'), getAsesorClientes);
router.put('/clientes/:idCliente/asesor', verifyToken, requireRole('admin'), assignClienteToAsesor);
router.get('/clientes', verifyToken, requireRole('admin'), getAllClientes);

export default router;
