import { useRef, useState } from "react";

// One shared "please wait" for actions that can take a while (opening a bench,
// switching to Detailed, undo/redo in Detailed). The indicator appears only
// after `delayMs`, so a fast action never flashes it — most edits answer in
// well under that. `busy` is set at once, though, so controls that must not be
// pressed twice can disable themselves immediately.
export function useBusy(delayMs = 300) {
  const [busy, setBusy] = useState<string | null>(null);
  const [busyVisible, setBusyVisible] = useState(false);
  const depth = useRef(0);
  const timer = useRef<number | null>(null);

  async function runBusy<T>(label: string, work: () => Promise<T>): Promise<T> {
    depth.current += 1;
    setBusy(label);
    if (timer.current === null) {
      timer.current = window.setTimeout(() => setBusyVisible(true), delayMs);
    }
    try {
      return await work();
    } finally {
      depth.current -= 1;
      // Overlapping actions share one indicator; it goes when the last ends.
      if (depth.current === 0) {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
        setBusyVisible(false);
        setBusy(null);
      }
    }
  }

  return { busy, busyVisible, runBusy };
}
