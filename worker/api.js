/**
 * Nuance — adaptation de l'API en module importable.
 * `worker/index.js` contient toute la logique ; ce fichier ne fait que
 * l'exporter pour que `worker.js` puisse router /api/* et le statique.
 */
export { default } from './index.js';
