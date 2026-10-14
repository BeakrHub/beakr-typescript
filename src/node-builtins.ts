/**
 * Load a Node built-in at run time, invisibly to browser bundlers.
 *
 * Node-only helpers (directories, files on disk, streaming hashes) must not
 * stop the SDK from bundling for a browser or an edge runtime. A literal
 * ``import("node:fs")`` is resolved by bundlers even when it is dynamic, so
 * this uses ``process.getBuiltinModule`` (Node 20.16+, 22.3+) and, on older
 * Node, a dynamic import whose specifier is not a literal.
 */
export async function nodeBuiltin<T>(id: string): Promise<T> {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const loaded = proc?.getBuiltinModule?.(id);
  if (loaded) return loaded as T;
  const specifier: string = id;
  return (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as T;
}

/** Built-ins loaded by `preloadNodeBuiltins`, for synchronous callers on older Node. */
const preloaded = new Map<string, unknown>();

/** Whether this is Node.js (or a runtime that implements its `process`, such as Bun or Deno). */
export function isNodeRuntime(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: unknown } } }).process;
  return typeof proc?.versions?.node === "string";
}

/**
 * A Node built-in for synchronous code, or undefined when it is not available
 * yet: `process.getBuiltinModule` where it exists, else a module a previous
 * `preloadNodeBuiltins` loaded (the only way on Node 18 and 20 before 20.16,
 * whose ES modules cannot load a built-in synchronously).
 */
export function nodeBuiltinSync<T>(id: string): T | undefined {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  try {
    const loaded = proc?.getBuiltinModule?.(id);
    if (loaded) return loaded as T;
  } catch {
    // Fall through to a preloaded copy.
  }
  return preloaded.get(id) as T | undefined;
}

/**
 * Load built-ins once so `nodeBuiltinSync` finds them on Node without
 * `getBuiltinModule`. Outside Node this does nothing, and a built-in the
 * runtime refuses is skipped.
 */
export async function preloadNodeBuiltins(ids: readonly string[]): Promise<void> {
  if (!isNodeRuntime()) return;
  for (const id of ids) {
    if (nodeBuiltinSync(id) !== undefined) continue;
    try {
      preloaded.set(id, await nodeBuiltin(id));
    } catch {
      // No such built-in here; synchronous readers find nothing and move on.
    }
  }
}
