import { API_SPECS } from './api-specs';
import { UI_SPECS } from './ui-specs';

export type { Kind, Spec } from './spec-kit';

/** Every route the controller mounts, classified. A route missing here fails the matrix. */
export const SPECS = [...API_SPECS, ...UI_SPECS];
