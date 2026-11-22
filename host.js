/**
 * Compatibility shim. The package entry points at `host-1.2.0.js` so a live
 * Host reload gets a fresh module URL instead of Node's cached generation.
 * New code belongs in the versioned host file.
 */
export * from './host-1.2.0.js'
