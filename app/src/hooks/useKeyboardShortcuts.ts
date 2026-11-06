import { useEffect } from "react";
import type { Clipboard } from "../clipboard";
import type { Component, ComponentGroup, PinAnnotation, ProjectData } from "../types";

type Shortcuts = {
  current: string | null;
  data: ProjectData | null;
  renderMode: "lo" | "hi";
  t: (key: string, vars?: Record<string, string | number>) => string;
  components: Component[];
  groups: ComponentGroup[];
  selection: string[];
  setSelection: (names: string[]) => void;
  enteredGroupId: string | null;
  setEnteredGroupId: (id: string | null) => void;
  clipboard: Clipboard | null;
  isPlacing: boolean;
  setIsPlacing: (on: boolean) => void;
  setStatus: (text: string) => void;
  calloutMode: boolean;
  setCalloutMode: (on: boolean) => void;
  setSelectedCalloutId: (id: string | null) => void;
  selectedPinId: string | null;
  setSelectedPinId: (id: string | null) => void;
  // Read by onDeletePin; listed so the listener is rebuilt when pins change
  // and never deletes from (and saves) an out-of-date list.
  pins: PinAnnotation[];
  onDeletePin: (id: string) => Promise<void>;
  setPinMode: (on: boolean) => void;
  onDelete: () => Promise<void>;
  createGroup: () => Promise<void>;
  ungroup: () => Promise<void>;
  onUndo: () => Promise<void>;
  onRedo: () => Promise<void>;
  onCopy: () => void;
  onPaste: () => Promise<void>;
  onDuplicateSelection: () => Promise<void>;
};

// Editor keyboard shortcuts: Delete, Ctrl+G / Ctrl+Shift+G, undo/redo,
// copy/paste/duplicate, and Escape. The listener is re-attached whenever one of
// the values in the dependency list changes, so the handlers it calls are the
// ones from that render.
export function useKeyboardShortcuts(k: Shortcuts) {
  useEffect(() => {
    if (!k.current) return;

    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      // A selected pin takes Delete before the selected parts do. The same
      // handler as the pin's own Delete button, so the key saves too.
      if ((e.key === "Delete" || e.key === "Backspace") && k.selectedPinId) {
        void k.onDeletePin(k.selectedPinId);
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && k.selection.length > 0) {
        void k.onDelete();
        return;
      }

      // Ctrl/Cmd + G groups the selection, Ctrl/Cmd + Shift + G ungroups it.
      // Both are claimed by the browser's find-again, so stop the default.
      if ((e.ctrlKey || e.metaKey) && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        if (e.shiftKey) void k.ungroup();
        else void k.createGroup();
        return;
      }

      // Ctrl/Cmd + Z rewinds a step, Ctrl/Cmd + Shift + Z (or Ctrl+Y) replays it.
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) void k.onRedo();
        else void k.onUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        void k.onRedo();
        return;
      }

      // Ctrl/Cmd + C / V / D — copy, paste, duplicate the selection.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const key = e.key.toLowerCase();
        // Leave the browser's own copy alone when the user is copying text.
        const textSelected = !(window.getSelection()?.isCollapsed ?? true);
        if (key === "c" && k.selection.length > 0 && !textSelected) {
          e.preventDefault();
          k.onCopy();
          return;
        }
        if (key === "v" && k.clipboard) {
          e.preventDefault();
          void k.onPaste();
          return;
        }
        if (key === "d" && k.selection.length > 0) {
          e.preventDefault();          // Chrome's "bookmark this page"
          void k.onDuplicateSelection();
          return;
        }
      }

      if (e.key === "Escape") {
        if (k.isPlacing) {
          k.setIsPlacing(false);
          k.setStatus(k.t("components_n", { n: k.components.length }));
        } else if (k.calloutMode) {
          // Leaves the labels on screen — Esc ends the labelling mode, it does
          // not undo the figure.
          k.setCalloutMode(false);
          k.setSelectedCalloutId(null);
        } else if (k.enteredGroupId) {
          // Step back out of the group instead of dropping the selection.
          const group = k.groups.find((g) => g.id === k.enteredGroupId);
          k.setEnteredGroupId(null);
          k.setSelection(group ? group.members : []);
        } else {
          k.setSelection([]);
        }
        k.setSelectedPinId(null);
        k.setPinMode(false);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // The same dependency list the effect had inline in App.tsx.
  }, [k.current, k.selection, k.selectedPinId, k.pins, k.t, k.isPlacing, k.components,
      k.renderMode, k.groups, k.enteredGroupId, k.clipboard, k.data, k.calloutMode]);
}
