// src/controllers/manager.controller.js
import {
    getDashboardDB,
    getPlanesDB,
    updatePlanDB,
    createPlanDB,
    getClientProfileByIdDB,
    getAsesoresDB,
    updateAsesorDB,
    checkExistingUserDB,
    createAsesorDB,
    deleteAsesorDB,
    getAsesoresConClientesDB,
    getAsesorClientesDB,
    checkAsesorCapacidadDB,
    assignClienteToAsesorDB,
    getAllClientesDB,
} from '../models/manager.model.js';

/**
 * GET /api/manager/dashboard
 * Panel del gerente: métricas, clientes, planes, empleados.
 */
export const getDashboardData = async (req, res) => {
    try {
        const {
            financiero,
            planesMasContratados,
            planesBase,
            empleados,
            clientesDeudas,
            clientesRegistrados,
            nuevasContrataciones,
        } = await getDashboardDB();

        return res.json({
            financiero,
            planes: planesMasContratados,
            planesCatalogo: planesBase.map(p => ({
                id_plan: p.id_plan,
                nombre: p.nombre,
                categoria: p.categoria,
                precio: Number(p.precio),
                activo: p.activo,
            })),
            empleados,
            clientesConDeudas: clientesDeudas,
            clientesRegistrados,
            nuevasContrataciones: nuevasContrataciones.map(r => ({
                dia: r.dia,
                nuevas_contrataciones: Number(r.nuevas_contrataciones),
            })),
        });
    } catch (error) {
        console.error('[manager] getDashboardData:', error);
        return res.status(500).json({ message: 'Error interno obteniendo la data del panel.' });
    }
};

/**
 * GET /api/manager/planes
 */
export const getPlanes = async (_req, res) => {
    try {
        const rows = await getPlanesDB();
        return res.json({
            planes: rows.map(p => ({
                id_plan: p.id_plan,
                nombre: p.nombre,
                categoria: p.categoria,
                precio: Number(p.precio),
                activo: p.activo,
            }))
        });
    } catch (error) {
        console.error('[manager] getPlanes:', error);
        return res.status(500).json({ message: 'Error obteniendo planes.' });
    }
};

/**
 * PUT /api/manager/planes/:idPlan
 */
export const updatePlanPrecio = async (req, res) => {
    try {
        const { idPlan } = req.params;
        const { precio, activo, nombre, categoria } = req.body;

        if (precio != null && Number.isNaN(Number(precio))) {
            return res.status(400).json({ message: 'Precio inválido.' });
        }

        const plan = await updatePlanDB(idPlan, { precio, activo, nombre, categoria });
        if (!plan) return res.status(404).json({ message: 'Plan no encontrado.' });

        return res.json({
            id_plan: plan.id_plan,
            nombre: plan.nombre,
            categoria: plan.categoria,
            precio: Number(plan.precio),
            activo: plan.activo,
        });
    } catch (error) {
        console.error('[manager] updatePlanPrecio:', error);
        return res.status(500).json({ message: 'Error actualizando plan.' });
    }
};

/**
 * POST /api/manager/planes
 */
export const createPlan = async (req, res) => {
    try {
        const { nombre, categoria, precio, activo } = req.body;
        if (!nombre || precio == null) {
            return res.status(400).json({ message: 'nombre y precio son requeridos.' });
        }

        const plan = await createPlanDB({ nombre, categoria, precio, activo });
        return res.status(201).json(plan);
    } catch (error) {
        console.error('[manager] createPlan:', error);
        return res.status(500).json({ message: 'Error creando plan.' });
    }
};

/**
 * GET /api/manager/client/:idCliente/profile
 */
export const getClientProfileById = async (req, res) => {
    try {
        const profile = await getClientProfileByIdDB(req.params.idCliente);
        if (!profile) return res.status(404).json({ message: 'Cliente no encontrado.' });

        return res.json({
            profile: {
                id_usuario: profile.id_usuario,
                nombre: profile.nombre || profile.nombre_cliente,
                username: profile.username,
                email: profile.email,
                cedula: profile.cedula,
                telefono: profile.telefono,
                canal: profile.canal,
                identificador_externo: profile.identificador_externo,
                plan: profile.plan,
            }
        });
    } catch (error) {
        console.error('[manager] getClientProfileById:', error);
        return res.status(500).json({ message: 'Error obteniendo perfil del cliente.' });
    }
};

// ─────────────────────────────────────────────
// ASESORES — CRUD
// ─────────────────────────────────────────────

/** GET /api/manager/asesores */
export const getAsesores = async (req, res) => {
    try {
        const asesores = await getAsesoresDB();
        return res.json({ asesores });
    } catch (error) {
        console.error('[manager] getAsesores:', error);
        return res.status(500).json({ message: 'Error obteniendo asesores.' });
    }
};

/** PUT /api/manager/asesores/:id */
export const updateAsesor = async (req, res) => {
    try {
        const { id } = req.params;
        const { email, password, cedula, telefono } = req.body;

        if (!email && !password && cedula === undefined && telefono === undefined) {
            return res.status(400).json({ message: 'Debes enviar al menos un campo a actualizar.' });
        }

        await updateAsesorDB(id, { email, password, cedula, telefono });
        return res.json({ message: 'Asesor actualizado.' });
    } catch (error) {
        console.error('[manager] updateAsesor:', error);
        return res.status(500).json({ message: 'Error actualizando asesor.' });
    }
};

/** POST /api/manager/asesores */
export const createAsesor = async (req, res) => {
    try {
        const { nombre, username, email, password, cedula, telefono } = req.body;

        if (!nombre || !username || !email || !password) {
            return res.status(400).json({ message: 'nombre, username, email y password son requeridos.' });
        }

        const exists = await checkExistingUserDB(username, email);
        if (exists) return res.status(409).json({ message: 'El username o email ya está en uso.' });

        const asesor = await createAsesorDB({ nombre, username, email, password, cedula, telefono });
        return res.status(201).json({ asesor });
    } catch (error) {
        console.error('[manager] createAsesor:', error);
        return res.status(500).json({ message: 'Error creando asesor.' });
    }
};

/** DELETE /api/manager/asesores/:id */
export const deleteAsesor = async (req, res) => {
    try {
        const rowCount = await deleteAsesorDB(req.params.id);
        if (!rowCount) return res.status(404).json({ message: 'Asesor no encontrado.' });
        return res.json({ message: 'Asesor eliminado.' });
    } catch (error) {
        console.error('[manager] deleteAsesor:', error);
        return res.status(500).json({ message: 'Error eliminando asesor.' });
    }
};

// ─────────────────────────────────────────────
// ASIGNACIÓN DE CLIENTES A ASESORES
// ─────────────────────────────────────────────

/** GET /api/manager/asesores-con-clientes */
export const getAsesoresConClientes = async (req, res) => {
    try {
        const asesores = await getAsesoresConClientesDB();
        return res.json({ asesores });
    } catch (error) {
        console.error('[manager] getAsesoresConClientes:', error);
        return res.status(500).json({ message: 'Error obteniendo asesores.' });
    }
};

/** GET /api/manager/asesores/:idAsesor/clientes */
export const getAsesorClientes = async (req, res) => {
    try {
        const clientes = await getAsesorClientesDB(req.params.idAsesor);
        return res.json({ clientes });
    } catch (error) {
        console.error('[manager] getAsesorClientes:', error);
        return res.status(500).json({ message: 'Error obteniendo clientes del asesor.' });
    }
};

/** PUT /api/manager/clientes/:idCliente/asesor */
export const assignClienteToAsesor = async (req, res) => {
    try {
        const { idCliente } = req.params;
        const { id_asesor } = req.body;

        if (id_asesor !== null && id_asesor !== undefined) {
            const count = await checkAsesorCapacidadDB(id_asesor);
            if (count >= 5) {
                return res.status(409).json({ message: 'Este asesor ya tiene 5 clientes asignados (límite máximo).' });
            }
        }

        await assignClienteToAsesorDB(idCliente, id_asesor);
        return res.json({ message: id_asesor ? 'Cliente asignado al asesor.' : 'Cliente desasignado.' });
    } catch (error) {
        console.error('[manager] assignClienteToAsesor:', error);
        return res.status(500).json({ message: 'Error asignando cliente.' });
    }
};

/** GET /api/manager/clientes */
export const getAllClientes = async (req, res) => {
    try {
        const clientes = await getAllClientesDB();
        return res.json({ clientes });
    } catch (error) {
        console.error('[manager] getAllClientes:', error);
        return res.status(500).json({ message: 'Error obteniendo clientes.' });
    }
};
