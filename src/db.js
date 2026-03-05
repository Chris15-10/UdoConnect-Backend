import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

// Creamos el Pool UNA SOLA VEZ fuera de la función de ejecución.
// Esto mantiene las conexiones abiertas y listas para usarse.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,               // Mantiene hasta 10 conexiones listas
  idleTimeoutMillis: 30000, // Mantiene la conexión viva por 30 segundos de inactividad
  connectionTimeoutMillis: 10000, // 10 segundos para tolerar latencia alta (Venezuela → AWS us-east-1)
});

export const db = {
  execute: async (sql, params = []) => {
    // Ya no inicializamos nada aquí, usamos el pool que ya existe arriba.
    let counter = 1;
    const pgSql = sql.replace(/\?/g, () => `$${counter++}`);

    const result = await pool.query(pgSql, params);
    return { rows: result.rows };
  }
};