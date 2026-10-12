/**
 * Which reference topics illustrate an equipment item or a production stage. The registry picks the
 * clips; this map only says what a clip must show to be relevant. Utilities, offices and support
 * buildings have no topic: no video is better than an unrelated one.
 */
import type { MonitoredStageId } from '../model/types';
import type { VideoTopic } from './types';

export const TOPIC_LABEL: Record<VideoTopic, string> = {
  'raw-materials': 'Raw materials',
  milling: 'Milling & slip',
  'spray-drying': 'Spray drying',
  pressing: 'Pressing',
  drying: 'Drying',
  glazing: 'Glazing',
  decoration: 'Digital decoration',
  'kiln-camera': 'Kiln camera (recorded)',
  'kiln-infeed': 'Kiln infeed',
  'kiln-exterior': 'Kiln exterior',
  'kiln-firing': 'Firing',
  'kiln-discharge': 'Kiln discharge',
  'tile-factory-overview': 'Process overview',
  sorting: 'Sorting',
  'surface-inspection': 'Surface inspection',
  'crack-chip-inspection': 'Crack & chip inspection',
  'glaze-defect-inspection': 'Glaze defect inspection',
  'dimensional-inspection': 'Dimensional inspection',
  packaging: 'Packaging',
  palletising: 'Palletising',
  'warehouse-forklift': 'Forklifts',
  'internal-transport': 'Internal transport',
  'truck-loading': 'Truck loading',
  'yard-movement': 'Yard movement',
  'dock-operations': 'Dock operations',
};

/** Topics per equipment item, most specific first. */
export const EQUIPMENT_TOPICS: Record<string, VideoTopic[]> = {
  'B-RCV': ['raw-materials'],
  'B-BAYS': ['raw-materials'],
  'B-LOAD': ['raw-materials'],
  'B-FEED': ['raw-materials'],
  'B-SILO': ['raw-materials'],
  'C-CRS': ['milling', 'raw-materials'],
  'C-BM1': ['milling'],
  'C-BM2': ['milling'],
  'C-BM3': ['milling'],
  'C-SLIP': ['milling'],
  'D-HAG': ['spray-drying'],
  'D-TWR': ['spray-drying'],
  'D-CYC': ['spray-drying'],
  'D-SILO': ['spray-drying'],
  'D-BELT': ['spray-drying', 'pressing'],
  'E-PRS1': ['pressing'],
  'E-PRS2': ['pressing'],
  'E-PRS3': ['pressing'],
  'E-COL': ['pressing'],
  'F-DRY': ['drying'],
  'F-BUF': ['drying'],
  'G-PREP': ['glazing'],
  'G-LINE': ['glazing'],
  'G-INK': ['decoration', 'glazing'],
  'CV-GLZ': ['glazing'],
  // The kiln has distinct phases; each has its own footage and label.
  // The recorded kiln camera first; the public clips keep their own phases.
  'H-KILN': ['kiln-camera', 'kiln-firing', 'kiln-infeed', 'kiln-exterior', 'kiln-discharge'],
  'CV-KIN': ['kiln-infeed'],
  'A-STK': ['kiln-exterior'],
  'I-GAUGE': ['dimensional-inspection', 'sorting'],
  'I-VIS': ['surface-inspection', 'crack-chip-inspection', 'glaze-defect-inspection'],
  'I-SORT': ['sorting'],
  'CV-SORT': ['sorting'],
  'I-QC': ['crack-chip-inspection', 'surface-inspection'],
  'I-BUF': ['sorting'],
  'J-CNT': ['packaging'],
  'J-BOX': ['packaging'],
  'CV-PACK': ['packaging'],
  'J-PAL': ['palletising'],
  'J-WRAP': ['palletising'],
  'CV-PAL': ['palletising'],
  'K-RACK': ['warehouse-forklift'],
  'K-FLT': ['warehouse-forklift'],
  'K-STG': ['internal-transport', 'warehouse-forklift'],
  'K-DOCK': ['dock-operations', 'truck-loading'],
  'A-GATE': ['yard-movement'],
  'A-HOLD': ['yard-movement'],
};

/** Topics per production stage (monitored stages and the process stages they group), in process order. */
export const STAGE_TOPICS: Record<MonitoredStageId, VideoTopic[]> = {
  PREP: ['raw-materials', 'milling'],
  SPRAY: ['spray-drying'],
  PRESS: ['pressing'],
  DRY: ['drying'],
  GLAZE: ['glazing', 'decoration'],
  DECOR: ['decoration'],
  KILN: ['kiln-camera', 'kiln-infeed', 'kiln-firing', 'kiln-exterior', 'kiln-discharge'],
  SORT: ['sorting', 'surface-inspection', 'dimensional-inspection'],
  PACK: ['packaging', 'palletising'],
  PAL: ['palletising'],
  WH: ['warehouse-forklift', 'internal-transport'],
};
