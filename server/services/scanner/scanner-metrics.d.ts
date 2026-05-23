declare module './scanner-metrics' {
  export function incRateLimit(labels?: { exchange?: string; symbol?: string }): void;
  export function incChildException(labels?: { exchange?: string; symbol?: string }): void;
  export function incUnhandledRejection(): void;
  export function setActiveTasks(n: number): void;
  export function getRegistry(): any;
  const _default: {
    incRateLimit: typeof incRateLimit,
    incChildException: typeof incChildException,
    incUnhandledRejection: typeof incUnhandledRejection,
    setActiveTasks: typeof setActiveTasks,
    getRegistry: typeof getRegistry,
  };
  export default _default;
}
