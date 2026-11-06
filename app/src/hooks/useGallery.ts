import { useState } from "react";
import { api } from "../api";
import { readClipboard, writeClipboard } from "../clipboard";
import { moveViewportBg } from "../settings";
import type { LaserOption, NewProjectStart, ProjectSummary, Template } from "../types";

// The project gallery: its list, and the actions on a card.
export function useGallery({
  t,
  current,
  setCurrent,
  openProject,
  openPhotoBuilder,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  current: string | null;
  setCurrent: (name: string | null) => void;
  openProject: (name: string) => void;
  openPhotoBuilder: () => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [laserAssets, setLaserAssets] = useState<LaserOption[]>([]);
  const [defaultBeamHeight, setDefaultBeamHeight] = useState(100);

  async function refreshGallery() {
    const r = await api.listProjects();
    setProjects(r.projects);
    setTemplates(r.templates);
    setLaserAssets(r.lasers ?? []);
    if (r.defaultBeamHeight) setDefaultBeamHeight(r.defaultBeamHeight);
  }

  // `folder` is the gallery tab that was open — a project made while standing
  // in a folder is filed there. Filed before the gallery refreshes, so the card
  // never flashes up unfiled.
  async function createProject(
    name: string, template: string, folder = "", start: NewProjectStart = {},
  ) {
    const r = await api.createProject(name, template, start);
    if (folder) await api.setProjectMeta(r.name, { folder });
    await refreshGallery();
    openProject(r.name);
    if (template === "from_photo") openPhotoBuilder();
  }

  async function deleteProject(name: string) {
    if (!confirm(t("delete_confirm", { name }))) return;
    await api.removeProject(name);
    moveViewportBg(name, null);
    await refreshGallery();
  }

  // Copies the whole setup under <name>_copy — a safe place to try changes.
  async function duplicateProject(name: string) {
    const r = await api.duplicateProject(name);
    // The copy inherits the original's background, like its folder.
    moveViewportBg(name, r.name, true);
    await refreshGallery();
  }

  // Move a project into a folder, or archive it. Filing only — it never
  // touches setup.usda, so a card's "last edited" and its thumbnail stand.
  async function fileProject(
    name: string,
    meta: { folder?: string; archived?: boolean }
  ) {
    await api.setProjectMeta(name, meta);
    await refreshGallery();
  }

  async function renameProject(name: string, newName: string) {
    const r = await api.renameProject(name, newName);
    moveViewportBg(name, r.name);
    await refreshGallery();
    // A pending copy still points at the old folder; follow it across.
    const clip = readClipboard();
    if (clip?.project === name) writeClipboard({ ...clip, project: r.name });
    if (current === name) setCurrent(r.name);
  }

  return {
    projects, templates, laserAssets, defaultBeamHeight,
    refreshGallery, createProject, deleteProject, duplicateProject, fileProject,
    renameProject,
  };
}
