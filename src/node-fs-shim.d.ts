// Minimal declaration for the single node:fs call in the boundary test.
// Written by hand to avoid adding @types/node as a dependency for one function.
declare module "node:fs" {
  export function readFileSync(path: string | URL): Uint8Array;
}
