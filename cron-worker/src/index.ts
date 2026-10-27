// Keep-alive and staff-digest trigger (ADR 0001 rev 3; SEC-019). No secrets, no business logic: the app runs the
// digest itself after answering GET /api/health, at most once per 5 minutes whoever calls.
interface Env {
  HEALTH_URL: string;
}

const worker = {
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const res = await fetch(env.HEALTH_URL, { headers: { "User-Agent": "cafe-cron/1" } });
    if (!res.ok) throw new Error(`health check failed: ${res.status}`);
    // The app answers 200 even when the database is down; surface that in the cron logs.
    const body = (await res.json()) as { ok?: boolean; data?: { db?: string } };
    if (body.data?.db !== "up") throw new Error("health check: database is down");
  },
};

export default worker;
