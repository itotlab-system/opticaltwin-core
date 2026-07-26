export type Lang = "en" | "ja";

type Dict = Record<string, string>;

const en: Dict = {
  tagline: "shared optical-setup layouts — USD is the source of truth",
  gallery_title: "Your optical setups",
  gallery_subtitle: "Pick a project to open in the editor, or start a new one.",
  new_project: "+ New project",
  cancel: "Cancel",
  name_placeholder: "Project name (e.g. team_a_setup)",
  create: "Create",
  creating: "Creating…",
  err_name: "Enter a name",
  err_exists: "A project with that name exists",
  err_create: "Could not create",
  empty_bench: "empty bench",
  components_n: "{n} components",
  no_projects: "No projects yet — create one to start.",
  delete_confirm: 'Delete project "{name}"? This removes its setup.',
  back_projects: "← Projects",
  add_part: "+ Add part",
  loading: "loading…",
  saving: "saving {name}…",
  saved: "saved {name}",
  outliner_title: "Components · beam order",
  outliner_empty: "No components yet.",
  inspector_title: "Inspector",
  inspector_select: "Select a component to edit its position.",
  field_x: "X (mm)",
  field_y: "Y (mm)",
  field_z: "Z (mm)",
  field_rotz: "Rot Z (°)",
  properties: "Properties",
  remove_component: "Remove component",
  remove_confirm: "Remove {name}?",
  distance: "↤ {d} mm from {name}",
  tpl_slm_imaging: "SLM holographic imaging",
  tpl_two_lens: "Two-lens demo bench",
  tpl_blank: "Blank breadboard",
  snapshot: "Snapshot",
  snapshot_saved: "Snapshot saved",
};

const ja: Dict = {
  tagline: "共有の光学セットアップ配置 — USD が真実のソース",
  gallery_title: "光学セットアップ一覧",
  gallery_subtitle: "編集するプロジェクトを選ぶか、新規作成してください。",
  new_project: "＋ 新規プロジェクト",
  cancel: "キャンセル",
  name_placeholder: "プロジェクト名（例: team_a_setup）",
  create: "作成",
  creating: "作成中…",
  err_name: "名前を入力してください",
  err_exists: "同名のプロジェクトが存在します",
  err_create: "作成できませんでした",
  empty_bench: "空のベンチ",
  components_n: "部品 {n} 個",
  no_projects: "プロジェクトがありません — 作成して始めましょう。",
  delete_confirm: "プロジェクト「{name}」を削除しますか？セットアップが削除されます。",
  back_projects: "← プロジェクト一覧",
  add_part: "＋ 部品を追加",
  loading: "読み込み中…",
  saving: "{name} を保存中…",
  saved: "{name} を保存しました",
  outliner_title: "部品 · ビーム順",
  outliner_empty: "部品がありません。",
  inspector_title: "インスペクター",
  inspector_select: "部品を選択すると位置を編集できます。",
  field_x: "X (mm)",
  field_y: "Y (mm)",
  field_z: "Z (mm)",
  field_rotz: "回転 Z (°)",
  properties: "プロパティ",
  remove_component: "部品を削除",
  remove_confirm: "{name} を削除しますか？",
  distance: "↤ {name} から {d} mm",
  tpl_slm_imaging: "SLM ホログラフィック撮像",
  tpl_two_lens: "2 枚レンズ デモ",
  tpl_blank: "空のブレッドボード",
  snapshot: "スナップショット",
  snapshot_saved: "スナップショットを保存しました",
};

export const STRINGS: Record<Lang, Dict> = { en, ja };

export function translate(
  lang: Lang,
  key: string,
  vars?: Record<string, string | number>
): string {
  let s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  if (vars) for (const k in vars) s = s.replace(`{${k}}`, String(vars[k]));
  return s;
}
