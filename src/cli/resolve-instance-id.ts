export function resolveInstanceId(instance?: string): string {
  return instance || process.env.CTX_INSTANCE_ID || 'default';
}
