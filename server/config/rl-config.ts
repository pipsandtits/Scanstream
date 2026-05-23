/**
 * RL Agent default runtime-config
 * Can be imported by services and overridden at runtime via admin endpoints
 */
// Lightweight config type to avoid circular imports with the agent
export interface RLConfig {
  sourceWeightPresets?: { scannerWeight: number; mlWeight: number; rlWeight: number }[];
}

export const RL_DEFAULT_CONFIG: RLConfig = {
  sourceWeightPresets: [
    { scannerWeight: 0.40, mlWeight: 0.35, rlWeight: 0.25 }, // Default balanced
    { scannerWeight: 0.50, mlWeight: 0.30, rlWeight: 0.20 }, // Scanner heavy
    { scannerWeight: 0.30, mlWeight: 0.45, rlWeight: 0.25 }, // ML heavy
    { scannerWeight: 0.30, mlWeight: 0.30, rlWeight: 0.40 }, // RL heavy
    { scannerWeight: 0.33, mlWeight: 0.33, rlWeight: 0.34 }, // Equal weight
    { scannerWeight: 0.20, mlWeight: 0.50, rlWeight: 0.30 }, // Volatile preset (ML dominant)
    { scannerWeight: 0.45, mlWeight: 0.35, rlWeight: 0.20 }, // Trending preset (Scanner dominant)
  ]
};

export default RL_DEFAULT_CONFIG;
