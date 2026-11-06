import { useState, type Dispatch, type SetStateAction } from "react";
import { api } from "../api";
import { createCalloutId, defaultCalloutText } from "../callouts";
import type { Component, FigureCallout, ProjectData } from "../types";

// Figure callouts (the paper-figure labels). The labels themselves live in
// `data`, not in a state of their own, so that every full payload — a delete,
// an undo, a reload — brings the authoritative list with it. Held separately
// they went stale the moment a labelled part was deleted, and the next drag
// then saved a label pointing at nothing. This hook holds only the UI state
// around them and the edits.
export function useCallouts({
  current,
  callouts,
  components,
  setData,
}: {
  current: string | null;
  callouts: FigureCallout[];
  components: Component[];
  setData: Dispatch<SetStateAction<ProjectData | null>>;
}) {
  // When on, clicking a part labels it instead of selecting it.
  const [calloutMode, setCalloutMode] = useState(false);
  const [selectedCalloutId, setSelectedCalloutId] = useState<string | null>(null);
  // The whole layer on/off, on top of each label's own `hidden` flag. A bench
  // being *arranged* wants the parts unobstructed; the labels are for the
  // figure. What is on screen is what gets exported, so this switches both.
  const [calloutsVisible, setCalloutsVisible] = useState(true);

  async function saveCallouts(next: FigureCallout[]) {
    setData((d) => (d ? { ...d, callouts: next } : d));   // optimistic
    if (!current) return;
    const r = await api.updateCallouts(current, next);
    setData((d) => (
      d ? { ...d, callouts: r.callouts, canUndo: r.canUndo, canRedo: r.canRedo } : d
    ));
  }

  function addCalloutFor(name: string) {
    // One label per part: a second click on an already-labelled part selects
    // the label it has instead of stacking an identical box on top of it.
    const existing = callouts.find((c) => c.target === name);
    if (existing) {
      setSelectedCalloutId(existing.id);
      return;
    }
    const callout: FigureCallout = {
      id: createCalloutId(),
      target: name,
      text: defaultCalloutText(components.find((c) => c.name === name)),
      // Up and to the right of the part, clear of the bench, where a figure
      // usually wants it; the user drags it wherever the picture needs.
      dx: 90,
      // Stepped down for each label already up, so labelling four parts in a
      // row doesn't bury three boxes under the fourth; they are dragged into
      // place afterwards anyway.
      dy: -70 - 30 * (callouts.length % 4),
    };
    void saveCallouts([...callouts, callout]);
    setSelectedCalloutId(callout.id);
  }

  function updateCallout(next: FigureCallout) {
    void saveCallouts(callouts.map((c) => (c.id === next.id ? next : c)));
  }

  function deleteCallout(id: string) {
    setSelectedCalloutId((prev) => (prev === id ? null : prev));
    void saveCallouts(callouts.filter((c) => c.id !== id));
  }

  return {
    calloutMode, setCalloutMode,
    selectedCalloutId, setSelectedCalloutId,
    calloutsVisible, setCalloutsVisible,
    saveCallouts, addCalloutFor, updateCallout, deleteCallout,
  };
}
