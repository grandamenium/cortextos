declare module 'js-yaml' {
  export function load(input: string): unknown;
  export function dump(input: unknown, options?: Record<string, unknown>): string;
  const yaml: { load: typeof load; dump: typeof dump };
  export default yaml;
}
