export interface SpecimenInfo {
  name: string;
  mission: string;
  sampleId: string;
  /** Approximate dimensions of the curated piece in NASA's physical-scale scan. */
  size: string;
}

export const specimenInfo: Record<string, SpecimenInfo> = {
  basalt: {
    name: 'Low-Ti olivine basalt',
    mission: 'Apollo 15',
    sampleId: '15016,0',
    size: '8.4 × 7.4 × 7.0 cm',
  },
  breccia: {
    name: 'Regolith breccia',
    mission: 'Apollo 14',
    sampleId: '14316,0',
    size: '4.0 × 3.0 × 1.7 cm',
  },
  anorthosite: {
    name: 'Ferroan anorthosite',
    mission: 'Apollo 16',
    sampleId: '60025,241',
    size: '6.5 × 5.5 × 4.7 cm',
  },
};
