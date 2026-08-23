# Decisions log

One entry per choice made over an alternative, with the why. This log becomes
most of the handover documentation. Newest entries at the bottom.

## Session 1 — scaffold and WASM boundary (2026-08-23)

- **Hand-written scaffold over `npm create vite`.** Every file in the repo is
  one the developer has read; a generator drops in files nobody audits.
- **All npm versions pinned exact** (`.npmrc` with `save-exact`), lockfiles
  committed. Integrity pinning comes from the SHA-512 hashes in
  `package-lock.json` and the checksums in `Cargo.lock`.
- **TypeScript 5.9.3, not 7.x.** The Go-native 7.0 compiler shipped weeks
  before this session. This project wants battle-tested, not new.
- **`Math.random` ban via ESLint core rules** (`no-restricted-properties` +
  `no-restricted-syntax`), no plugin dependency. Covers dot access, literal
  and computed bracket access (all computed access to `Math` is banned as an
  evasion vector), and destructuring. Verified by linting a canary file
  containing each form and seeing each flagged. Known limit: aliasing
  (`const M = Math; M.random()`) is beyond static linting and is a
  code-review responsibility.
- **No jsdom / testing-library / prettier / husky.** Each is attack surface;
  none is needed yet. Ask before adding when UI testing becomes real.
- **`@types/react` and `@types/react-dom` added** (dev-only, types-only —
  no runtime or build-time code executes from them). TSX cannot typecheck
  without them. A hand-written 4-line shim (`src/node-fs-shim.d.ts`) covers
  the single `node:fs` call in the boundary test instead of adding
  `@types/node`.
- **wasm-pack installed via `cargo install --locked` from crates.io source**,
  not the npm-distributed prebuilt binary. Slower once, better provenance.
- **`wasm-opt` disabled** in `core/Cargo.toml`. wasm-pack downloads it as an
  unpinned prebuilt binary from GitHub releases at build time; nothing today
  justifies that in the build path. Re-evaluate, pinned, if APK size matters.
- **No Vite WASM plugin.** `wasm-pack --target web` output is plain ESM plus a
  `.wasm` asset; the browser initialises it via a `?url` import Vite handles
  natively, and the Vitest test hands the same init function raw bytes read
  off disk. Zero glue dependencies. Rejected: `vite-plugin-wasm-pack` and
  similar third-party wrappers.
- **`core/pkg/` (generated WASM artifacts) gitignored.** The adversary audits
  Rust source and rebuilds with `npm run build:wasm`; compiled artifacts in
  the repo are unauditable bytes.
- **Boundary proof is a string round trip** (`round_trip` reverses a string):
  strings exercise wasm-bindgen's allocation/encode/decode path, which
  numbers do not. No wallet logic in the core yet, by design.
- **Known dev-only advisory accepted:** `npm audit` reports a moderate issue
  in `uuid` (via `xcode` via `@capacitor/cli`). Dev-time CLI path only,
  nothing ships in the APK. Not "fixed" because the offered fix force-
  downgrades the Capacitor CLI. Revisit when Capacitor publishes a clean
  release.
- **Android SDK note (not a dependency yet):** the NDK/native-core path stays
  cut per PLAN.md. The plain Android SDK + JDK 21 + Gradle are still required
  at step 7 to produce the APK. Neither is installed on this machine yet;
  install before step 7.
