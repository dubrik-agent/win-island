/**
 * Shared vocabulary.
 *
 * Widgets keep their own wording (a timer talks differently from a shelf), but
 * words that appear in several places live here so the app never says
 * «Удалить» in one panel and «Убрать» in the next. Anything used by exactly one
 * widget stays in that widget's file.
 */

/** Buttons and menu items. */
export const BUTTON = {
  delete: "Удалить",
  cancel: "Отмена",
  add: "Добавить",
  done: "Готово",
  clear: "Очистить",
  save: "Сохранить",
  today: "Сегодня",
} as const;

/** Small pieces of copy repeated in empty states and tooltips. */
export const TEXT = {
  untitled: "Без названия",
  empty: "Пусто",
} as const;

/** Hotkey recorder and the settings that use it. */
export const HOTKEY = {
  pressCombo: "Нажмите сочетание…",
  needModifier: "нужен модификатор: Ctrl, Alt, Shift или Win",
  busy: "занята другой программой",
  checking: "проверяем…",
  escCancel: "Esc — отмена",
} as const;

/**
 * Russian plural form for `count`.
 * `plural(2, "строка", "строки", "строк")` → `"строки"`.
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
