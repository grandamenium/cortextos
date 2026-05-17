export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initializeSchema } = await import('./lib/db');
    await initializeSchema().catch((err) => {
      console.error('[instrumentation] Schema init failed:', err);
    });
  }
}
