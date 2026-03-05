import { db } from '../db.js';

async function run() {
    try {
        console.log('Creando tabla planes (si no existe)...');
        await db.execute(`
      CREATE TABLE IF NOT EXISTS planes (
        id_plan    serial PRIMARY KEY,
        nombre     text UNIQUE NOT NULL,
        categoria  text NOT NULL CHECK (categoria IN ('tv','internet','movil')),
        precio     numeric(10,2) NOT NULL,
        activo     boolean NOT NULL DEFAULT true
      );
    `);

        console.log('Agregando columna id_plan a facturas (si no existe)...');
        await db.execute(`
      ALTER TABLE facturas
      ADD COLUMN IF NOT EXISTS id_plan INTEGER REFERENCES planes(id_plan);
    `);

        console.log('Sembrando planes base...');
        await db.execute(`
      INSERT INTO planes (nombre, categoria, precio, activo) VALUES
        ('1. Básico SD',        'tv',       19, true),
        ('2. Estándar HD',      'tv',       35, true),
        ('3. Premium 4K',       'tv',       55, true),
        ('1. Internet Básico',  'internet', 29, true),
        ('2. Internet Rápido',  'internet', 49, true),
        ('3. Internet Ultra',   'internet', 79, true),
        ('1. Móvil Básico',     'movil',    15, true),
        ('2. Móvil Plus',       'movil',    25, true),
        ('3. Móvil Ilimitado',  'movil',    40, true)
      ON CONFLICT (nombre) DO UPDATE
        SET precio = EXCLUDED.precio,
            categoria = EXCLUDED.categoria,
            activo = true;
    `);

        console.log('Tabla planes lista ✅');
    } catch (e) {
        console.error('Error configurando tabla planes:', e);
    } finally {
        process.exit(0);
    }
}

run();
