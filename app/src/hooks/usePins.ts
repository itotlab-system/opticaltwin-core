import { useEffect, useState } from "react";
import { api } from "../api";
import type { PinAnnotation } from "../types";

// Discussion pins on the bench, stored per project through api.updatePins.

/** Colours offered for a new pin. */
export const PIN_COLOR_OPTIONS = [
  { label: "Blue", value: "#4c8dff" },
  { label: "Red", value: "#e5534b" },
  { label: "Green", value: "#2ea043" },
] as const;

export type PinEditorState = {
  mode: "create" | "edit";
  pin: PinAnnotation;
  value: string;
};

function createPinId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function usePins({
  current,
  editorName,
  setSelection,
}: {
  current: string | null;
  editorName: string;
  setSelection: (names: string[]) => void;
}) {
  const [pins, setPins] = useState<PinAnnotation[]>([]);
  // When true, clicking the breadboard creates a new pin.
  const [pinMode, setPinMode] = useState(false);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  // The name shown on newly created pins. It starts as the name edits are
  // recorded under, and follows it when that changes.
  const [pinUserName, setPinUserName] = useState(editorName);
  useEffect(() => setPinUserName(editorName), [editorName]);
  const [pinColor, setPinColor] = useState<string>(PIN_COLOR_OPTIONS[0].value);
  const [pinEditor, setPinEditor] = useState<PinEditorState | null>(null);

  async function savePins(nextPins: PinAnnotation[]) {
    if (!current) return;
    await api.updatePins(current, nextPins);
  }

  async function handleAddPinAt(x: number, y: number, z: number) {
    const authorName = pinUserName.trim();

    if (!authorName) {
      window.alert("Please enter your name before placing a pin.");
      return;
    }

    const newPin: PinAnnotation = {
      id: createPinId(),
      label: "New pin",
      x,
      y,
      z,
      authorName,
      color: pinColor,
      size: 1,
      createdAt: new Date().toISOString(),
    };

    setSelection([]);
    setPinMode(false);
    setPinEditor({ mode: "create", pin: newPin, value: newPin.label });
  }

  async function handleDeletePin(id: string) {
    const ok = window.confirm("Delete this pin?");
    if (!ok) return;

    const nextPins = pins.filter((pin) => pin.id !== id);
    setPins(nextPins);
    setSelectedPinId(null);
    await savePins(nextPins);
  }

  async function handleMovePin(id: string, x: number, y: number, z: number) {
    const nextPins = pins.map((pin) => pin.id === id ? { ...pin, x, y, z } : pin);
    setPins(nextPins);
    await savePins(nextPins);
  }

  function handleEditPin(id: string) {
    const pin = pins.find((item) => item.id === id);
    if (!pin) return;

    setPinEditor({ mode: "edit", pin, value: pin.label });
  }

  async function savePinEditor() {
    if (!pinEditor) return;

    const updatedPin = { ...pinEditor.pin, label: pinEditor.value };
    const nextPins = pinEditor.mode === "create"
      ? [...pins, updatedPin]
      : pins.map((item) => item.id === updatedPin.id ? updatedPin : item);
    setPins(nextPins);
    setSelectedPinId(updatedPin.id);
    setPinEditor(null);
    await savePins(nextPins);
  }

  return {
    pins, setPins,
    pinMode, setPinMode,
    selectedPinId, setSelectedPinId,
    pinUserName, setPinUserName,
    pinColor, setPinColor,
    pinEditor, setPinEditor,
    handleAddPinAt, handleDeletePin, handleMovePin, handleEditPin, savePinEditor,
  };
}
