export const config = {
  runtime: "nodejs",
};

const checkDatabaseConnection = async () => {
  const databaseUrl = process.env.DATABASE_URL || "";
  const rawProvider = process.env.DATABASE_PROVIDER || "";
  const isVercelRuntime = process.env.VERCEL === "1";
  const isLocalhostDatabaseUrl = /localhost|127\.0\.0\.1/.test(databaseUrl);

  if (!databaseUrl) {
    return {
      databaseConfigured: false,
      databaseConnected: false,
      databaseProvider: rawProvider || "",
      databaseError: "DATABASE_URL is not configured.",
    };
  }

  if (isVercelRuntime && isLocalhostDatabaseUrl) {
    return {
      databaseConfigured: true,
      databaseConnected: false,
      databaseProvider: rawProvider || "postgres",
      databaseError: "DATABASE_URL points to localhost, which Vercel cannot reach.",
    };
  }

  const { Pool } = await import("pg");
  // Keep this health check aligned with api/_db.ts. pg-connection-string can
  // interpret sslmode=require as verify-full, which fails for Supabase pooler.
  const cleanUrl = databaseUrl.replace(/([?&])sslmode=[^&]*/i, "$1").replace(/[?&]$/, "");
  const pool = new Pool({
    connectionString: cleanUrl,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  });

  try {
    await pool.query("SELECT 1");
    return {
      databaseConfigured: true,
      databaseConnected: true,
      databaseProvider: rawProvider || "postgres",
    };
  } catch (error: any) {
    return {
      databaseConfigured: true,
      databaseConnected: false,
      databaseProvider: rawProvider || "postgres",
      databaseError: error?.code || error?.message || "Connection failed",
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
};

export default async function handler(_req: any, res: any) {
  const databaseStatus = await checkDatabaseConnection();

  res.status(200).json({
    ok: true,
    runtime: "vercel",
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    ...databaseStatus,
    timestamp: new Date().toISOString(),
  });
}
