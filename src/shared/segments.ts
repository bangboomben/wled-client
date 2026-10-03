import type { WledSegment, WledState } from './types';

/** Das Segment, dessen Werte die Oberfläche zeigt: das erste ausgewählte, sonst das Hauptsegment. */
export function viewSeg(state: WledState): WledSegment {
  return state.seg.find((s) => s.sel) ?? state.seg.find((s) => s.id === state.mainseg) ?? state.seg[0];
}
